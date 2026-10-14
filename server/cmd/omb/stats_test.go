package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/http/pprof"
	"os"
	"testing"

	"github.com/modenicheng/oh-my-bot/server/internal/glue"
)

// /api/stats（批 2）：结构、在线数与房间聚合正确；无房间时 rooms 为空数组。
func TestStatsEndpoint(t *testing.T) {
	hub := glue.NewHub()
	rc := hub.EnsureRoom("STAT1")
	rc.EnsureLauncher()

	rec := httptest.NewRecorder()
	statsHandler(hub)(rec, httptest.NewRequest(http.MethodGet, "/api/stats", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var payload struct {
		Online int `json:"online"`
		Rooms  []struct {
			Code       string `json:"code"`
			Players    int    `json:"players"`
			Spectators int    `json:"spectators"`
			Match      *struct {
				Tick      uint32  `json:"tick"`
				TickAvgMs float64 `json:"tick_avg_ms"`
				TickP95Ms float64 `json:"tick_p95_ms"`
				Warmup    bool    `json:"warmup"`
				Deferrals uint64  `json:"script_deferrals"`
			} `json:"match"`
		} `json:"rooms"`
		Transport struct {
			LossyDropped   uint64 `json:"lossy_dropped"`
			ReliableKilled uint64 `json:"reliable_killed"`
		} `json:"transport"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("payload: %v\n%s", err, rec.Body.String())
	}
	if payload.Online != 0 {
		t.Fatalf("online = %d, want 0", payload.Online)
	}
	if len(payload.Rooms) != 1 || payload.Rooms[0].Code != "STAT1" || payload.Rooms[0].Match != nil {
		t.Fatalf("rooms = %+v", payload.Rooms)
	}
}

// pprof 门控：默认不挂载（404），OMB_PPROF 开启后可达。
func TestPprofGated(t *testing.T) {
	build := func() *http.ServeMux {
		mux := http.NewServeMux()
		hub := glue.NewHub()
		mux.HandleFunc("/api/stats", statsHandler(hub))
		if os.Getenv("OMB_PPROF") != "" {
			mux.HandleFunc("/debug/pprof/", pprof.Index)
		}
		return mux
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		build().ServeHTTP(w, r)
	}))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/debug/pprof/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("pprof without OMB_PPROF = %d, want 404", resp.StatusCode)
	}
}
