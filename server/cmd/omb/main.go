// Command omb is the authoritative server entrypoint.
package main

import (
	"bufio"
	"embed"
	"encoding/json"
	"flag"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/modenicheng/oh-my-bot/server/internal/glue"
	"github.com/modenicheng/oh-my-bot/server/internal/netws"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

//go:embed all:web
var webFS embed.FS

//go:embed all:manual
var manualFS embed.FS

// webRoot strips the embed "web/" prefix so the site root maps web/ content.
var webRoot = func() fs.FS {
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(err)
	}
	return sub
}()

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	flag.Parse()

	hub := glue.NewHub()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

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
		_ = json.NewEncoder(w).Encode(buildManualTreeFS(manualFS, "manual"))
	})
	mux.HandleFunc("/api/manual/", func(w http.ResponseWriter, r *http.Request) {
		rel := strings.TrimPrefix(r.URL.Path, "/api/manual/")
		if rel == "" || strings.Contains(rel, "..") {
			http.Error(w, "bad path", http.StatusBadRequest)
			return
		}
		full := path.Join("manual", rel)
		if !strings.HasSuffix(full, ".md") {
			http.Error(w, "bad path", http.StatusBadRequest)
			return
		}
		data, err := manualFS.ReadFile(full)
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
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			http.Error(w, "unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("Cache-Control", "no-store")
		// Fix the read boundary while the active match continues appending.
		// The buffered log writer may have flushed only part of its last record.
		if err := copyCompleteRecords(w, io.NewSectionReader(f, 0, info.Size())); err != nil {
			log.Printf("replay %s: %v", id, err)
		}
	})
	mux.Handle("/ws", sessionHandler(hub))
	mux.Handle("/", http.FileServer(http.FS(webRoot)))

	log.Printf("oh-my-bot server listening on %s", *addr)
	if err := http.ListenAndServe(*addr, mux); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
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
	switch p := up.Payload.(type) {
	case *ombv1.ClientMsg_Join:
		handleJoin(hub, p.Join, sendReliable, sendLossy, sess)
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
	case *ombv1.ClientMsg_AiPrompt:
		if cur := (*sess); cur != nil {
			cur.AiPrompt(p.AiPrompt)
		}
	case *ombv1.ClientMsg_AssistToggle:
		if cur := (*sess); cur != nil {
			cur.ToggleAssist()
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
		sendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
			Kind: &ombv1.ServerEvent_Say{Say: &ombv1.EvSay{Robot: 0, Text: "join failed: " + err.Error()}},
		}}})
		return
	}
	if old := *sessOut; old != nil {
		hub.Unregister(old)
	}
	*sessOut = sess
	rc.BroadcastRoomState()
}

type manualNode struct {
	Path     string       `json:"path"`
	Title    string       `json:"title"`
	Children []manualNode `json:"children,omitempty"`
}

// buildManualTreeFS 递归构建 manual/ 目录树。path 为**全路径**（含父目录，
// 如 "library/api"）——客户端 navigate 直接拼 .md 后 fetch，不再拼装。
// title 取文件名去扩展名。
func buildManualTreeFS(fsys embed.FS, root string) []manualNode {
	entries, err := fsys.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []manualNode
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		if e.IsDir() {
			children := buildManualTreeFS(fsys, path.Join(root, name))
			if len(children) > 0 {
				out = append(out, manualNode{Path: name, Title: name, Children: children})
			}
			continue
		}
		if strings.HasSuffix(name, ".md") {
			full := strings.TrimSuffix(path.Join(root, name), ".md")
			// 剥离 embed 根前缀（"manual/"）：API 路由以 /api/manual/<rel> 为准
			if rel, ok := strings.CutPrefix(full, "manual/"); ok {
				full = rel
			}
			out = append(out, manualNode{Path: full, Title: strings.TrimSuffix(name, ".md"), Children: []manualNode{}})
		}
	}
	return out
}
