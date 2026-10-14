package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/modenicheng/oh-my-bot/server/internal/ai"
	"github.com/modenicheng/oh-my-bot/server/internal/glue"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func testAuthConfig() ai.AuthConfig {
	return ai.AuthConfig{
		Enabled: true, Issuer: "http://127.0.0.1:1", ClientID: "omb", ClientSecret: "s",
		TokenTTL: time.Hour, HMACSecret: "test-hmac-secret",
	}
}

// TestSetupAuthConfigMatrix（安全降级语义）：关闭/残缺返回 nil（不装配门禁
// 与路由，行为与未接入认证的版本一致），齐备才返回认证器。
func TestSetupAuthConfigMatrix(t *testing.T) {
	if got := setupAuth(ai.ServerConfig{}); got != nil {
		t.Fatal("disabled config must not install auth")
	}
	incomplete := testAuthConfig()
	incomplete.ClientSecret = ""
	if got := setupAuth(ai.ServerConfig{Auth: incomplete}); got != nil {
		t.Fatal("incomplete config must not install auth")
	}
	if got := setupAuth(ai.ServerConfig{Auth: testAuthConfig()}); got == nil {
		t.Fatal("complete enabled config must install auth")
	}
}

// TestAuthRoutesHTTP：status 开关探测、login 对不可达 IdP 的 502、callback 对
// 伪造 state 的 400、me 对 Bearer 的 401/200。
func TestAuthRoutesHTTP(t *testing.T) {
	a := setupAuth(ai.ServerConfig{Auth: testAuthConfig()})
	mux := http.NewServeMux()
	registerAuthRoutes(mux, a)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	res, err := http.Get(srv.URL + "/auth/status")
	if err != nil {
		t.Fatalf("GET /auth/status: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	var status struct{ Enabled bool }
	if err := json.NewDecoder(res.Body).Decode(&status); err != nil || !status.Enabled {
		t.Fatalf("/auth/status = %v, %v; want enabled=true", status, err)
	}

	if res, err := http.Get(srv.URL + "/auth/login"); err != nil {
		t.Fatalf("GET /auth/login: %v", err)
	} else {
		defer func() { _ = res.Body.Close() }()
		if res.StatusCode != http.StatusBadGateway {
			t.Fatalf("/auth/login with unreachable IdP = %d, want 502", res.StatusCode)
		}
	}

	if res, err := http.Get(srv.URL + "/auth/callback?state=forged"); err != nil {
		t.Fatalf("GET /auth/callback: %v", err)
	} else {
		defer func() { _ = res.Body.Close() }()
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("/auth/callback forged state = %d, want 400", res.StatusCode)
		}
	}

	if res, err := http.Get(srv.URL + "/auth/me"); err != nil {
		t.Fatalf("GET /auth/me: %v", err)
	} else {
		defer func() { _ = res.Body.Close() }()
		if res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("/auth/me without token = %d, want 401", res.StatusCode)
		}
	}

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+a.Issue("sub-1", "alice", time.Now()))
	res2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /auth/me with token: %v", err)
	}
	defer func() { _ = res2.Body.Close() }()
	var me struct{ Sub, Name string }
	if err := json.NewDecoder(res2.Body).Decode(&me); err != nil || me.Sub != "sub-1" || me.Name != "alice" {
		t.Fatalf("/auth/me = %+v, %v; want sub-1/alice", me, err)
	}
}

// wsJoinFrame 组装一条上行 Join 帧（0x02 + protobuf）。
func wsJoinFrame(t *testing.T, roomCode, nick string) []byte {
	t.Helper()
	body, err := proto.Marshal(&ombv1.ClientMsg{Payload: &ombv1.ClientMsg_Join{Join: &ombv1.JoinRoom{
		RoomCode: roomCode, Nick: nick, Color: "red",
	}}})
	if err != nil {
		t.Fatalf("marshal join: %v", err)
	}
	return append([]byte{byte(ombv1.TransportTiming_FRAME_UP)}, body...)
}

// readRoomState 读到第一条 RoomState 事件（跳过中间帧）。
func readRoomState(t *testing.T, ctx context.Context, c *websocket.Conn) *ombv1.EvRoomState {
	t.Helper()
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if len(data) == 0 || data[0] != byte(ombv1.TransportTiming_FRAME_DOWN) {
			continue
		}
		msg := &ombv1.ServerMsg{}
		if err := proto.Unmarshal(data[1:], msg); err != nil {
			continue
		}
		if rs := msg.GetEvent().GetRoomState(); rs != nil {
			return rs
		}
	}
}

// readControlNotice 读到第一条指定 code 的 EvControlNotice（跳过中间帧）。
func readControlNotice(t *testing.T, ctx context.Context, c *websocket.Conn, want ombv1.EvControlNotice_Code) *ombv1.EvControlNotice {
	t.Helper()
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if len(data) == 0 || data[0] != byte(ombv1.TransportTiming_FRAME_DOWN) {
			continue
		}
		msg := &ombv1.ServerMsg{}
		if err := proto.Unmarshal(data[1:], msg); err != nil {
			continue
		}
		if n := msg.GetEvent().GetControlNotice(); n != nil && n.GetCode() == want {
			return n
		}
	}
}

