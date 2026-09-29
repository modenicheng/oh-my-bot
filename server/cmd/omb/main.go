// Command omb is the authoritative server entrypoint.
package main

import (
	"embed"
	"flag"
	"log"
	"net/http"

	"github.com/modenicheng/oh-my-bot/server/internal/netws"
)

//go:embed all:web
var webFS embed.FS

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	flag.Parse()

	mux := http.NewServeMux()
	mux.Handle("/ws", netws.Handler(func(send func([]byte)) func([]byte) {
		// 骨架阶段：回显上行业务帧作为下行（联调探针用）。
		return func(up []byte) { send(up) }
	}))
	mux.Handle("/", http.FileServer(http.FS(webFS)))

	log.Printf("oh-my-bot server listening on %s", *addr)
	if err := http.ListenAndServe(*addr, mux); logErr(err) {
		log.Fatal(err)
	}
}

func logErr(err error) bool { return err != nil && err != http.ErrServerClosed }
