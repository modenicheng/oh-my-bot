package glue

import (
	"testing"
)

// S-27 发布路径回归：HostCommand 冻结花名册 ids 与 NewMatch 异步 publish 之间
// 存在装配窗口——窗口内完成 Bind 的会话是房间成员，但不在本轮花名册
// （robotOf）。publish 若对其无差别 bootstrap，客户端收到 MapBootstrap 后
// 进入 awaitingFull，而快照循环只服务花名册机器人，该会话将永远等不到
// 第一帧（表现为卡「正在同步对局…」，无任何报错，直到下一局发布）。
// Bind 路径已有同款花名册守卫；本测试钉住 publish 路径不得漏。
func TestPublishDoesNotBootstrapSessionsOutsideRoster(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("WINDOW")
	host, hostLog := bindLogged(t, h, rc, "host")
	// 模拟装配窗口内进房的第二会话：已 Bind（房间成员），但 ids 在其进房
	// 前冻结，装配出的花名册只有 host。
	window, windowLog := bindLogged(t, h, rc, "window")
	m := assembledTestMatch(t, rc, host)
	a := &asyncHandle{}
	rc.launch.Store(a)
	(&launcherAdapter{rc}).publish(a, m)

	bootstraps := 0
	for _, msg := range hostLog.take() {
		if msg.msg.GetEvent().GetMapBootstrap() != nil {
			bootstraps++
		}
	}
	if bootstraps != 1 {
		t.Fatalf("roster host must get exactly one bootstrap, got %d", bootstraps)
	}
	for _, msg := range windowLog.take() {
		if msg.msg.GetEvent().GetMapBootstrap() != nil {
			t.Fatal("publish bootstrapped a session outside the roster — client would hang awaiting its first frame")
		}
	}
	_ = window
}
