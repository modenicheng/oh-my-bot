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
	"log/slog"
	"net/http"
	"net/http/pprof"
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
	"github.com/modenicheng/oh-my-bot/server/internal/auth"
	"github.com/modenicheng/oh-my-bot/server/internal/glue"
	"github.com/modenicheng/oh-my-bot/server/internal/listen"
	"github.com/modenicheng/oh-my-bot/server/internal/netws"
	"github.com/modenicheng/oh-my-bot/server/internal/observability"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/room"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// version 由 release 构建注入：-ldflags '-X main.version=<tag>'；开发构建保持 "dev"。
var version = "dev"

// joinFailedPrefix 是进房被拒的兼容字符串协议前缀（过渡期，X-4）：新服务器
// 双形态下发——先 EvControlNotice{code=CN_JOIN_FAILED}，再 robot=0 EvSay
// "join failed: <原因>"（旧客户端据此终止重试并展示原因）。
// TS 侧前缀常量由 packages/protocol/test/golden.test.ts 互钉。
const joinFailedPrefix = "join failed:"

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
// ai.GCConfig 文档）。Percent 无配置时已是代码内默认（ai.GCPercentDefault，
// 2026-10 压测口径：GOGC=100 下 GC assist 吞 ~40% 帧预算），此函数只负责
// 应用与钳制；显式 0 = 沿用进程默认/外部 GOGC。必须在第一个房间创建（即
// 第一台 goja VM 分配）之前调用；放在 main 早期保证这一点。解析失败记
// 日志并保留原值——GC 调优失效不应阻止服务器启动。
func applyGCSettings(cfg ai.ServerConfig) {
	if cfg.GC.Percent > 0 {
		p := cfg.GC.Percent
		if p > ai.GCPercentMax {
			p = ai.GCPercentMax
		}
		debug.SetGCPercent(p)
		slog.Info("runtime.gc_configured", "gc_percent", p)
	}
	if cfg.GC.MemoryLimit != "" {
		if limit, err := parseByteSize(cfg.GC.MemoryLimit); err == nil {
			old := debug.SetMemoryLimit(limit)
			if limit > 0 {
				slog.Info("runtime.memory_limit_configured", "limit", cfg.GC.MemoryLimit, "previous_limit", byteSizeHuman(old))
			}
		} else {
			slog.Warn("runtime.invalid_memory_limit", "value", cfg.GC.MemoryLimit, "error", err)
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

func envDefaultSoloBots() uint32 {
	raw := strings.TrimSpace(os.Getenv("OMB_DEFAULT_SOLO_BOTS"))
	if raw == "" {
		return 0
	}
	n, err := strconv.ParseUint(raw, 10, 32)
	if err != nil {
		slog.Warn("config.invalid_solo_bots", "value", raw, "error", err)
		return 0
	}
	if n > uint64(room.MaxSoloBots) {
		slog.Warn("config.solo_bots_clamped", "requested", n, "maximum", room.MaxSoloBots)
		return uint32(room.MaxSoloBots)
	}
	return uint32(n)
}

// envMaxPlayers 启动期应用 OMB_MAX_PLAYERS（单房间席位上限，代码默认 200；
// 范围 1–256，由 room.SetMaxPlayers 钳制——上界余量防配置错字，可下调回小房）。
// 必须在第一间房间创建前调用——main 里位于 hub 装配之前，满足该约束。
// 解析失败回退默认值并记日志。
func envMaxPlayers() {
	raw := strings.TrimSpace(os.Getenv("OMB_MAX_PLAYERS"))
	if raw == "" {
		return
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		slog.Warn("config.invalid_max_players", "value", raw, "default", room.MaxPlayers)
		return
	}
	before := room.MaxPlayers
	room.SetMaxPlayers(n)
	if room.MaxPlayers != n {
		slog.Warn("config.max_players_clamped", "requested", n, "maximum", room.MaxPlayers)
	}
	if room.MaxPlayers != before {
		slog.Info("config.max_players_configured", "max_players", room.MaxPlayers)
	}
}

// envDuration 读取 Go duration 字符串环境变量（如 "15s"、"5m"；容忍首尾空白）。
// 空/未设置返回 ok=false，调用方跳过——Hub 保留默认；解析失败打一条日志并按
// 未设置处理：运维配置错误回退安全默认值，不阻止服务器启动。
func envDuration(name string) (time.Duration, bool) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return 0, false
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		slog.Warn("config.invalid_duration", "setting", name, "value", raw, "error", err)
		return 0, false
	}
	return d, true
}

// applyJanitorEnv 把空房间清道夫阈值 env（审计 S-26 配置化）应用到 hub。
// 未设置=默认；非法 duration 由 envDuration 回退默认（不应用）；解析成功的
// 非正值被 Hub setter 拒绝（保留默认），这里补一条日志让配置意图可查。
func applyJanitorEnv(hub *glue.Hub) {
	for _, cfg := range []struct {
		name  string
		apply func(time.Duration)
	}{
		{"OMB_WARMUP_IDLE_STOP", hub.SetWarmupIdleStop},
		{"OMB_ROOM_EVICT_AFTER", hub.SetRoomEvictAfter},
	} {
		d, ok := envDuration(cfg.name)
		if !ok {
			continue
		}
		if d <= 0 {
			slog.Warn("config.nonpositive_duration", "setting", cfg.name, "value", d)
			continue
		}
		cfg.apply(d)
		slog.Info("config.janitor_configured", "setting", cfg.name, "value", d)
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

	serverCfg, cfgErr := ai.LoadServerConfig("")
	if cfgErr != nil {
		slog.Error("config.load_failed", "error", cfgErr)
		os.Exit(1)
	}
	logger, err := observability.NewLogger(os.Stderr, serverCfg.Log)
	if err != nil {
		slog.Error("config.logging_invalid", "error", err)
		os.Exit(1)
	}
	logger = logger.With("service", "omb", "version", version)
	slog.SetDefault(logger)
	slog.Info("logging.configured", "log_level", serverCfg.Log.Level, "log_format", serverCfg.Log.Format, "source", serverCfg.Log.Source)

	hub := glue.NewHub()
	// 席位上限先于一切房间装配（env OMB_MAX_PLAYERS，代码默认 200）。
	envMaxPlayers()
	// 空房间清道夫（审计 S-26）：空置停 warmup 对局、久置逐出房间；阈值经
	// OMB_WARMUP_IDLE_STOP / OMB_ROOM_EVICT_AFTER 配置（未设置=默认）。
	hub.StartJanitor(30 * time.Second)
	applyJanitorEnv(hub)
	if defaultBots := envDefaultSoloBots(); defaultBots > 0 {
		hub.SetDefaultSoloBots(defaultBots)
		slog.Info("config.solo_bots_configured", "solo_bots", defaultBots)
	}
	applyGCSettings(serverCfg)
	if cfgErr == nil && serverCfg.AI.Enabled && serverCfg.APIKey != "" {
		manualCorpus := loadAIManualCorpusFS(manualSource, manualRoot)
		hub.SetAIService(func() *glue.AIService {
			return glue.NewAIService(serverCfg, manualCorpus)
		})
		slog.Info("ai.enabled", "model", serverCfg.AI.Model, "manual_sections", len(manualCorpus),
			"rounds", serverCfg.Quota.PlayerRounds, "player_tokens", serverCfg.Quota.PlayerTokens,
			"global_tokens", serverCfg.Quota.GlobalTokens, "concurrency", serverCfg.Quota.MaxConcurrency)
	} else {
		slog.Info("ai.disabled", "enabled_in_config", serverCfg.AI.Enabled, "key_configured", serverCfg.APIKey != "")
	}

	mux := http.NewServeMux()

	// OIDC 认证（config.yaml auth.* 段，默认关闭）：装配成功时挂 /auth/* 路由，
	// 并对 /ws 升级做 token 门禁；返回 nil 时一切行为与未接入认证的版本一致。
	verifier := setupAuth(serverCfg)
	if verifier != nil {
		registerAuthRoutes(mux, verifier)
	}
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	// 只读版本接口：release 构建经 -ldflags '-X main.version=<tag>' 注入，二进制是唯一版本源。
	registerVersionRoute(mux)

	// 运维可观测性（批 2）：/api/stats 汇总在线/房间/对局 tick 墙钟/传输
	// 过载计数；/debug/pprof 经 OMB_PPROF 显式开启（默认关闭）。
	mux.HandleFunc("/api/stats", statsHandler(hub))
	if os.Getenv("OMB_PPROF") != "" {
		mux.HandleFunc("/debug/pprof/", pprof.Index)
		mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
		mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
		mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
		mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
		slog.Info("pprof.enabled", "path", "/debug/pprof/")
	}

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
			observability.Logger(r.Context()).Error("replay.export_failed", "match_id", id, "error", exportErr)
		}
	})
	mux.Handle("/ws", sessionHandler(hub, verifier))
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
		slog.Error("server.listen_failed", "address", *addr, "error", err)
		os.Exit(1)
	}

	// Graceful shutdown: listeners close first (unlinking a unix socket file),
	// then in-flight requests get 10s to finish. Hijacked WebSocket sessions
	// end with the process, unchanged from the previous hard-exit behavior.
	srv := &http.Server{
		Handler:  observability.HTTP(logger, mux),
		ErrorLog: slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()

	slog.Info("server.listening", "address", ln.Addr().String(), "network", ln.Addr().Network())
	select {
	case err := <-serveErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			_ = ln.Close() // best-effort socket file cleanup before dying
			slog.Error("server.serve_failed", "error", err)
			os.Exit(1)
		}
	case <-ctx.Done():
		slog.Info("server.shutting_down", "timeout", "10s")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Error("server.shutdown_failed", "error", err)
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

// statsHandler（批 2）：GET /api/stats 的只读运维快照。无鉴权——与
// /healthz 同级的基础设施接口，部署侧由反代控制可达性。
func statsHandler(hub *glue.Hub) http.HandlerFunc {
	type transportStats struct {
		LossyDropped      uint64 `json:"lossy_dropped"`
		ReliableKilled    uint64 `json:"reliable_killed"`
		ScriptLogsDropped uint64 `json:"script_logs_dropped"`
	}
	type statsPayload struct {
		Online    int              `json:"online"`
		Rooms     []glue.RoomStats `json:"rooms"`
		Transport transportStats   `json:"transport"`
	}
	return func(w http.ResponseWriter, _ *http.Request) {
		lossy, killed, logs := netws.TransportStats()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(statsPayload{
			Online:    hub.OnlineCount(),
			Rooms:     hub.StatsSnapshot(),
			Transport: transportStats{LossyDropped: lossy, ReliableKilled: killed, ScriptLogsDropped: logs},
		})
	}
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
// verifier 非 nil 时（OIDC 认证开启）验 ?token= 查询参数（浏览器 WebSocket
// API 无法自定义请求头，只能走 query）。token 无效不回 401——浏览器 WS 拿不到
// HTTP 状态码，客户端只会无限退避重连；改为完成升级后立即下发终态 join-failed
// 通知对并优雅关闭（serveAuthRejectedWS），新旧客户端都停在可读错误上。
// 验出的认证名随之注入会话，join 时强制覆盖昵称（防冒名，与 S-33 同身份
// 接管语义衔接）。
func sessionHandler(hub *glue.Hub, verifier *auth.Auth) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authName := ""
		if verifier != nil {
			_, name, err := verifier.VerifyToken(r.URL.Query().Get("token"))
			if err != nil {
				observability.Logger(r.Context()).Warn("auth.ws_rejected")
				serveAuthRejectedWS(w, r)
				return
			}
			authName = name
		}
		var mu sync.Mutex
		var sess *glue.Session
		closed := false
		compact := netws.OffersCompactProtocol(r)
		logger := observability.Logger(r.Context()).With("component", "session")
		defer func() {
			mu.Lock()
			defer mu.Unlock()
			closed = true
			if sess != nil {
				hub.Unregister(sess)
			}
		}()
		netws.Handler(func(reliable, lossy func(*ombv1.ServerMsg), frame func([]byte), closeConn func()) func(*ombv1.ClientMsg) {
			return func(up *ombv1.ClientMsg) {
				mu.Lock()
				defer mu.Unlock()
				if !closed {
					// Input is 60Hz and may carry player code or chat. Log only
					// low-frequency command kinds, never their payloads.
					switch up.GetPayload().(type) {
					case *ombv1.ClientMsg_Input, *ombv1.ClientMsg_WarmupInput:
					default:
						logger.Debug("ws.command", "kind", fmt.Sprintf("%T", up.GetPayload()))
					}
					previous := sess
					handleUpstream(hub, up, reliable, lossy, frame, closeConn, &sess, authName)
					if sess != nil && sess != previous {
						code := up.GetJoin().GetRoomCode()
						if code == "" {
							code = up.GetSpectate().GetRoomCode()
						}
						logger.Info("session.bound", "room_code", code, "spectator", sess.IsSpectator())
					}
					if sess != nil {
						sess.SetCompactSnapshots(compact)
					}
				}
			}
		}).ServeHTTP(w, r)
	})
}

