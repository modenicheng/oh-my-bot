// Command omb is the authoritative server entrypoint.
package main

import (
	"bufio"
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/ai"
	"github.com/modenicheng/oh-my-bot/server/internal/glue"
	"github.com/modenicheng/oh-my-bot/server/internal/listen"
	"github.com/modenicheng/oh-my-bot/server/internal/netws"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// version 由 release 构建注入：-ldflags '-X main.version=<tag>'；开发构建保持 "dev"。
var version = "dev"

//go:embed all:web
var webFS embed.FS

//go:embed all:manual
var manualFS embed.FS

// webRoot strips the embed "web/" prefix so the site root maps web/ content.
// OMB_WEB_DIR redirects it to a frontend build on disk (client/dist), so the
// dev loop never needs a rebuild to refresh the embed snapshot.
var webRoot = func() fs.FS {
	if dir := os.Getenv("OMB_WEB_DIR"); dir != "" {
		return os.DirFS(dir)
	}
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(err)
	}
	return sub
}()

// manualSource backs /api/manual*: the embed by default, or a directory on
// disk via OMB_MANUAL_DIR (repo docs/manual) so markdown edits show up on
// refresh without a rebuild. manualRoot is the in-FS prefix for each case.
var manualSource, manualRoot = func() (fs.FS, string) {
	if dir := os.Getenv("OMB_MANUAL_DIR"); dir != "" {
		return os.DirFS(dir), "."
	}
	return fs.FS(manualFS), "manual"
}()

