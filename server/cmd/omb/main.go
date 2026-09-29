// Command omb is the authoritative server entrypoint.
package main

import (
	"embed"
	"encoding/json"
	"flag"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/modenicheng/oh-my-bot/server/internal/glue"
	"github.com/modenicheng/oh-my-bot/server/internal/netws"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

//go:embed all:web
var webFS embed.FS

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
		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = io.Copy(w, f)
	})
	mux.Handle("/ws", netws.Handler(func(sendReliable, sendLossy func(*ombv1.ServerMsg)) func(up *ombv1.ClientMsg) {
		// 每连接一份会话上下文（工厂返回的 onUp 闭包捕获——多连接隔离）
		var sess *glue.Session
		return func(up *ombv1.ClientMsg) {
			handleUpstream(hub, up, sendReliable, sendLossy, &sess)
		}
	}))
	mux.Handle("/", http.FileServer(http.FS(webRoot)))

	log.Printf("oh-my-bot server listening on %s", *addr)
	if err := http.ListenAndServe(*addr, mux); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// handleUpstream 全量上行路由（Phase D glue：join/leave/room_action/input/…）。
func handleUpstream(hub *glue.Hub, up *ombv1.ClientMsg, sendReliable, sendLossy func(*ombv1.ServerMsg), sess **glue.Session) {
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
	case *ombv1.ClientMsg_ResyncRequest:
		if cur := (*sess); cur != nil {
			cur.Resync()
		}
	default:
		_ = sendLossy
	}
}

func handleJoin(hub *glue.Hub, join *ombv1.JoinRoom, sendReliable, sendLossy func(*ombv1.ServerMsg), sessOut **glue.Session) {
	rc := hub.EnsureRoom(join.GetRoomCode())
	rc.EnsureLauncher()
	sess := glue.NewSession(sendReliable, sendLossy)
	hub.Register(sess)
	if err := rc.Bind(sess, join.GetNick(), join.GetColor()); err != nil {
		sendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
			Kind: &ombv1.ServerEvent_Say{Say: &ombv1.EvSay{Robot: 0, Text: "join failed: " + err.Error()}},
		}}})
		return
	}
	sess.BindRoom(rc)
	*sessOut = sess
	rc.BroadcastRoomState()
}
