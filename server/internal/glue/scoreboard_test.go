package glue

import (
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/stats"
)

// 收集一次消息流里的全部 EvScoreboard 事件（含 tick）。
func scoreboardEvents(msgs []sentMessage) []*ombv1.EvScoreboard {
	var out []*ombv1.EvScoreboard
	for _, m := range msgs {
		if ev := m.msg.GetEvent().GetScoreboard(); ev != nil {
			out = append(out, ev)
		}
	}
	return out
}

// bindSpectatorLogged 绑定一个记录消息的观战者会话。
func bindSpectatorLogged(t *testing.T, h *Hub, rc *RoomConn) (*Session, *messageLog) {
	t.Helper()
	l := &messageLog{}
	s := NewSession(l.send(true), l.send(false))
	h.Register(s)
	if err := rc.BindSpectator(s); err != nil {
		t.Fatal(err)
	}
	return s, l
}

// TestScoreboardEventOfConvertsLiveRows 校验 stats.ScoreRow → 协议 ScoreRow 的转换：
// 顺序保持（服务器已按分数降序），分数与 robot id 原样透传。
func TestScoreboardEventOfConvertsLiveRows(t *testing.T) {
	rows := []stats.ScoreRow{
		{RobotID: 7, PlayerID: 1001, Nick: "甲", Score: 61},
		{RobotID: 3, PlayerID: 1002, Nick: "乙", Score: 25},
	}
	ev := scoreboardEventOf(1234, rows)
	if ev == nil || ev.GetScoreboard() == nil {
		t.Fatalf("missing scoreboard payload: %+v", ev)
	}
	sb := ev.GetScoreboard()
	if sb.Tick != 1234 || len(sb.Rows) != 2 {
		t.Fatalf("unexpected event: %+v", sb)
	}
	for i, want := range rows {
		got := sb.Rows[i]
		if got.Robot != want.RobotID || got.Score != int32(want.Score) {
			t.Fatalf("row %d mismatch: got=%+v want=%+v", i, got, want)
		}
		if len(got.Titles) != 0 {
			t.Fatalf("live scoreboard must not carry titles: %+v", got)
		}
	}
}

// TestScoreboardFingerprintDetectsChange 指纹应能区分榜位与分数变化，忽略昵称等不影响排序的因素。
func TestScoreboardFingerprintDetectsChange(t *testing.T) {
	base := []stats.ScoreRow{{RobotID: 1, Score: 30}, {RobotID: 2, Score: 10}}
	if scoreboardFingerprint(base) != scoreboardFingerprint([]stats.ScoreRow{{RobotID: 1, Score: 30}, {RobotID: 2, Score: 10}}) {
		t.Fatal("fingerprint not deterministic for equal content")
	}
	if scoreboardFingerprint(base) == scoreboardFingerprint([]stats.ScoreRow{{RobotID: 2, Score: 10}, {RobotID: 1, Score: 30}}) {
		t.Fatal("fingerprint ignores order change")
	}
	if scoreboardFingerprint(base) == scoreboardFingerprint([]stats.ScoreRow{{RobotID: 1, Score: 31}, {RobotID: 2, Score: 10}}) {
		t.Fatal("fingerprint ignores score change")
	}
	// 昵称/PlayerID 变化不影响指纹：榜的展示由客户端拼，服务器只重发榜序与分数。
	same := []stats.ScoreRow{{RobotID: 1, PlayerID: 9, Nick: "新昵称", Score: 30}, {RobotID: 2, PlayerID: 8, Nick: "乙", Score: 10}}
	if scoreboardFingerprint(base) != scoreboardFingerprint(same) {
		t.Fatal("fingerprint should not depend on nick/player id")
	}
}

// TestMatchBroadcastsScoreboardDuringPlay 正式局内驱动若干 tick 后，玩家与观战者都应收到
// 至少一拍实时积分榜；随后在榜未变化、未到下一间隔时不得重复刷屏。
func TestMatchBroadcastsScoreboardDuringPlay(t *testing.T) {
	t.Chdir(t.TempDir())
	h := NewHub()
	rc := h.EnsureRoom("SCOREBOARD")
	pilot, pilotLog := bindLogged(t, h, rc, "pilot")
	spec, specLog := bindSpectatorLogged(t, h, rc)
	_ = spec // 观战者只需存在并收包，无需后续交互

	players := map[uint64]SessionInfo{pilot.playerID: {PlayerID: pilot.playerID, Nick: pilot.nick, Color: pilot.color}}
	m, err := NewMatch(rc, 42, 1, players, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.mu.Lock()
	rc.match = m
	rc.mu.Unlock()

	// 直接驱动 step 到首个广播点（tick 0 后即首拍；step 自取 rc.mu）。
	m.step()

	got := scoreboardEvents(pilotLog.take())
	if len(got) == 0 {
		t.Fatal("player received no scoreboard event after first step")
	}
	if got[0].Tick != m.tick && got[len(got)-1].Tick != m.tick {
		t.Fatalf("scoreboard tick stale: got=%v matchTick=%d", got, m.tick)
	}
	rows := got[len(got)-1].Rows
	if len(rows) == 0 || rows[0].Robot != m.robotOf[pilot.playerID] {
		t.Fatalf("scoreboard rows missing pilot: %+v robotOf=%v", rows, m.robotOf)
	}
	if specGot := scoreboardEvents(specLog.take()); len(specGot) == 0 {
		t.Fatal("spectator received no scoreboard event")
	}

	// 未到 2s 间隔且榜未变化：不应再发。
	before := m.tick
	m.step()
	if again := scoreboardEvents(pilotLog.take()); len(again) != 0 {
		t.Fatalf("scoreboard spammed without change: before=%d after=%d events=%d", before, m.tick, len(again))
	}
}

// TestScoreboardCatchUpOnResync 重连与观战者中途接入都应立刻补发最近一拍积分榜，而不是空榜等待。
func TestScoreboardCatchUpOnResync(t *testing.T) {
	t.Chdir(t.TempDir())
	h := NewHub()
	rc := h.EnsureRoom("SCORECATCHUP")
	pilot, pilotLog := bindLogged(t, h, rc, "pilot")

	players := map[uint64]SessionInfo{pilot.playerID: {PlayerID: pilot.playerID, Nick: pilot.nick, Color: pilot.color}}
	m, err := NewMatch(rc, 42, 1, players, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.mu.Lock()
	rc.match = m
	rc.mu.Unlock()

	m.step() // 触发首拍（step 自取 rc.mu）
	pilotLog.take()
	rc.mu.Lock()
	m.forceResyncLocked(pilot.playerID)
	rc.mu.Unlock()
	if got := scoreboardEvents(pilotLog.take()); len(got) != 1 {
		t.Fatalf("resync did not replay exactly one scoreboard: %d", len(got))
	}

	// 中途接入的观战者：bootstrap 应补发一拍。
	spec, specLog := bindSpectatorLogged(t, h, rc)
	rc.mu.Lock()
	m.bootstrapSpectatorLocked(spec)
	rc.mu.Unlock()
	if got := scoreboardEvents(specLog.take()); len(got) == 0 {
		t.Fatal("spectator bootstrap missed scoreboard catch-up")
	}
}
