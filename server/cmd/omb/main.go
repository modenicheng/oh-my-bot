// Command omb is the authoritative server entrypoint.
package main

import (
	"embed"
	"flag"
	"log"
	"net/http"
)

//go:embed all:web
var webFS embed.FS

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	flag.Parse()

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(webFS)))

	log.Printf("oh-my-bot server listening on %s", *addr)
	if err := http.ListenAndServe(*addr, mux); logErr(err) {
		log.Fatal(err)
	}
}

func logErr(err error) bool { return err != nil && err != http.ErrServerClosed }