// authRejectedReason 门禁拒绝的终态文案。前缀「登录已过期或无效」与客户端
// auth.ts 的 isAuthRejection 互钉：客户端据此清登录态、把徽章复位为未登录。
const authRejectedReason = "登录已过期或无效：请重新完成 OIDC 登录"

// serveAuthRejectedWS 拒绝 token 无效的连接：升级成功即在可靠通道入队
// join-failed 双形态通知（X-4）并请求优雅关闭——排队帧写完才断，通知保证
// 送达；此后一切上行经 no-op 丢弃，连接不可能进房/观战。不区分具体失败原因
// （缺 token/坏签名/过期），避免给伪造者当 oracle。
func serveAuthRejectedWS(w http.ResponseWriter, r *http.Request) {
	netws.Handler(func(sendReliable, _ func(*ombv1.ServerMsg), _ func([]byte), closeConn func()) func(*ombv1.ClientMsg) {
		sendJoinFailedReliable(sendReliable, authRejectedReason)
		closeConn()
		return func(*ombv1.ClientMsg) {}
	}).ServeHTTP(w, r)
}

// handleUpstream 全量上行路由（Phase D glue：join/leave/room_action/input/…）。
// closeConn 请求优雅关闭本连接（排队帧先发完）：注入到玩家会话，供同身份
// 接管时关闭被替换的旧连接（审计 S-33）。authName 为 /ws 门禁验出的认证名
// （未启用认证时恒空），join 时强制覆盖客户端自报昵称。
func handleUpstream(hub *glue.Hub, up *ombv1.ClientMsg, sendReliable, sendLossy func(*ombv1.ServerMsg), sendReliableFrame func([]byte), closeConn func(), sess **glue.Session, authName string) {
	if up == nil {
		return
	}
	// External SpectateRoom sockets are strictly read-only. A host spectator is
	// a normal Join control socket: it may issue host room actions but still
	// cannot send player actions.
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
			*ombv1.ClientMsg_AssistToggle, *ombv1.ClientMsg_SnippetConfig,
			*ombv1.ClientMsg_ScriptRollback, *ombv1.ClientMsg_UpgradeRequest:
			// X-4：结构化 notice 在前、兼容 join-failed say 在后（旧客户端前缀解析）。
			sendReliable(glue.ControlNotice(ombv1.EvControlNotice_CN_READONLY_SPECTATOR, "readonly spectator connection"))
			sendReliable(glue.SystemSay(joinFailedPrefix + " readonly spectator connection"))
			return
		}
		return
	}
	if cur := (*sess); cur != nil && cur.IsHostSpectator() {
		switch p := up.Payload.(type) {
		case *ombv1.ClientMsg_RoomAction:
			cur.HostCommand(p.RoomAction.GetKind())
		case *ombv1.ClientMsg_ResyncRequest:
			cur.Resync()
		case *ombv1.ClientMsg_Leave:
			cur.LeaveRoom()
			hub.Unregister(cur)
			*sess = nil
		case *ombv1.ClientMsg_Join, *ombv1.ClientMsg_Spectate,
			*ombv1.ClientMsg_Input, *ombv1.ClientMsg_WarmupInput,
			*ombv1.ClientMsg_ScriptSubmit, *ombv1.ClientMsg_ScriptRollback,
			*ombv1.ClientMsg_Say, *ombv1.ClientMsg_AiPrompt,
			*ombv1.ClientMsg_AssistToggle, *ombv1.ClientMsg_SnippetConfig,
			*ombv1.ClientMsg_UpgradeRequest:
			sendReliable(glue.ControlNotice(ombv1.EvControlNotice_CN_READONLY_SPECTATOR, "观战主持人不能发送玩家操作"))
		}
		return
	}
	switch p := up.Payload.(type) {
	case *ombv1.ClientMsg_Join:
		handleJoin(hub, p.Join, sendReliable, sendLossy, sendReliableFrame, closeConn, sess, authName)
	case *ombv1.ClientMsg_Spectate:
		handleSpectate(hub, p.Spectate, sendReliable, sendLossy, sendReliableFrame, sess)
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
	case *ombv1.ClientMsg_ScriptRollback:
		if cur := (*sess); cur != nil {
			cur.ScriptRollback(p.ScriptRollback)
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
	case *ombv1.ClientMsg_UpgradeRequest:
		if cur := (*sess); cur != nil {
			cur.BuyUpgrade(p.UpgradeRequest.GetTrack())
		}
	case *ombv1.ClientMsg_ResyncRequest:
		if cur := (*sess); cur != nil {
			cur.Resync()
		}
	default:
		_ = sendLossy
	}
}

