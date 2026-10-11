package auth

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testKeyID = "test-key"

// fakeIdP 最小可用 OIDC 提供方：discovery + JWKS + token 端点。id_token 由
// 测试内 RSA 密钥手签（RS256），覆盖 go-oidc 校验路径的真实现。
type fakeIdP struct {
	server *httptest.Server
	key    *rsa.PrivateKey
	// tokenHandler 由用例覆写以模拟错误响应；nil 时返回正常 id_token。
	tokenHandler func(r *http.Request) (int, string)
	// nonce 期望值：OIDC 里 nonce 只出现在授权请求，token 请求不带，测试直接注入。
	nonce string
}

func newFakeIdP(t *testing.T) *fakeIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate rsa key: %v", err)
	}
	p := &fakeIdP{key: key}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":         p.server.URL,
			"token_endpoint": p.server.URL + "/token",
			"jwks_uri":       p.server.URL + "/jwks",
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{{
			"kty": "RSA", "alg": "RS256", "use": "sig", "kid": testKeyID,
			"n": b64.EncodeToString(key.N.Bytes()),
			"e": b64.EncodeToString(bigEndian([]byte{1, 0, 1})), // 65537
		}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if p.tokenHandler != nil {
			code, body := p.tokenHandler(r)
			w.WriteHeader(code)
			_, _ = w.Write([]byte(body))
			return
		}
		if err := r.ParseForm(); err != nil || r.Form.Get("code") == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		now := time.Now()
		idToken := signJWT(t, key, map[string]any{
			"iss": p.server.URL, "sub": "sub-1", "aud": testClientID, "nonce": p.nonce,
			"exp": now.Add(time.Hour).Unix(), "iat": now.Unix(),
			"preferred_username": "krunner", "name": "Kaia Runner", "email": "kaia@example.org",
		})
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at-1", "token_type": "Bearer", "id_token": idToken,
		})
	})
	p.server = httptest.NewServer(mux)
	t.Cleanup(p.server.Close)
	return p
}

// bigEndian 返回去掉前导零的大端字节（crypto/rsa 公钥指数是 65537 = 0x010001）。
func bigEndian(b []byte) []byte {
	i := 0
	for i < len(b)-1 && b[i] == 0 {
		i++
	}
	return b[i:]
}

func signJWT(t *testing.T, key *rsa.PrivateKey, claims map[string]any) string {
	t.Helper()
	head, err := json.Marshal(map[string]any{"alg": "RS256", "typ": "JWT", "kid": testKeyID})
	if err != nil {
		t.Fatalf("marshal header: %v", err)
	}
	body, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	signed := b64.EncodeToString(head) + "." + b64.EncodeToString(body)
	digest := sha256.Sum256([]byte(signed))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatalf("sign jwt: %v", err)
	}
	return signed + "." + b64.EncodeToString(sig)
}

const testClientID = "omb-test"

func newTestAuth(p *fakeIdP) *Auth {
	// BypassProxy: true 顺带覆盖 ClientContext 出站注入路径（discovery/交换共用）。
	return New(Config{
		Issuer: p.server.URL, ClientID: testClientID, ClientSecret: "secret",
		TokenTTL: time.Hour, HMACSecret: "test-hmac-secret", BypassProxy: true,
	})
}

func TestIssueVerifyRoundtrip(t *testing.T) {
	a := New(Config{TokenTTL: time.Hour, HMACSecret: "k"})
	token := a.Issue("sub-1", "alice", time.Now())
	gotSub, gotName, err := a.VerifyToken(token)
	if err != nil {
		t.Fatalf("VerifyToken: %v", err)
	}
	if gotSub != "sub-1" || gotName != "alice" {
		t.Fatalf("got (%q,%q), want (sub-1,alice)", gotSub, gotName)
	}
}

