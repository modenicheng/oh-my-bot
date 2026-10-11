// OIDC 认证接线：auth.* 配置装配 + /auth/* 路由。流程与 internal/auth 的
// 设计一致（移植自 BITNP/wordle-competition）：/auth/login 302 跳 IdP →
// /auth/callback 验 state/换身份 → 302 /?token=<自签 HMAC token>[&room=…]
// 交付前端。token 只在重定向 query 出现一次；前端落入 localStorage 后立即
// 清洗地址栏， Referrer-Policy: no-referrer 防止回跳 query 泄给下一站点。
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/ai"
	"github.com/modenicheng/oh-my-bot/server/internal/auth"
)

// setupAuth 按 config.yaml auth.* 段装配认证器。默认开启：issuer/client_id/
// client_secret 配齐即返回认证器；残缺或显式关闭返回 nil——/ws 门禁与
// /auth/* 路由都不装配，行为与未接入认证的历史版本完全一致（与 AI 缺 key
// 同一安全降级哲学：配置问题不让服务器起不来，但日志说清楚）。
func setupAuth(cfg ai.ServerConfig) *auth.Auth {
	ac := cfg.Auth
	if !ac.Enabled {
		return nil
	}
	oidcCfg := auth.Config{
		Issuer:           ac.Issuer,
		ClientID:         ac.ClientID,
		ClientSecret:     ac.ClientSecret,
		RedirectURL:      ac.RedirectURL,
		DisplayNameClaim: ac.DisplayNameClaim,
		TokenTTL:         ac.TokenTTL,
		HMACSecret:       ac.HMACSecret,
		BypassProxy:      ac.BypassProxy,
	}
	if !oidcCfg.Complete() {
		log.Printf("auth disabled: auth.* config incomplete (need issuer/client_id/client_secret); configure them or set auth.enabled=false")
		return nil
	}
	if oidcCfg.HMACSecret == "" {
		oidcCfg.HMACSecret = auth.EphemeralSecret()
		log.Printf("auth: OMB_AUTH_SECRET not set; using ephemeral secret (all logins reset on restart)")
	}
	log.Printf("auth enabled: issuer=%s client_id=%s token_ttl=%s", ac.Issuer, ac.ClientID, ac.TokenTTL)
	return auth.New(oidcCfg)
}

// registerAuthRoutes 挂载认证路由（仅在装配成功时调用；未装配时 /auth/status
// 404，客户端据此隐藏登录入口）。
func registerAuthRoutes(mux *http.ServeMux, a *auth.Auth) {
	// 状态探测（无鉴权）：客户端据此决定展示/隐藏登录徽章。
	mux.HandleFunc("GET /auth/status", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]bool{"enabled": true})
	})
	mux.HandleFunc("GET /auth/login", func(w http.ResponseWriter, r *http.Request) {
		// room 随 state 签名走完 IdP 往返，登录回跳后表单自动恢复房码。
		state, nonce := a.NewState(r.URL.Query().Get("room"))
		target, err := a.LoginURL(r.Context(), state, nonce, a.RedirectFor(r))
		if err != nil {
			log.Printf("auth login: %v", err)
			http.Error(w, "OIDC provider unavailable, try again later", http.StatusBadGateway)
			return
		}
		http.Redirect(w, r, target, http.StatusFound)
	})
	mux.HandleFunc("GET /auth/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if e := q.Get("error"); e != "" {
			http.Error(w, "OIDC error: "+e, http.StatusForbidden)
			return
		}
		nonce, room, err := a.CheckState(q.Get("state"))
		if err != nil {
			http.Error(w, "invalid login state, retry from /auth/login", http.StatusBadRequest)
			return
		}
		code := q.Get("code")
		if code == "" {
			http.Error(w, "missing authorization code", http.StatusBadRequest)
			return
		}
		sub, name, err := a.Exchange(r.Context(), a.RedirectFor(r), code, nonce)
		if err != nil {
			log.Printf("auth callback: %v", err)
			http.Error(w, "login exchange failed, try again", http.StatusBadGateway)
			return
		}
		// 只重定向到本应用，不落任何服务端状态；query 不写访问日志（本项目
		// 本就没有请求日志，此注释是约定而非实现依赖）。
		w.Header().Set("Referrer-Policy", "no-referrer")
		target := url.Values{"token": {a.Issue(sub, name, time.Now())}}
		if room != "" {
			target.Set("room", room)
		}
		http.Redirect(w, r, "/?"+target.Encode(), http.StatusFound)
	})
	mux.HandleFunc("GET /auth/me", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		sub, name, err := a.Verify(r)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"sub": sub, "name": name})
	})
}
