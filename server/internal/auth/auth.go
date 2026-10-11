// Package auth 实现 OIDC 登录 + 自签 HMAC token 的无状态认证（设计移植自
// BITNP/wordle-competition internal/auth）。只有这一种凭证：没有服务端会话、
// 没有会话表、不存 refresh token；token 过期后前端重走 /auth/login 静默换新。
//
// 三层结构：
//   - OIDC 授权码流程（discovery 懒加载，IdP 抖动不影响启动）换出 sub/name；
//   - 自签 HMAC token（b64(payload).b64(sig)，载荷 sub/name/exp）交前端持有，
//     HTTP 接口走 Authorization: Bearer，WebSocket 握手前用 ?token= 查询参数
//     （浏览器 WebSocket API 无法自定义请求头）；
//   - 无状态防 CSRF 的 state（nonce+room 全部带签名，不存 map，重启不失效）。
//
// 认证通过后的进房昵称取认证名（cmd/omb 接线），与既有"同身份接管"语义
// （审计 S-33）天然衔接：同一 IdP 身份在任何房间的昵称恒定。
package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// 错误语义（供调用方区分 401 文案与测试断言）。
var (
	ErrNoToken     = errors.New("缺少凭证")
	ErrBadToken    = errors.New("凭证无效")
	ErrTokenExpiry = errors.New("凭证已过期")
	ErrBadState    = errors.New("state 无效")
)

// Config OIDC 接入参数（来自 config.yaml auth.* 段与 .env 秘密段）。
type Config struct {
	Issuer           string        // IdP issuer URL（ discovery 基地址）
	ClientID         string        // OIDC 客户端 ID
	ClientSecret     string        // OIDC 客户端密钥（保密，不写日志）
	RedirectURL      string        // 回调地址；空 = 按请求 Host/X-Forwarded-Proto 推导
	DisplayNameClaim string        // 进房昵称优先取的 claim；空 = preferred_username
	TokenTTL         time.Duration // 自签 token 有效期
	HMACSecret       string        // token/state 签名密钥；空 = 进程启动时随机生成（重启即全员掉登录）
	// BypassProxy 为 true 时 OIDC 出站请求（discovery/token/JWKS）强制直连，
	// 忽略 HTTP(S)_PROXY 环境变量。本地代理对 IdP 不可达（EOF/超时）时的开关；
	// 默认 false 走标准环境代理语义。
	BypassProxy bool
}

// Complete 配置是否齐备（Enabled 由 ai.AuthConfig 管，这里只查必填项）。
// HMACSecret 允许为空（调用方决定临时密钥回退），其余缺一不可。
func (c Config) Complete() bool {
	return c.Issuer != "" && c.ClientID != "" && c.ClientSecret != "" && c.TokenTTL > 0
}

// Auth OIDC + HMAC token 认证器。oauth/verifier 懒加载缓存（discovery 失败
// 不缓存，下次请求重试）——启动时不打 IdP，Keycloak 抖一下不会开不了服。
type Auth struct {
	cfg    Config
	secret []byte
	client *http.Client

	mu       sync.Mutex
	oauth    *oauth2.Config
	verifier *oidc.IDTokenVerifier
}

// New 构造认证器。签名密钥立即定形：HMACSecret 为空时用 EphemeralSecret()
// 的临时密钥（由调用方显式传入并打运维日志，这里不做隐藏分支）。
func New(cfg Config) *Auth {
	// 出站客户端克隆默认传输层（保留 HTTP/2、TLS 设置与标准环境代理语义），
	// bypass 时只剥掉 Proxy；30s 超时兜底 IdP 挂死挂不垮登录请求。
	tr := http.DefaultTransport.(*http.Transport).Clone()
	if cfg.BypassProxy {
		tr.Proxy = nil
	}
	return &Auth{
		cfg:    cfg,
		secret: []byte(cfg.HMACSecret),
		client: &http.Client{Transport: tr, Timeout: 30 * time.Second},
	}
}

