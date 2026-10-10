package glue

import (
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// inactiveMatch 返回一个已停止（Ended 语义：rc.match 仍挂着但对局不再
// active）的 warmup 对局，覆盖审计 S-30 的第二分支。
func inactiveMatch(t *testing.T, h *Hub, rc *RoomConn, s *Session) *Match {
	t.Helper()
	m := assembledTestMatch(t, rc, s)
	rc.mu.Lock()
	rc.match = m
	rc.mu.Unlock()
	stopTestMatch(t, m) // Stop 后 activeLocked 恒 false；rc.match 仍指向它
	return m
}

// TestInactiveScriptSubmitGetsNack（审计 S-30）：无 match 与 Ended 两分支的
// ScriptSubmit 都必须收到 EvScriptResult nack（client_script_id 回显），不再
// 静默悬空让客户端等 10s 超时；激活态照常成功（对照组）。
func TestInactiveScriptSubmitGetsNack(t *testing.T) {
	run := func(name string, ended bool) {
		t.Run(name, func(t *testing.T) {
			h := NewHub()
			rc := h.EnsureRoom("NACKSUB")
			s, log := bindLogged(t, h, rc, "pilot")
			if ended {
				inactiveMatch(t, h, rc, s)
			}
			log.take()

			if !ended { // 对照组：激活对局内提交照常成功
				m := assembledTestMatch(t, rc, s)
				rc.mu.Lock()
				rc.match = m
				rc.mu.Unlock()
				s.SubmitScript(&ombv1.ScriptSubmit{ClientScriptId: 7, Source: "function tick() {}"})
				var okSeen bool
				for _, sm := range log.take() {
					if r := sm.msg.GetEvent().GetScriptResult(); r != nil && r.GetOk() {
						okSeen = true
					}
				}
				if !okSeen {
					t.Fatal("active-match submit lost its success receipt")
				}
				return
			}
			s.SubmitScript(&ombv1.ScriptSubmit{ClientScriptId: 7, Source: "function tick() {}"})
			var nack *ombv1.EvScriptResult
			for _, sm := range log.take() {
				if r := sm.msg.GetEvent().GetScriptResult(); r != nil {
					if nack != nil {
						t.Fatal("multiple script results for one submit")
					}
					nack = r
				}
			}
			if nack == nil {
				t.Fatal("inactive submit silently dropped (S-30 regression)")
			}
			if nack.GetOk() || nack.GetError() == "" || nack.GetClientScriptId() != 7 {
				t.Fatalf("nack = %+v, want ok=false with echoed client_script_id and reason", nack)
			}
			if rc.scriptSource[s.playerID] != "" {
				t.Fatal("inactive submit must not persist script source")
			}
		})
	}
	run("no match", false)
	run("ended match", true)
}

// TestInactiveScriptRollbackGetsNack（审计 S-30）：无 match 与 Ended 两分支的
// ScriptRollback 都必须收到 EvScriptRollbackResult nack。
func TestInactiveScriptRollbackGetsNack(t *testing.T) {
	run := func(name string, ended bool) {
		t.Run(name, func(t *testing.T) {
			h := NewHub()
			rc := h.EnsureRoom("NACKRB")
			s, log := bindLogged(t, h, rc, "pilot")
			if ended {
				inactiveMatch(t, h, rc, s)
			}
			log.take()
			s.ScriptRollback(&ombv1.ScriptRollback{VersionId: 3})
			var nack *ombv1.EvScriptRollbackResult
			for _, sm := range log.take() {
				if r := sm.msg.GetEvent().GetScriptRollbackResult(); r != nil {
					nack = r
				}
			}
			if nack == nil {
				t.Fatal("inactive rollback silently dropped (S-30 regression)")
			}
			if nack.GetOk() || nack.GetError() == "" {
				t.Fatalf("rollback nack = %+v, want ok=false with reason", nack)
			}
		})
	}
	run("no match", false)
	run("ended match", true)
}

// TestInactiveAiPromptGetsNotice（审计 S-30）：无 match 与 Ended 两分支的
// AiPrompt 都必须收到 CN_AI_REQUEST_FAILED notice + 同文兼容 say（成对、
// notice 在前——客户端 AI 面板据此终结 pending）。
func TestInactiveAiPromptGetsNotice(t *testing.T) {
	run := func(name string, ended bool) {
		t.Run(name, func(t *testing.T) {
			h := NewHub()
			rc := h.EnsureRoom("NACKAI")
			s, log := bindLogged(t, h, rc, "pilot")
			if ended {
				inactiveMatch(t, h, rc, s)
			}
			log.take()
			s.AiPrompt(&ombv1.AiPrompt{Text: "改稳一点"})
			msgs := log.take()
			if len(msgs) != 2 {
				t.Fatalf("got %d messages, want notice+say pair: %+v", len(msgs), msgs)
			}
			notice := msgs[0].msg.GetEvent().GetControlNotice()
			if notice == nil || notice.GetCode() != ombv1.EvControlNotice_CN_AI_REQUEST_FAILED || notice.GetText() == "" {
				t.Fatalf("first message is not an AI request-failed notice: %+v", msgs[0].msg)
			}
			if say := msgs[1].msg.GetEvent().GetSay(); say == nil || say.GetRobot() != 0 || say.GetText() != notice.GetText() {
				t.Fatalf("second message is not the same-text robot-0 say: %+v", msgs[1].msg)
			}
		})
	}
	run("no match", false)
	run("ended match", true)
}