func TestVerifyRejects(t *testing.T) {
	a := New(Config{TokenTTL: time.Hour, HMACSecret: "k"})
	now := time.Now()
	cases := []struct {
		name  string
		token string
		want  error
	}{
		{"empty", "", ErrNoToken},
		{"no signature", b64.EncodeToString([]byte(`{"sub":"x","exp":9999999999}`)), ErrBadToken},
		{"tampered payload", mustTamper(t, a.Issue("sub-1", "alice", now)), ErrBadToken},
		{"expired", a.Issue("sub-1", "alice", now.Add(-2*time.Hour)), ErrTokenExpiry},
		{"empty sub", a.Issue("", "alice", now), ErrBadToken},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := a.VerifyToken(tc.token); err != tc.want {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

// mustTamper 翻转载荷首字符得到必然验签失败的 token（保持 base64 合法性）。
func mustTamper(t *testing.T, token string) string {
	t.Helper()
	pRaw, sRaw, _ := strings.Cut(token, ".")
	pBytes, err := b64.DecodeString(pRaw)
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	pBytes[0] ^= 0x40
	return b64.EncodeToString(pBytes) + "." + sRaw
}

func TestVerifyBearerHeader(t *testing.T) {
	a := New(Config{TokenTTL: time.Hour, HMACSecret: "k"})
	token := a.Issue("sub-1", "alice", time.Now())
	r := httptest.NewRequest(http.MethodGet, "/auth/me", nil)
	if _, _, err := a.Verify(r); err != ErrNoToken {
		t.Fatalf("missing header: err = %v, want ErrNoToken", err)
	}
	r.Header.Set("Authorization", "Basic nope")
	if _, _, err := a.Verify(r); err != ErrBadToken {
		t.Fatalf("wrong scheme: err = %v, want ErrBadToken", err)
	}
	r.Header.Set("Authorization", "Bearer "+token)
	sub, name, err := a.Verify(r)
	if err != nil || sub != "sub-1" || name != "alice" {
		t.Fatalf("Verify = (%q,%q,%v)", sub, name, err)
	}
}

func TestStateRoundtrip(t *testing.T) {
	a := New(Config{TokenTTL: time.Hour, HMACSecret: "k"})
	state, nonce := a.NewState("HEALTH")
	gotNonce, gotRoom, err := a.CheckState(state)
	if err != nil {
		t.Fatalf("CheckState: %v", err)
	}
	if gotNonce != nonce || gotRoom != "HEALTH" {
		t.Fatalf("got (%q,%q), want (%q,HEALTH)", gotNonce, gotRoom, nonce)
	}
	for name, bad := range map[string]string{
		"empty":        "",
		"no signature": nonce + ".",
		"tampered":     state[:len(state)-2] + "xx",
		"garbage":      "aaa.bbb.ccc",
	} {
		if _, _, err := a.CheckState(bad); err == nil {
			t.Fatalf("CheckState(%s) accepted invalid state", name)
		}
	}
}

func TestExchangeFullFlow(t *testing.T) {
	ctx := context.Background()
	p := newFakeIdP(t)
	a := newTestAuth(p)

	state, nonce := a.NewState("")
	p.nonce = nonce
	redirect := "http://omb.test/auth/callback"
	loginURL, err := a.LoginURL(ctx, state, nonce, redirect)
	if err != nil {
		t.Fatalf("LoginURL: %v", err)
	}
	for _, want := range []string{"client_id=" + testClientID, "state=", "nonce=", "redirect_uri="} {
		if !strings.Contains(loginURL, want) {
			t.Fatalf("login URL %q missing %q", loginURL, want)
		}
	}

	sub, name, err := a.Exchange(ctx, redirect, "the-code", nonce)
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if sub != "sub-1" || name != "krunner" {
		t.Fatalf("got (%q,%q), want (sub-1,krunner)", sub, name)
	}

	if _, _, err := a.Exchange(ctx, redirect, "the-code", "wrong-nonce"); err == nil {
		t.Fatal("Exchange accepted mismatched nonce")
	}
}

func TestExchangeDisplayNameClaimChain(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name       string
		configured string
		want       string
	}{
		{"default preferred_username", "", "krunner"},
		{"configured name claim", "name", "Kaia Runner"},
		{"configured email claim", "email", "kaia@example.org"},
		{"unknown claim falls back", "nickname", "krunner"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := newFakeIdP(t)
			a := newTestAuth(p)
			a.cfg.DisplayNameClaim = tc.configured
			_, nonce := a.NewState("")
			p.nonce = nonce
			sub, name, err := a.Exchange(ctx, "http://omb.test/auth/callback", "code", nonce)
			if err != nil || sub != "sub-1" || name != tc.want {
				t.Fatalf("Exchange = (%q,%q,%v), want sub-1/%q", sub, name, err, tc.want)
			}
		})
	}
}

func TestExchangeBadTokenResponse(t *testing.T) {
	ctx := context.Background()
	p := newFakeIdP(t)
	p.tokenHandler = func(*http.Request) (int, string) { return http.StatusForbidden, `{"error":"invalid_grant"}` }
	a := newTestAuth(p)
	_, nonce := a.NewState("")
	p.nonce = nonce
	if _, _, err := a.Exchange(ctx, "http://omb.test/auth/callback", "code", nonce); err == nil {
		t.Fatal("Exchange accepted error token response")
	}
}

func TestRedirectFor(t *testing.T) {
	custom := New(Config{TokenTTL: time.Hour, HMACSecret: "k", RedirectURL: "https://omb.example/auth/callback"})
	r := httptest.NewRequest(http.MethodGet, "/auth/login", nil)
	if got := custom.RedirectFor(r); got != "https://omb.example/auth/callback" {
		t.Fatalf("configured redirect = %q", got)
	}
	derived := New(Config{TokenTTL: time.Hour, HMACSecret: "k"})
	if got := derived.RedirectFor(r); got != "http://example.com/auth/callback" {
		t.Fatalf("derived redirect = %q, want http scheme from request host", got)
	}
	r.Header.Set("X-Forwarded-Proto", "https")
	if got := derived.RedirectFor(r); got != "https://example.com/auth/callback" {
		t.Fatalf("proxy redirect = %q, want https from X-Forwarded-Proto", got)
	}
}

func TestComplete(t *testing.T) {
	full := Config{Issuer: "i", ClientID: "c", ClientSecret: "s", TokenTTL: time.Hour}
	if !full.Complete() {
		t.Fatal("complete config rejected")
	}
	for name, broken := range map[string]Config{
		"no issuer":   {ClientID: "c", ClientSecret: "s", TokenTTL: time.Hour},
		"no clientID": {Issuer: "i", ClientSecret: "s", TokenTTL: time.Hour},
		"no secret":   {Issuer: "i", ClientID: "c", TokenTTL: time.Hour},
		"no ttl":      {Issuer: "i", ClientID: "c", ClientSecret: "s"},
	} {
		if broken.Complete() {
			t.Fatalf("%s: incomplete config accepted", name)
		}
	}
}

// TestProxyTransportWiring：bypass 开关只改写克隆传输层的 Proxy 函数——
// 开启剥成 nil（直连），关闭保留标准环境代理语义。（不设 env 断言代理地址：
// ProxyFromEnvironment 首次调用后缓存环境，测试间设值不可靠；端到端行为由
// 真机验证覆盖。）
func TestProxyTransportWiring(t *testing.T) {
	bypass := New(Config{TokenTTL: time.Hour, HMACSecret: "k", BypassProxy: true})
	if got := bypass.client.Transport.(*http.Transport).Proxy; got != nil {
		t.Fatal("BypassProxy must strip the proxy function")
	}
	plain := New(Config{TokenTTL: time.Hour, HMACSecret: "k"})
	if got := plain.client.Transport.(*http.Transport).Proxy; got == nil {
		t.Fatal("default must keep environment proxy semantics")
	}
}

func TestEphemeralSecret(t *testing.T) {
	a, b := EphemeralSecret(), EphemeralSecret()
	if a == "" || a == b {
		t.Fatal("ephemeral secrets must be unique non-empty values")
	}
}