// EphemeralSecret 生成 32 字节十六进制进程级临时密钥（Restart 清空登录态）。
func EphemeralSecret() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("auth: entropy unavailable: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// token 载荷。name 跟着 token 走（无用户表，昵称无法服务端反查）。
type payload struct {
	Sub  string `json:"sub"`
	Name string `json:"name"`
	Exp  int64  `json:"exp"`
}

var b64 = base64.RawURLEncoding

func (a *Auth) sign(v string) []byte {
	m := hmac.New(sha256.New, a.secret)
	m.Write([]byte(v))
	return m.Sum(nil)
}

// Issue 签发自签 token：b64(payload) + "." + b64(HMAC-SHA256(b64(payload)))。
// 签名覆盖 base64 段（与 state、JWT 惯例一致），Verify 侧无需重编码。
func (a *Auth) Issue(sub, name string, now time.Time) string {
	p, err := json.Marshal(payload{Sub: sub, Name: name, Exp: now.Add(a.cfg.TokenTTL).Unix()})
	if err != nil {
		return "" // 结构体序列化不可失败；防御分支返回空串（Verify 必拒）
	}
	pRaw := b64.EncodeToString(p)
	return pRaw + "." + b64.EncodeToString(a.sign(pRaw))
}

// VerifyToken 校验 token 并返回 (sub, name)。任何一步失败都只返回错误，
// 不暴露"哪一步失败"的细节（避免给伪造者当 oracle）。
func (a *Auth) VerifyToken(token string) (string, string, error) {
	if token == "" {
		return "", "", ErrNoToken
	}
	pRaw, sRaw, ok := strings.Cut(token, ".")
	if !ok {
		return "", "", ErrBadToken
	}
	pBytes, err := b64.DecodeString(pRaw)
	if err != nil {
		return "", "", ErrBadToken
	}
	sig, err := b64.DecodeString(sRaw)
	if err != nil || !hmac.Equal(a.sign(pRaw), sig) {
		return "", "", ErrBadToken
	}
	var p payload
	if err := json.Unmarshal(pBytes, &p); err != nil || p.Sub == "" {
		return "", "", ErrBadToken
	}
	if time.Now().Unix() >= p.Exp {
		return "", "", ErrTokenExpiry
	}
	return p.Sub, p.Name, nil
}

// Verify 校验 HTTP Authorization: Bearer 头（HTTP 接口用）。
func (a *Auth) Verify(r *http.Request) (string, string, error) {
	h := r.Header.Get("Authorization")
	if h == "" {
		return "", "", ErrNoToken
	}
	token, ok := strings.CutPrefix(h, "Bearer ")
	if !ok {
		return "", "", ErrBadToken
	}
	return a.VerifyToken(token)
}

// NewState 生成无状态 CSRF state：b64(nonce) + "." + b64(room) + "." +
// b64(sign)。nonce 同时用作 OIDC nonce；room 是登录前所在房码，登录回跳后
// 用来恢复表单。签名密钥只有服务端有，第三方无法伪造（不存 map，重启不失效）。
func (a *Auth) NewState(room string) (state, nonce string) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		panic("auth: entropy unavailable: " + err.Error())
	}
	nonce = b64.EncodeToString(raw)
	body := nonce + "." + b64.EncodeToString([]byte(room))
	return body + "." + b64.EncodeToString(a.sign(body)), nonce
}

// CheckState 验签 state 并取回 (nonce, room)。签名段从右侧切分：body 自身
// 含点（nonce.room），从左切会把 body 切碎。
func (a *Auth) CheckState(state string) (string, string, error) {
	dot := strings.LastIndex(state, ".")
	if dot < 0 {
		return "", "", ErrBadState
	}
	body, sRaw := state[:dot], state[dot+1:]
	sig, err := b64.DecodeString(sRaw)
	if err != nil || !hmac.Equal(a.sign(body), sig) {
		return "", "", ErrBadState
	}
	nonce, roomRaw, ok := strings.Cut(body, ".")
	if !ok {
		return "", "", ErrBadState
	}
	room, err := b64.DecodeString(roomRaw)
	if err != nil || nonce == "" {
		return "", "", ErrBadState
	}
	return nonce, string(room), nil
}