// joinInvalidCodeReason / joinEmptyNickReason（审计 S-31）：上行 Join 参数
// 校验失败的拒绝文案。走 sendJoinFailedReliable（结构化 notice + 兼容 say），
// 与其他 join 拒绝同一条终态路径。
const (
	joinInvalidCodeReason = "房码无效：仅限大写字母与数字，长度 1-8"
	joinEmptyNickReason   = "昵称不能为空"
)

// handleJoin 进房：房码/昵称校验 + 会话绑定。authName 非空（认证开启）时昵称
// 以认证名为准——客户端自报昵称仅作认证关闭时的输入，杜绝冒名；认证名来自
// IdP 昵称回退链，trim 后恒非空，但仍保留空昵称检查兜底。
func handleJoin(hub *glue.Hub, join *ombv1.JoinRoom, sendReliable, sendLossy func(*ombv1.ServerMsg), sendReliableFrame func([]byte), closeConn func(), sessOut **glue.Session, authName string) {
	if join == nil {
		return
	}
	// 审计 S-31：此前 room_code/昵称零校验直达 EnsureRoom/Bind——空房码使互不
	// 相干的用户共享 "" 房，空昵称把身份碰撞降为默认碰撞。房码限 GenerateCode
	// 字母表（room.ValidCode 与其同源，不另抄一份）；昵称 trim 后非空，绑定
	// 统一使用 trim 后的值（与客户端表单行为一致）。
	code := join.GetRoomCode()
	nick := strings.TrimSpace(join.GetNick())
	if authName != "" {
		// 认证名替换自报昵称；按 rune 截断到 16，与客户端表单上限/上行值一致
		//（客户端 joinWith 发 claims.name.slice(0,16)，两侧必须同值同界）。
		nick = truncateNick(strings.TrimSpace(authName))
	}
	if !room.ValidCode(code) {
		sendJoinFailedReliable(sendReliable, joinInvalidCodeReason)
		return
	}
	if nick == "" {
		sendJoinFailedReliable(sendReliable, joinEmptyNickReason)
		return
	}
	rc := hub.EnsureRoom(code)
	// 房主建房时长设置（JoinRoom.match_minutes/core_open_minutes）：仅创建
	// 窗口（首次 Join 前）生效，后进房者携带的值被静默忽略；非法
	// 组合（越界/核心区不早于终局）按 join 拒绝处理，给出可读原因。
	matchTicks, coreTicks, err := sim.ValidateDurations(
		uint32(join.GetMatchMinutes())*60*uint32(sim.TickRate),
		uint32(join.GetCoreOpenMinutes())*60*uint32(sim.TickRate))
	if err != nil {
		sendJoinFailedReliable(sendReliable, "时长设置无效：游玩时长需为 1-30 分钟，且核心区开放时间须早于游玩时长")
		return
	}
	rc.EnsureLauncher()
	sess := glue.NewSession(sendReliable, sendLossy, sendReliableFrame)
	sess.SetCloser(closeConn) // 同身份接管时由 glue 关闭本连接（S-33）
	hub.Register(sess)
	if err := rc.BindJoinWithDurations(sess, nick, join.GetColor(), join.GetSpectatorMode(),
		glue.MatchDurations{MatchTicks: matchTicks, CoreOpenTick: coreTicks}); err != nil {
		hub.Unregister(sess)
		sendJoinFailedReliable(sendReliable, err.Error())
		return
	}
	if old := *sessOut; old != nil {
		hub.Unregister(old)
	}
	if !sess.IsHostSpectator() {
		rc.BroadcastRoomState()
	}
	*sessOut = sess
}

