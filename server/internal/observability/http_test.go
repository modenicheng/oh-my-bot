package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestHTTPContextStatusAndRedaction(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, &slog.HandlerOptions{Level: slog.LevelDebug}))
	handler := HTTP(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if RequestID(r.Context()) != "client-request-123" {
			t.Error("request id did not reach handler")
		}
		Logger(r.Context()).Info("handler.reached")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("bad request"))
	}))
	req := httptest.NewRequest("GET", "/api/test?token=secret-token&code=secret-code", nil)
	req.Header.Set("X-Request-ID", "client-request-123")
	req.Header.Set("Authorization", "Bearer secret-authorization")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Header().Get("X-Request-ID") != "client-request-123" {
		t.Fatal("response missing request id")
	}
	if strings.Contains(output.String(), "secret-") {
		t.Fatalf("credentials leaked: %s", &output)
	}
	var record map[string]any
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &record); err != nil {
		t.Fatal(err)
	}
	if record["status"] != float64(400) || record["bytes"] != float64(11) || record["level"] != "WARN" {
		t.Fatalf("incorrect request outcome: %v", record)
	}
}

func TestHTTPRecoversPanicWithRequestID(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	handler := HTTP(logger, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("broken handler") }))
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest("GET", "/api/panic", nil))
	if res.Code != 500 || res.Header().Get("X-Request-ID") == "" {
		t.Fatalf("missing error outcome: %+v", res.Result())
	}
	if !strings.Contains(output.String(), "http.panic") || !strings.Contains(output.String(), "stack") || !strings.Contains(output.String(), `"status":500`) {
		t.Fatalf("panic diagnostics missing: %s", &output)
	}
}

func TestHTTPNoiseAndIDValidation(t *testing.T) {
	var output bytes.Buffer
	handler := HTTP(slog.New(slog.NewJSONHandler(&output, nil)), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if id := RequestID(r.Context()); id == "" || strings.ContainsAny(id, " \r\n") {
			t.Errorf("invalid request id: %q", id)
		}
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest("GET", "/healthz", nil)
	req.Header.Set("X-Request-ID", "untrusted id with spaces")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Header().Get("X-Request-ID") == req.Header.Get("X-Request-ID") {
		t.Fatal("untrusted id was accepted")
	}
	if output.Len() != 0 {
		t.Fatalf("health check should log only at debug: %s", &output)
	}
}

func TestHTTPPreservesWebSocketUpgrade(t *testing.T) {
	handler := HTTP(slog.New(slog.NewTextHandler(io.Discard, nil)), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if RequestID(r.Context()) != "socket-request-123" {
			t.Error("WebSocket request id was not propagated")
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer func() { _ = c.CloseNow() }()
		_ = c.Write(r.Context(), websocket.MessageText, []byte("connected"))
	}))
	server := httptest.NewServer(handler)
	defer server.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	c, res, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/ws?request_id=socket-request-123&token=hidden", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	if res.Header.Get("X-Request-ID") != "socket-request-123" {
		t.Fatal("upgrade lost correlation header")
	}
	_, data, err := c.Read(ctx)
	if err != nil || string(data) != "connected" {
		t.Fatalf("upgrade broke: %q, %v", data, err)
	}
}
