package main

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// 手册图片：只允许 docs/manual 内受信任的 PNG/WebP 白名单文件，防任意路径读取。
// 与 markdown 路由同源（/api/manual/ 前缀），供阅读器内嵌 <img> 使用。

var manualImageExts = map[string]string{
	".png":  "image/png",
	".webp": "image/webp",
}

// manualImagePath 校验相对路径并返回清洗后的 POSIX 路径。
// 规则：非空、不含 ".." 、无盘符/绝对路径、单文件名（禁止子目录枚举目录本身）、后缀在白名单。
func manualImagePath(rel string) (string, string, bool) {
	if rel == "" || strings.Contains(rel, "..") {
		return "", "", false
	}
	// 统一分隔符后拒绝绝对路径与盘符（Windows 下 path.IsAbs 不覆盖 C:\）。
	rel = strings.ReplaceAll(rel, "\\", "/")
	if strings.HasPrefix(rel, "/") || len(rel) >= 2 && rel[1] == ':' {
		return "", "", false
	}
	clean := path.Clean("/" + rel) // 归一化 ./ 与 //，结果以 / 开头
	clean = strings.TrimPrefix(clean, "/")
	if clean == "" || strings.Contains(clean, "..") {
		return "", "", false
	}
	ext := strings.ToLower(path.Ext(clean))
	ct, ok := manualImageExts[ext]
	if !ok {
		return "", "", false
	}
	return clean, ct, true
}

// serveManualImage 从 manualSource（embed 或磁盘目录）读取白名单图片。
// 路径不合法返回 400；文件不存在返回 404。
func serveManualImage(w http.ResponseWriter, r *http.Request, source fs.FS, root string) {
	rel := strings.TrimPrefix(r.URL.Path, "/api/manual/")
	clean, contentType, ok := manualImagePath(rel)
	if !ok {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	data, err := fs.ReadFile(source, path.Join(root, clean))
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write(data)
}
