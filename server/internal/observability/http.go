package observability

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"time"
)

type requestKey struct{}

type requestContext struct {
	id     string
	logger *slog.Logger
}

func RequestID(ctx context.Context) string {
	if value, ok := ctx.Value(requestKey{}).(requestContext); ok {
		return value.id
	}
	return ""
}

func Logger(ctx context.Context) *slog.Logger {
	if value, ok := ctx.Value(requestKey{}).(requestContext); ok {
		return value.logger
	}
	return slog.Default()
}

func newRequestID() string {
	var id [16]byte
	_, _ = rand.Read(id[:])
	return hex.EncodeToString(id[:])
}

func validRequestID(id string) bool {
	if len(id) == 0 || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '-' && c != '_' {
			return false
		}
	}
	return true
}

// HTTP logs only paths and outcome metadata. Query strings, cookies, bodies and
// headers can contain OIDC credentials and must never enter the access log.
func HTTP(base *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if id == "" && r.URL.Path == "/ws" {
			// Browser WebSockets cannot set headers; the client supplies this one
			// non-secret query parameter to correlate an individual dial attempt.
			id = r.URL.Query().Get("request_id")
		}
		if !validRequestID(id) {
			id = newRequestID()
		}
		logger := base.With("request_id", id, "method", r.Method, "path", r.URL.Path)
		r = r.WithContext(context.WithValue(r.Context(), requestKey{}, requestContext{id, logger}))
		w.Header().Set("X-Request-ID", id)
		response := &responseWriter{ResponseWriter: w}
		started := time.Now()
		defer func() {
			if recovered := recover(); recovered != nil {
				if recovered == http.ErrAbortHandler {
					logHTTPOutcome(logger, r, response, started)
					panic(recovered)
				}
				logger.ErrorContext(r.Context(), "http.panic", "error", fmt.Sprint(recovered), "stack", string(debug.Stack()))
				if response.status != 0 || response.hijacked {
					// A committed response cannot become a truthful 500. Let net/http
					// abort it so clients cannot mistake a partial body for success.
					logHTTPOutcome(logger, r, response, started)
					panic(http.ErrAbortHandler)
				}
				http.Error(response, "internal server error", http.StatusInternalServerError)
			}
			logHTTPOutcome(logger, r, response, started)
		}()
		next.ServeHTTP(response, r)
	})
}

func logHTTPOutcome(logger *slog.Logger, r *http.Request, response *responseWriter, started time.Time) {
	status := response.status
	if status == 0 {
		status = http.StatusOK
	}
	level := slog.LevelDebug
	switch {
	case status >= 500:
		level = slog.LevelError
	case status >= 400:
		level = slog.LevelWarn
	case (strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/api/stats") || strings.HasPrefix(r.URL.Path, "/auth/"):
		level = slog.LevelInfo
	}
	logger.Log(r.Context(), level, "http.request",
		"status", status, "bytes", response.bytes,
		"duration_ms", float64(time.Since(started).Microseconds())/1000)
}

type responseWriter struct {
	http.ResponseWriter
	status   int
	bytes    int64
	hijacked bool
}

func (w *responseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *responseWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	if status >= 200 || status == http.StatusSwitchingProtocols {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *responseWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(body)
	w.bytes += int64(n)
	return n, err
}

func (w *responseWriter) FlushError() error {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *responseWriter) Flush() { _ = w.FlushError() }

func (w *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, buffer, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err == nil {
		w.hijacked = true
		if w.status == 0 {
			w.status = http.StatusSwitchingProtocols
		}
	}
	return conn, buffer, err
}