// assertGateRejected：升级成功 → 首条下行业务帧为门禁拒绝通知（文案互钉）→
// 通知对写完后连接被优雅关闭（有限帧内必然出错）。
func assertGateRejected(t *testing.T, ctx context.Context, c *websocket.Conn) {
	t.Helper()
	notice := readControlNotice(t, ctx, c, ombv1.EvControlNotice_CN_JOIN_FAILED)
	if notice.GetText() != authRejectedReason {
		t.Fatalf("gate rejection text = %q, want %q", notice.GetText(), authRejectedReason)
	}
	for i := 0; i < 8; i++ {
		if _, _, err := c.Read(ctx); err != nil {
			return // 连接已断：终态成立
		}
	}
	t.Fatal("connection must close after gate rejection")
}

// TestWSGate（OIDC 门禁 + 昵称接管）：认证开启时 /ws 无 token/过期 token 的
// 连接升级成功后立即被终态拒绝（join-failed 双形态通知 + 优雅关闭——浏览器
// WebSocket API 拿不到 401 状态码，升级前拒绝只会让客户端无限退避重连）；
// 合法 token 放行且 join 昵称强制取认证名（客户端自报仅作参照）。
func TestWSGate(t *testing.T) {
	a := setupAuth(ai.ServerConfig{Auth: testAuthConfig()})
	srv := httptest.NewServer(sessionHandler(glue.NewHub(), a))
	t.Cleanup(srv.Close)
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	noTok, _, err := websocket.Dial(ctx, wsURL+"/ws", nil)
	if err != nil {
		t.Fatalf("dial without token must upgrade (rejection is post-upgrade): %v", err)
	}
	defer func() { _ = noTok.CloseNow() }()
	assertGateRejected(t, ctx, noTok)

	expired := a.Issue("sub-1", "alice", time.Now().Add(-2*time.Hour))
	expTok, _, err := websocket.Dial(ctx, wsURL+"/ws?token="+expired, nil)
	if err != nil {
		t.Fatalf("dial with expired token must upgrade: %v", err)
	}
	defer func() { _ = expTok.CloseNow() }()
	assertGateRejected(t, ctx, expTok)

	valid := a.Issue("sub-1", "alice", time.Now())
	c, _, err := websocket.Dial(ctx, wsURL+"/ws?token="+valid, nil)
	if err != nil {
		t.Fatalf("dial with valid token: %v", err)
	}
	defer func() { _ = c.CloseNow() }()
	if err := c.Write(ctx, websocket.MessageBinary, wsJoinFrame(t, "HEAL", "attacker")); err != nil {
		t.Fatalf("send join: %v", err)
	}
	if rs := readRoomState(t, ctx, c); rs.GetHostNick() != "alice" {
		t.Fatalf("bound nick = %q, want authenticated %q (client claimed %q)", rs.GetHostNick(), "alice", "attacker")
	}
}

// TestWSGateDisabled：认证关闭时无 token 照常进房，昵称以客户端自报为准。
func TestWSGateDisabled(t *testing.T) {
	srv := httptest.NewServer(sessionHandler(glue.NewHub(), nil))
	t.Cleanup(srv.Close)
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	c, _, err := websocket.Dial(ctx, wsURL+"/ws", nil)
	if err != nil {
		t.Fatalf("dial without auth: %v", err)
	}
	defer func() { _ = c.CloseNow() }()
	if err := c.Write(ctx, websocket.MessageBinary, wsJoinFrame(t, "HEAL", "legacy")); err != nil {
		t.Fatalf("send join: %v", err)
	}
	if rs := readRoomState(t, ctx, c); rs.GetHostNick() != "legacy" {
		t.Fatalf("bound nick = %q, want client-provided %q", rs.GetHostNick(), "legacy")
	}
}

// TestJoinAuthNickTruncation：认证名超长时按 rune 截断到 16（与客户端
// claims.name.slice(0,16) 同值同界），客户端自报昵称被整体替换。
func TestJoinAuthNickTruncation(t *testing.T) {
	h := glue.NewHub()
	var session *glue.Session
	var received []*ombv1.ServerMsg
	send := func(msg *ombv1.ServerMsg) { received = append(received, msg) }
	longName := "这是一个超过十六个字符的认证昵称名称"
	handleUpstream(h, joinCase("HEAL", "attacker"), send, send, nil, &session, longName)
	if session == nil {
		t.Fatal("valid join did not bind a session")
	}
	want := string([]rune(longName)[:16])
	if state := h.EnsureRoom("HEAL").Room.StateBroadcast(); state.GetHostNick() != want {
		t.Fatalf("bound nick = %q, want truncated %q", state.GetHostNick(), want)
	}
}
