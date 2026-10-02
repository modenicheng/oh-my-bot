package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestVersionVariableIsPackageLevel 钉住 ldflags 注入点：release 构建用
// -ldflags '-X main.version=<tag>' 覆盖同名包级变量，签名不能变。
func TestVersionVariableIsPackageLevel(t *testing.T) {
	if version == "" {
		t.Fatal("version must not be empty")
	}
	if got, want := version, "dev"; got != want {
		t.Fatalf("default build version = %q, want %q (set via -ldflags in release)", got, want)
	}
}

// TestAPIVersionGetOnlyJSON：GET 返回 {"version":...}；非 GET 405 且带 Allow: GET。
func TestAPIVersionGetOnlyJSON(t *testing.T) {
	handler := http.NewServeMux()
	registerVersionRoute(handler)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/version", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/version status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	if cache := rec.Header().Get("Cache-Control"); cache != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", cache)
	}
	var payload struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("body is not JSON: %v (%q)", err, rec.Body.String())
	}
	if payload.Version != version {
		t.Fatalf("payload version = %q, want %q", payload.Version, version)
	}

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/version", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /api/version status = %d, want 405", rec.Code)
	}
	if allow := rec.Header().Get("Allow"); allow != "GET" {
		t.Fatalf("Allow header = %q, want GET", allow)
	}
}