// LoginURL 返回 IdP 授权页地址（state/nonce/redirect_uri 由调用方决定，
// redirect 允许按请求推导时与配置不同）。discovery 失败返回错误——调用方
// 回 502，用户重试即可。
func (a *Auth) LoginURL(ctx context.Context, state, nonce, redirect string) (string, error) {
	oc, err := a.ensure(ctx)
	if err != nil {
		return "", err
	}
	oc.RedirectURL = redirect
	return oc.AuthCodeURL(state, oidc.Nonce(nonce)), nil
}

// Exchange 用授权码换 id_token 并校验（签名/issuer/audience/nonce），返回
// (sub, name)。name 按 DisplayNameClaim → preferred_username → name → email
// → sub 依次回退，trim 后兜底恒非空。
func (a *Auth) Exchange(ctx context.Context, redirect, code, nonce string) (string, string, error) {
	oc, err := a.ensure(ctx)
	if err != nil {
		return "", "", err
	}
	oc.RedirectURL = redirect
	tok, err := oc.Exchange(a.clientContext(ctx), code)
	if err != nil {
		return "", "", fmt.Errorf("code exchange: %w", err)
	}
	raw, ok := tok.Extra("id_token").(string)
	if !ok || raw == "" {
		return "", "", errors.New("token response missing id_token")
	}
	idToken, err := a.verifier.Verify(ctx, raw)
	if err != nil {
		return "", "", fmt.Errorf("id_token verify: %w", err)
	}
	if idToken.Nonce != nonce {
		return "", "", errors.New("id_token nonce mismatch")
	}
	claims := map[string]any{}
	if err := idToken.Claims(&claims); err != nil {
		return "", "", fmt.Errorf("id_token claims: %w", err)
	}
	sub := idToken.Subject
	if sub == "" {
		sub, _ = claims["sub"].(string)
	}
	if sub == "" {
		return "", "", errors.New("id_token missing sub")
	}
	name := displayName(a.cfg.DisplayNameClaim, claims, sub)
	return sub, name, nil
}

// displayName 昵称回退链。configured → preferred_username → name → email → sub。
func displayName(configured string, claims map[string]any, sub string) string {
	for _, key := range []string{configured, "preferred_username", "name", "email"} {
		if key == "" {
			continue
		}
		if v, ok := claims[key].(string); ok {
			if name := strings.TrimSpace(v); name != "" {
				return name
			}
		}
	}
	return sub
}

// clientContext 注入出站 HTTP 客户端。oidc.ClientContext 用的就是 oauth2 的
// 同一个 context key：discovery/JWKS（NewProvider 时捕获复用）与 token 交换
// 一处覆盖，bypass_proxy 时三者一致直连。
func (a *Auth) clientContext(ctx context.Context) context.Context {
	return oidc.ClientContext(ctx, a.client)
}

// ensure 懒加载 discovery 并缓存 oauth2.Config 与 verifier；失败不缓存。
func (a *Auth) ensure(ctx context.Context) (*oauth2.Config, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.oauth != nil {
		return a.oauth, nil
	}
	provider, err := oidc.NewProvider(a.clientContext(ctx), a.cfg.Issuer)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery: %w", err)
	}
	oc := &oauth2.Config{
		ClientID:     a.cfg.ClientID,
		ClientSecret: a.cfg.ClientSecret,
		Endpoint:     provider.Endpoint(),
		Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
		RedirectURL:  a.cfg.RedirectURL,
	}
	a.oauth = oc
	a.verifier = provider.Verifier(&oidc.Config{ClientID: a.cfg.ClientID})
	return oc, nil
}

// RedirectFor 回调地址：配置优先；否则按请求推导（反代场景认
// X-Forwarded-Proto，unix socket 部署没有 r.TLS，nginx 必须透传该头）。
func (a *Auth) RedirectFor(r *http.Request) string {
	if a.cfg.RedirectURL != "" {
		return a.cfg.RedirectURL
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
		scheme = proto
	}
	return scheme + "://" + r.Host + "/auth/callback"
}