// truncateNick 按 rune 截断昵称到客户端表单上限（16）；rune 计数与 JS 的
// UTF-16 slice 在 BMP 上一致，超长 emoji 名两侧可能差一个字符（可接受边缘）。
func truncateNick(s string) string {
	runes := []rune(s)
	if len(runes) > 16 {
		return string(runes[:16])
	}
	return s
}

// sendJoinFailedReliable 双形态下发 join 拒绝（X-4）：结构化 controlNotice 在前、
// 兼容 "join failed:" 前缀 say 在后。顺序与 glue.sendJoinFailed 一致，由
// cmd/omb 测试与客户端 dedupeControlNoticeSay 互钉。
func sendJoinFailedReliable(send func(*ombv1.ServerMsg), reason string) {
	send(glue.ControlNotice(ombv1.EvControlNotice_CN_JOIN_FAILED, reason))
	send(glue.SystemSay(joinFailedPrefix + " " + reason))
}

// handleSpectate attaches a read-only live observer. Reuses the established
// joinFailedPrefix robot-0 say prefix so the client RoomSession stops retrying
// exactly like a rejected player join.
func handleSpectate(hub *glue.Hub, spec *ombv1.SpectateRoom, sendReliable, sendLossy func(*ombv1.ServerMsg), sendReliableFrame func([]byte), sessOut **glue.Session) {
	if spec == nil {
		return
	}
	// 与 handleJoin 同一房码门（审计 S-31）：否则空房码可建共享 "" 观战房。
	if !room.ValidCode(spec.GetRoomCode()) {
		sendJoinFailedReliable(sendReliable, joinInvalidCodeReason)
		return
	}
	rc := hub.EnsureRoom(spec.GetRoomCode())
	rc.EnsureLauncher()
	sess := glue.NewSession(sendReliable, sendLossy, sendReliableFrame)
	hub.Register(sess)
	if err := rc.BindSpectator(sess); err != nil {
		hub.Unregister(sess)
		sendJoinFailedReliable(sendReliable, err.Error())
		return
	}
	if old := *sessOut; old != nil {
		hub.Unregister(old)
	}
	*sessOut = sess
}
