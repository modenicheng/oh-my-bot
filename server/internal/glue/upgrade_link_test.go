package glue

import (
	"math"
	"testing"
	"time"

	"github.com/modenicheng/oh-my-bot/server/internal/nav"
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// upgradeLinkHarness 收集轮询期间排空的全部下发消息，供事后断言。
type upgradeLinkHarness struct {
	t    *testing.T
	log  *messageLog
	seen []sentMessage
}

func (h *upgradeLinkHarness) drain() []sentMessage {
	h.t.Helper()
	msgs := h.log.take()
	h.seen = append(h.seen, msgs...)
	return msgs
}

// selfUpgradeScan 软扫描（找不到不 Fatal）：最近一帧快照的 SelfState.upgrade。
func selfUpgradeScan(msgs []sentMessage) *ombv1.UpgradeSelf {
	for i := len(msgs) - 1; i >= 0; i-- {
		snap := msgs[i].msg.GetSnapshot()
		if snap == nil || snap.GetSelf() == nil {
			continue
		}
		return snap.GetSelf().GetUpgrade()
	}
	return nil
}

func (h *upgradeLinkHarness) awaitUpgrade(timeout time.Duration, cond func(*ombv1.UpgradeSelf) bool) *ombv1.UpgradeSelf {
	h.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if up := selfUpgradeScan(h.drain()); up != nil && cond(up) {
			return up
		}
		time.Sleep(12 * time.Millisecond)
	}
	h.t.Fatal("upgrade state condition not reached in time")
	return nil
}

// steerToPickCore 真实链路拾取：向最近存活 core 打满移动轴（RouteInput 锁安全；
// 世界读数走 WorldView 原子快照），等待快照出现点数。全程不触碰 m.step——
// 后台 run goroutine 已按 60Hz 驱动（与既有 glue 异步测试同一纪律）。
func (h *upgradeLinkHarness) steerToPickCore(m *Match, host *Session, rid uint32, budget time.Duration) {
	h.t.Helper()
	seq := uint32(0)
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		wv := m.sim.WorldView()
		var robot sim.RobotView
		for _, r := range wv.Robots {
			if r.ID == rid {
				robot = r
			}
		}
		var best sim.CoreView
		bestD := math.MaxFloat64
		for _, c := range wv.Cores {
			if !c.Alive {
				continue
			}
			if d := c.Pos.Sub(robot.Pos).Len(); d < bestD {
				bestD, best = d, c
			}
		}
		if best.ID != 0 {
			direction := nav.Direction(wv.Frame.Map, wv.Frame.Phase, robot.Pos, best.Pos)
			if direction.Len() > 0 {
				seq++
				host.RouteInput(&ombv1.ClientInput{Seq: seq, MoveX: int32(1000 * direction.X), MoveY: int32(1000 * direction.Y), AxisMask: uint32(sim.AxisMove)})
			}
		}
		if up := selfUpgradeScan(h.drain()); up != nil && up.GetPoints() >= sim.UpgradePointsCore {
			return
		}
		time.Sleep(12 * time.Millisecond)
	}
	h.t.Fatal("robot failed to pick a core in time")
}

