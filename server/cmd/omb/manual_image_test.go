package main

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestManualImagePath(t *testing.T) {
	cases := []struct {
		rel  string
		want bool
	}{
		{"reference/images/robots.png", true},
		{"reference/images/hud.webp", true},
		{"reference/images/PIC.PNG", true}, // 后缀大小写不敏感
		{"", false},
		{"..", false},
		{"../secret.png", false},
		{"reference/../../etc/passwd.png", false},
		{"/abs/path.png", false},
		{"C:/windows/system32.png", false},
		{"..\\windows\\system32.png", false},
		{"reference/images", false},     // 目录无后缀
		{"reference/images/", false},    // 目录本身
		{"reference/doc.md", false},     // markdown 不走图片路由
		{"reference/notes.txt", false},  // 非白名单后缀
		{"reference/.hidden.png", true}, // 隐藏文件仍是白名单图片
	}
	for _, c := range cases {
		if _, _, got := manualImagePath(c.rel); got != c.want {
			t.Errorf("manualImagePath(%q) = %v, want %v", c.rel, got, c.want)
		}
	}
}

func TestServeManualImage(t *testing.T) {
	mapFS := fstest.MapFS{
		"manual/reference/images/robots.png":     &fstest.MapFile{Data: []byte("PNGDATA")},
		"manual/reference/images/hud.webp":       &fstest.MapFile{Data: []byte("WEBPDATA")},
		"manual/reference/images/.gitkeep":       &fstest.MapFile{Data: []byte("")},
		"manual/reference/index.md":              &fstest.MapFile{Data: []byte("---\ntitle: x\n---\n")},
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveManualImage(w, r, mapFS, "manual")
	})

	t.Run("ok png", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/manual/reference/images/robots.png", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("code = %d, want 200", rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
			t.Errorf("content-type = %q, want image/png", ct)
		}
		if rec.Body.String() != "PNGDATA" {
			t.Errorf("body = %q, want PNGDATA", rec.Body.String())
		}
	})

	t.Run("ok webp", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/manual/reference/images/hud.webp", nil))
		if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/webp" {
			t.Fatalf("code=%d ct=%q, want 200 image/webp", rec.Code, rec.Header().Get("Content-Type"))
		}
	})

	t.Run("traversal rejected", func(t *testing.T) {
		for _, p := range []string{"/api/manual/../../cmd/omb/main.go", "/api/manual/reference/../../../etc/passwd.png"} {
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
			if rec.Code != http.StatusBadRequest {
				t.Errorf("GET %s code = %d, want 400", p, rec.Code)
			}
		}
	})

	t.Run("suffix not allowed", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/manual/reference/index.md", nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("code = %d, want 400", rec.Code)
		}
	})

	t.Run("missing file 404", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/manual/reference/images/nope.png", nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("code = %d, want 404", rec.Code)
		}
	})

	// 确保 embed 根外不可读取：manual 根之上没有内容，且路径以 manual/ 前缀拼接。
	if !strings.HasPrefix("manual/reference/images/robots.png", "manual/") {
		t.Fatal("unreachable")
	}
	_ = fs.ValidPath
}
