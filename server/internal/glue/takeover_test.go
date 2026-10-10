package glue

import (
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// TestTakeoverNotifiesAndClosesOldSession（审计 S-33）：同身份接管时旧会话
// 收到 CN_TAKEOVER notice + 同文兼容 say（notice 在前），其连接被请求关闭，
// 新会话不受影响地完成接管。
func TestTakeoverNotifiesAndClosesOldSession(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("TAKEOVR")
	old, oldLog := bindLogged(t, h, rc, "alice")
	oldLog.take()

	closed := 0
	old.SetCloser(func() { closed++ })

	fresh, freshLog := bindLogged(t, h, rc, "alice")

	// 旧会话：成对 takeover 通知（顺序：notice → 同文 robot-0 say），连接被关闭一次。
	msgs := oldLog.take()
	if len(msgs) != 2 {
		t.Fatalf("old session should see exactly the takeover notice pair, got %+v", msgs)
	}
	notice := msgs[0].msg.GetEvent().GetControlNotice()
	if notice == nil || notice.GetCode() != ombv1.EvControlNotice_CN_TAKEOVER || notice.GetText() != takeoverNoticeText {
		t.Fatalf("first old-session message is not the takeover notice: %+v", msgs[0].msg)
	}
	if say := msgs[1].msg.GetEvent().GetSay(); say == nil || say.GetRobot() != 0 || say.GetText() != takeoverNoticeText {
		t.Fatalf("second old-session message is not the same-text robot-0 say: %+v", msgs[1].msg)
	}
	if closed != 1 {
		t.Fatalf("old connection close requested %d times, want exactly 1", closed)
	}

	// 新会话：正常接管，不收到 takeover 通知。
	rc.mu.Lock()
	current := rc.sessions[fresh.playerID]
	rc.mu.Unlock()
	if current != fresh || fresh.playerID != old.playerID {
		t.Fatal("takeover did not hand the identity to the fresh session")
	}
	for _, sm := range freshLog.take() {
		if n := sm.msg.GetEvent().GetControlNotice(); n != nil && n.GetCode() == ombv1.EvControlNotice_CN_TAKEOVER {
			t.Fatal("fresh session must not receive the takeover notice")
		}
	}

	// 连接关闭后的 Unregister 链路（cmd/omb 会话清理路径）必须是无害 no-op：
	// 不能把新会话从房间/花名册里清掉。
	h.Unregister(old)
	rc.mu.Lock()
	stillCurrent := rc.sessions[fresh.playerID]
	rc.mu.Unlock()
	if stillCurrent != fresh || rc.Room.MemberCount() != 1 {
		t.Fatal("stale unregister after takeover disturbed the new session")
	}
}

// TestTakeoverWithoutCloserIsNoop：未注入 closer 的会话（测试/嵌入式装配）
// 接管路径不 panic，通知照发。
func TestTakeoverWithoutCloserIsNoop(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("TAKEOVR")
	old, oldLog := bindLogged(t, h, rc, "alice")
	oldLog.take()
	fresh, _ := bindLogged(t, h, rc, "alice")
	if fresh.playerID != old.playerID {
		t.Fatal("identity not restored")
	}
	if len(oldLog.take()) != 2 {
		t.Fatal("notice pair missing without closer")
	}
}

// TestFirstBindIsNotATakeover：无旧会话时首次 Bind 不发通知、不关连接。
func TestFirstBindIsNotATakeover(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("TAKEOVR")
	closed := 0
	s, log := bindLogged(t, h, rc, "alice")
	s.SetCloser(func() { closed++ })
	// 再触发一次上游操作确认无副作用。
	s.AiPrompt(&ombv1.AiPrompt{Text: "hi"})
	if closed != 0 {
		t.Fatal("first bind must not request a close")
	}
	for _, sm := range log.take() {
		if n := sm.msg.GetEvent().GetControlNotice(); n != nil && n.GetCode() == ombv1.EvControlNotice_CN_TAKEOVER {
			t.Fatal("first bind emitted a takeover notice")
		}
	}
}