// TestUpgradeFullLink：真实链路发布对局（后台 60Hz run goroutine）→ 操控拾取
// core 得点 → BuyUpgrade → 快照携带 SelfState.upgrade（购买成功/余额不足静默
// 拒绝）；SimTuning 曲线随 bootstrap 下发；RobotState 公开上限；观战快照无 self。
func TestUpgradeFullLink(t *testing.T) {
	t.Chdir(t.TempDir())
	h := NewHub()
	rc := h.EnsureRoom("UPG001")
	host, hostLog := bindLogged(t, h, rc, "host")
	m := startScoredMatchViaHost(t, h, rc, host)
	rid := m.robotOf[host.playerID]
	hn := &upgradeLinkHarness{t: t, log: hostLog}

	// bootstrap 携带升级曲线（50 项 costs/steps，与 sim 单源一致）。
	var boot *ombv1.UpgradeTuning
	deadline := time.Now().Add(5 * time.Second)
	for boot == nil && time.Now().Before(deadline) {
		for _, sent := range hn.drain() {
			if b := sent.msg.GetEvent().GetMapBootstrap(); b != nil {
				boot = b.GetTuning().GetUpgrade()
			}
		}
		if boot == nil {
			time.Sleep(8 * time.Millisecond)
		}
	}
	if boot == nil || len(boot.Costs) != sim.UpgradeTrackCount*sim.UpgradeMaxLevel || len(boot.StepsX10) != len(boot.Costs) {
		t.Fatalf("bootstrap upgrade tuning missing/truncated: %+v", boot)
	}
	if boot.Costs[0] != sim.UpgradeCosts[0] || boot.Costs[len(boot.Costs)-1] != sim.UpgradeCosts[sim.UpgradeMaxLevel-1] {
		t.Fatalf("upgrade costs drifted from sim: %v", boot.Costs)
	}

	// 真实拾取一只 core（普通 2 / Mega 5）。
	hn.steerToPickCore(m, host, rid, 20*time.Second)
	picked := hn.awaitUpgrade(2*time.Second, func(up *ombv1.UpgradeSelf) bool {
		return up.GetPoints() >= sim.UpgradePointsCore
	}).GetPoints()

	// 购买 hp L1（成本 2）：下一 tick 生效，点数扣减。
	host.BuyUpgrade(1)
	up := hn.awaitUpgrade(3*time.Second, func(up *ombv1.UpgradeSelf) bool {
		return len(up.GetLevels()) == sim.UpgradeTrackCount && up.GetLevels()[0] == 1 && up.GetPoints() == picked-2
	})
	// 公开上限：RobotState.max_hp_x10 = 1200（头顶条分母）已在轮询收集中出现。
	maxSeen := false
	for _, sent := range hn.seen {
		snap := sent.msg.GetSnapshot()
		if snap == nil {
			continue
		}
		for _, rs := range snap.GetRobots() {
			if rs.GetBase().GetId() == rid && rs.GetMaxHpX10() == sim.ToX10(120) {
				maxSeen = true
			}
		}
	}
	if !maxSeen {
		t.Fatalf("RobotState.max_hp_x10 not published after purchase: %+v", up)
	}

	// 连续买空到余额不足：静默拒绝（点数停在 0）。
	for i := 0; i < 12; i++ {
		host.BuyUpgrade(1)
	}
	hn.awaitUpgrade(3*time.Second, func(up *ombv1.UpgradeSelf) bool {
		return up.GetPoints() == 0 && up.GetLevels()[0] >= 1
	})
	// 非法轨号静默拒绝：点数/等级不再变化。
	host.BuyUpgrade(0)
	host.BuyUpgrade(6)
	time.Sleep(120 * time.Millisecond)
	if up = selfUpgradeScan(hn.drain()); up.GetPoints() != 0 {
		t.Fatalf("invalid track must not change points: %+v", up)
	}

	// 观战连接：快照永不携带 self（升级状态是玩家私有）。
	specLog := &messageLog{}
	spec := NewSession(specLog.send(true), specLog.send(false), nil)
	h.Register(spec)
	if err := rc.BindSpectator(spec); err != nil {
		t.Fatal(err)
	}
	specSeen := 0
	deadline = time.Now().Add(2 * time.Second)
	for specSeen < 3 && time.Now().Before(deadline) {
		for _, sent := range specLog.take() {
			snap := sent.msg.GetSnapshot()
			if snap == nil {
				continue
			}
			specSeen++
			if snap.GetSelf() != nil {
				t.Fatal("spectator snapshot must not carry self state")
			}
		}
		time.Sleep(12 * time.Millisecond)
	}
	if specSeen == 0 {
		t.Fatal("spectator received no snapshots")
	}
}