// frontendMissingHTML explains an empty embed (fresh checkout without a
// frontend build) instead of serving a blank page.
const frontendMissingHTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>oh-my-bot · 前端未构建</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; line-height: 1.7">
<h1>前端尚未构建</h1>
<p>当前二进制内没有嵌入前端产物（仅含占位文件），API 与 WebSocket 不受影响。</p>
<ul>
<li><b>本地开发</b>：仓库根目录运行 <code>pnpm dev</code>，通过 <code>http://127.0.0.1:5173</code> 访问（前端热重载 + 后端 API 代理）。</li>
<li><b>免重建预览</b>：从 <code>server/</code> 启动时设置 <code>OMB_WEB_DIR=../client/dist</code> 后重启，直接从磁盘读取已构建前端；也可使用绝对路径。</li>
<li><b>完整构建</b>：运行 <code>bash build.sh</code> 将前端重新嵌入单二进制。</li>
</ul>
<p>探活：<code>/healthz</code>；数据接口：<code>/api/matches</code>、<code>/api/manual</code>、<code>/api/replay/&lt;id&gt;</code>。</p>
</body>
</html>
`

// applyGCSettings 应用 gc.* 运行时调优（config.yaml / 环境变量，见
// ai.GCConfig 文档）。必须在第一个房间创建（即第一台 goja VM 分配）之前
// 调用；放在 main 早期保证这一点。解析失败记日志并保留原值——GC 调优
// 失效不应阻止服务器启动。
func applyGCSettings(cfg ai.ServerConfig) {
	if cfg.GC.Percent > 0 {
		p := cfg.GC.Percent
		if p > ai.GCPercentMax {
			p = ai.GCPercentMax
		}
		debug.SetGCPercent(p)
		log.Printf("gc: GOGC=%d (from config)", p)
	}
	if cfg.GC.MemoryLimit != "" {
		if limit, err := parseByteSize(cfg.GC.MemoryLimit); err == nil {
			old := debug.SetMemoryLimit(limit)
			if limit > 0 {
				log.Printf("gc: GOMEMLIMIT=%s (previous soft limit %s)", cfg.GC.MemoryLimit, byteSizeHuman(old))
			}
		} else {
			log.Printf("gc: invalid gc.memory_limit %q: %v (kept default)", cfg.GC.MemoryLimit, err)
		}
	}
}

// parseByteSize 解析 "512MiB"/"1GiB"/"768KB"/"1073741824" 字节量。
// 单位不区分大小写；裸数字按字节。
func parseByteSize(v string) (int64, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0, fmt.Errorf("empty value")
	}
	i := 0
	for i < len(v) && (v[i] >= '0' && v[i] <= '9') {
		i++
	}
	num, err := strconv.ParseInt(v[:i], 10, 64)
	if err != nil {
		return 0, err
	}
	unit := strings.TrimSpace(strings.ToLower(v[i:]))
	switch unit {
	case "", "b":
		return num, nil
	case "k", "kb":
		return num * 1024, nil
	case "kib":
		return num * 1024, nil
	case "m", "mb", "mib":
		return num * 1024 * 1024, nil
	case "g", "gb", "gib":
		return num * 1024 * 1024 * 1024, nil
	default:
		return 0, fmt.Errorf("unknown unit %q", unit)
	}
}

// byteSizeHuman 人类可读字节数（日志用）。
func byteSizeHuman(v int64) string {
	switch {
	case v >= 1<<30:
		return fmt.Sprintf("%.1fGiB", float64(v)/(1<<30))
	case v >= 1<<20:
		return fmt.Sprintf("%.1fMiB", float64(v)/(1<<20))
	case v >= 1<<10:
		return fmt.Sprintf("%.1fKiB", float64(v)/(1<<10))
	case v >= 0:
		return fmt.Sprintf("%dB", v)
	default:
		return "off"
	}
}

func main() {
	addr := flag.String("addr", envAddr(), "listen address: host:port, :port (all interfaces), unix:/path/to.sock, or unix:@name (Linux abstract socket)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	// 版本旗标：打印后立即退出，不初始化 hub、不监听端口。
	if *showVersion {
		fmt.Println(version)
		return
	}

	hub := glue.NewHub()
	serverCfg, cfgErr := ai.LoadServerConfig("")
	if cfgErr != nil {
		log.Printf("AI disabled: configuration error: %v", cfgErr)
	}
	applyGCSettings(serverCfg)
	if cfgErr == nil && serverCfg.AI.Enabled && serverCfg.APIKey != "" {
		manualCorpus := loadAIManualCorpusFS(manualSource, manualRoot)
		hub.SetAIService(func() *glue.AIService {
			return glue.NewAIService(serverCfg, manualCorpus)
		})
		log.Printf("AI enabled: model=%s manual_sections=%d rounds=%d player_tokens=%d global_tokens=%d concurrency=%d",
			serverCfg.AI.Model, len(manualCorpus), serverCfg.Quota.PlayerRounds, serverCfg.Quota.PlayerTokens,
			serverCfg.Quota.GlobalTokens, serverCfg.Quota.MaxConcurrency)
	} else {
		log.Printf("AI disabled: set ai.enabled=true in config.yaml and DEEPSEEK_API_KEY in .env")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	// 只读版本接口：release 构建经 -ldflags '-X main.version=<tag>' 注入，二进制是唯一版本源。
	registerVersionRoute(mux)

	// 回放 API：对局列表 + 单局事件流（JSONL 原样透传，客户端逐行解析）
	mux.HandleFunc("/api/matches", func(w http.ResponseWriter, _ *http.Request) {
		entries, err := os.ReadDir("data/matches")
		if err != nil {
			http.Error(w, "no matches", http.StatusNotFound)
			return
		}
		names := []string{}
		for _, e := range entries {
			if n := e.Name(); strings.HasSuffix(n, ".jsonl") {
				names = append(names, strings.TrimSuffix(n, ".jsonl"))
			}
		}
		sort.Strings(names)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(names)
	})
	// 手册 API：目录树 + 原始 markdown（ADR-0011 客户端阅读器数据源）
	mux.HandleFunc("/api/manual", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(buildManualTreeFS(manualSource, manualRoot))
	})
	mux.HandleFunc("/api/manual/", func(w http.ResponseWriter, r *http.Request) {
		rel := strings.TrimPrefix(r.URL.Path, "/api/manual/")
		// 图片白名单（PNG/WebP）：与 markdown 同前缀，供阅读器内嵌 <img> 使用。
		if strings.HasSuffix(rel, ".png") || strings.HasSuffix(rel, ".webp") {
			serveManualImage(w, r, manualSource, manualRoot)
			return
		}
		if rel == "" || strings.Contains(rel, "..") {
			http.Error(w, "bad path", http.StatusBadRequest)
			return
		}
		if !strings.HasSuffix(rel, ".md") {
			http.Error(w, "bad path", http.StatusBadRequest)
			return
		}
		data, err := fs.ReadFile(manualSource, path.Join(manualRoot, rel))
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		_, _ = w.Write(data)
	})
	mux.HandleFunc("/api/replay/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/api/replay/")
		if id == "" || strings.Contains(id, "/") || strings.Contains(id, "..") {
			http.Error(w, "bad id", http.StatusBadRequest)
			return
		}
		f, err := os.Open(filepath.Join("data/matches", id+".jsonl"))
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		defer func() { _ = f.Close() }()
		info, err := f.Stat()
		if err != nil {
			http.Error(w, "unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("Cache-Control", "no-store")
		// Fix the read boundary while the active match continues appending.
		// The buffered log writer may have flushed only part of its last record.
		source := io.NewSectionReader(f, 0, info.Size())
		var exportErr error
		if r.URL.Query().Get("visual") == "1" {
			var visual bytes.Buffer
			exportErr = writeVisualReplay(&visual, source)
			if exportErr == nil {
				_, exportErr = w.Write(visual.Bytes())
			} else {
				// Legacy or still-being-written logs may not have enough state for
				// authoritative replay. Preserve the original approximate viewer.
				exportErr = copyCompleteRecords(w, source)
			}
		} else {
			exportErr = copyCompleteRecords(w, source)
		}
		if exportErr != nil {
			log.Printf("replay %s: %v", id, exportErr)
		}
	})
	mux.Handle("/ws", sessionHandler(hub))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// 引导页：embed 里只有占位文件（未跑 build.sh 的开发二进制）时，
		// 别返回白屏/404，直接告诉开发者怎么把前端跑起来。
		if r.URL.Path == "/" {
			if _, err := fs.Stat(webRoot, "index.html"); err != nil {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				_, _ = w.Write([]byte(frontendMissingHTML))
				return
			}
		}
		http.FileServer(http.FS(webRoot)).ServeHTTP(w, r)
	})

	ln, err := listen.Listen(*addr)
	if err != nil {
		log.Fatal(err)
	}

	// Graceful shutdown: listeners close first (unlinking a unix socket file),
	// then in-flight requests get 10s to finish. Hijacked WebSocket sessions
	// end with the process, unchanged from the previous hard-exit behavior.
	srv := &http.Server{Handler: mux}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()

	log.Printf("oh-my-bot %s listening on %s (%s)", version, ln.Addr(), ln.Addr().Network())
	select {
	case err := <-serveErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			_ = ln.Close() // best-effort socket file cleanup before dying
			log.Fatal(err)
		}
	case <-ctx.Done():
		log.Print("shutting down, waiting up to 10s for in-flight requests")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}
}

// envAddr lets OMB_ADDR supply the default listen address; an explicit -addr
// flag still wins because the env only fills the flag's default.
func envAddr() string {
	if v := os.Getenv("OMB_ADDR"); v != "" {
		return v
	}
	return listen.Default
}

// registerVersionRoute 挂载只读 GET /api/version，返回 {"version":...}。
func registerVersionRoute(mux *http.ServeMux) {
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]string{"version": version})
	})
}

// copyCompleteRecords exposes only newline-terminated records. A partial tail
// is still being written; malformed complete lines remain visible to the parser.
func copyCompleteRecords(w io.Writer, r io.Reader) error {
	reader := bufio.NewReader(r)
	for {
		line, err := reader.ReadBytes('\n')
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if _, err := w.Write(line); err != nil {
			return err
		}
	}
}

// sessionHandler owns close cleanup without changing netws's transport contract.
// The reader can outlive ServeHTTP briefly; fence late upstream calls as well.
func sessionHandler(hub *glue.Hub) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var mu sync.Mutex
		var sess *glue.Session
		closed := false
		defer func() {
			mu.Lock()
			defer mu.Unlock()
			closed = true
			if sess != nil {
				hub.Unregister(sess)
			}
		}()
		netws.Handler(func(reliable, lossy func(*ombv1.ServerMsg)) func(*ombv1.ClientMsg) {
			return func(up *ombv1.ClientMsg) {
				mu.Lock()
				defer mu.Unlock()
				if !closed {
					handleUpstream(hub, up, reliable, lossy, &sess)
				}
			}
		}).ServeHTTP(w, r)
	})
}

// handleUpstream 全量上行路由（Phase D glue：join/leave/room_action/input/…）。
func handleUpstream(hub *glue.Hub, up *ombv1.ClientMsg, sendReliable, sendLossy func(*ombv1.ServerMsg), sess **glue.Session) {
	if up == nil {
		return
	}
	// Spectator sockets are strictly read-only: only resync and leave may flow.
	// Everything else — including a second Spectate (no role-hop/rebind spam) or
	// a player Join (no promotion) — is rejected up front.
	if cur := (*sess); cur != nil && cur.IsSpectator() {
		switch up.Payload.(type) {
		case *ombv1.ClientMsg_ResyncRequest:
			cur.Resync()
			return
		case *ombv1.ClientMsg_Leave:
			cur.LeaveRoom()
			hub.Unregister(cur)
			*sess = nil
			return
		case *ombv1.ClientMsg_Join, *ombv1.ClientMsg_Spectate,
			*ombv1.ClientMsg_Input, *ombv1.ClientMsg_WarmupInput,
			*ombv1.ClientMsg_RoomAction, *ombv1.ClientMsg_ScriptSubmit,
			*ombv1.ClientMsg_Say, *ombv1.ClientMsg_AiPrompt,
			*ombv1.ClientMsg_AssistToggle, *ombv1.ClientMsg_SnippetConfig:
			sendReliable(glue.SystemSay("join failed: readonly spectator connection"))
			return
		}
		return
	}
	switch p := up.Payload.(type) {
	case *ombv1.ClientMsg_Join:
		handleJoin(hub, p.Join, sendReliable, sendLossy, sess)
	case *ombv1.ClientMsg_Spectate:
		handleSpectate(hub, p.Spectate, sendReliable, sendLossy, sess)
	case *ombv1.ClientMsg_Input:
		if cur := (*sess); cur != nil {
			cur.RouteInput(p.Input)
		}
	case *ombv1.ClientMsg_WarmupInput:
		if cur := (*sess); cur != nil {
			cur.RouteInput(p.WarmupInput)
		}
	case *ombv1.ClientMsg_Leave:
		if cur := (*sess); cur != nil {
			cur.LeaveRoom()
			hub.Unregister(cur)
			*sess = nil
		}
	case *ombv1.ClientMsg_RoomAction:
		if cur := (*sess); cur != nil {
			cur.HostCommand(p.RoomAction.GetKind())
		}
	case *ombv1.ClientMsg_ScriptSubmit:
		if cur := (*sess); cur != nil {
			cur.SubmitScript(p.ScriptSubmit)
		}
	case *ombv1.ClientMsg_Say:
		if cur := (*sess); cur != nil {
			cur.Say(p.Say.GetText())
		}
	case *ombv1.ClientMsg_AiPrompt:
		if cur := (*sess); cur != nil {
			cur.AiPrompt(p.AiPrompt)
		}
	case *ombv1.ClientMsg_AssistToggle:
		if cur := (*sess); cur != nil {
			cur.ToggleAssist()
		}
	case *ombv1.ClientMsg_SnippetConfig:
		if cur := (*sess); cur != nil {
			cur.ConfigureSnippets(p.SnippetConfig)
		}
	case *ombv1.ClientMsg_ResyncRequest:
		if cur := (*sess); cur != nil {
			cur.Resync()
		}
	default:
		_ = sendLossy
	}
}

func handleJoin(hub *glue.Hub, join *ombv1.JoinRoom, sendReliable, sendLossy func(*ombv1.ServerMsg), sessOut **glue.Session) {
	if join == nil {
		return
	}
	rc := hub.EnsureRoom(join.GetRoomCode())
	rc.EnsureLauncher()
	sess := glue.NewSession(sendReliable, sendLossy)
	hub.Register(sess)
	if err := rc.Bind(sess, join.GetNick(), join.GetColor()); err != nil {
		hub.Unregister(sess)
		sendReliable(glue.SystemSay("join failed: " + err.Error()))
		return
	}
	if old := *sessOut; old != nil {
		hub.Unregister(old)
	}
	*sessOut = sess
	rc.BroadcastRoomState()
}

// handleSpectate attaches a read-only live observer. Reuses the established
// "join failed:" robot-0 say prefix so the client RoomSession stops retrying
// exactly like a rejected player join.
func handleSpectate(hub *glue.Hub, spec *ombv1.SpectateRoom, sendReliable, sendLossy func(*ombv1.ServerMsg), sessOut **glue.Session) {
	if spec == nil {
		return
	}
	rc := hub.EnsureRoom(spec.GetRoomCode())
	rc.EnsureLauncher()
	sess := glue.NewSession(sendReliable, sendLossy)
	hub.Register(sess)
	if err := rc.BindSpectator(sess); err != nil {
		hub.Unregister(sess)
		sendReliable(glue.SystemSay("join failed: " + err.Error()))
		return
	}
	if old := *sessOut; old != nil {
		hub.Unregister(old)
	}
	*sessOut = sess
}
