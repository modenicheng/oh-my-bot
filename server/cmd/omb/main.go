// Command omb is the authoritative server entrypoint.
package main

import (
	"embed"
	"flag"
	"io/fs"
	"log"
	"net/http"

	"github.com/modenicheng/oh-my-bot/server/internal/netws"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

//go:embed all:web
var webFS embed.FS

// webRoot 剥掉 embed 的 web/ 前缀，使站点根直接映射 web/ 内容（index.html 在 /，assets 在 /assets/）。
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

	mux := http.NewServeMux()
	mux.Handle("/ws", netws.Handler(func(up *ombv1.ClientMsg, sendReliable, sendLossy func(*ombv1.ServerMsg)) {
		// 骨架阶段：回显上行业务消息为下行事件（联调探针用）。
		echo := &ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{
			Kind: &ombv1.ServerEvent_Say{Say: &ombv1.EvSay{Robot: 0, Text: up.String()}},
		}}}
		sendReliable(echo)
	}))
	mux.Handle("/", http.FileServer(http.FS(webRoot)))

	log.Printf("oh-my-bot server listening on %s", *addr)
	if err := http.ListenAndServe(*addr, mux); logErr(err) {
		log.Fatal(err)
	}
}

func logErr(err error) bool { return err != nil && err != http.ErrServerClosed }
