package glue

import (
	"encoding/hex"
	"testing"

	"google.golang.org/protobuf/proto"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// 跨语言黄金字节（审计 X-3）：simTuning 必须与客户端兜底值
// （client/src/game/tuning.ts FALLBACK_TUNING_HEX）逐字节一致。
// 两侧任何一边改数值都会使另一边的「服务器↔客户端兜底」漂移假设失效并失败。
const simTuningGoldenHex = "083c10d00f18d00f21000000000000144028e00330f001390000000000003440"

func TestSimTuningGoldenBytes(t *testing.T) {
	b, err := proto.Marshal(simTuning())
	if err != nil {
		t.Fatal(err)
	}
	got := hex.EncodeToString(b)
	if got != simTuningGoldenHex {
		t.Fatalf("SimTuning golden mismatch:\n got %s\nwant %s", got, simTuningGoldenHex)
	}
}

// TestSimTuningMirrorsSimConstants 把下发值钉在 sim 常量上：改 sim 常量必须同步
// 重算 golden（客户端兜底随之更新），防止「服务器改了、下发还是旧值」的静默漂移。
func TestSimTuningMirrorsSimConstants(t *testing.T) {
	tun := simTuning()
	if tun.TickRate != uint32(sim.TickRate) ||
		tun.MaxHpX10 != sim.ToX10(sim.MaxHP) ||
		tun.MaxEnergyX10 != sim.ToX10(sim.MaxEnergy) ||
		tun.FireCost != sim.FireCost ||
		tun.HackDurationTicks != sim.HackDuration ||
		tun.InvulnDurationTicks != sim.InvulnDuration ||
		tun.VisionRadius != sim.VisionRadius {
		t.Fatalf("simTuning drifted from sim constants: %+v", tun)
	}
}

// TestMapBootstrapCarriesTuning：bootstrap 事件必须携带 tuning（X-3 主链路）。
func TestMapBootstrapCarriesTuning(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("TUNE")
	s, log := bindLogged(t, h, rc, "pilot")
	m, err := NewMatch(rc, 42, 1, map[uint64]SessionInfo{s.playerID: {PlayerID: s.playerID, Nick: s.nick, Color: s.color}}, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.mu.Lock()
	m.bootstrapLocked(s)
	rc.mu.Unlock()
	for _, sm := range log.take() {
		boot := sm.msg.GetEvent().GetMapBootstrap()
		if boot == nil {
			continue
		}
		if boot.GetTuning() == nil {
			t.Fatal("map bootstrap missing SimTuning")
		}
		b, err := proto.Marshal(boot.GetTuning())
		if err != nil {
			t.Fatal(err)
		}
		if got := hex.EncodeToString(b); got != simTuningGoldenHex {
			t.Fatalf("bootstrap tuning mismatch: %s", got)
		}
		return
	}
	t.Fatal("no map bootstrap event received")
}

// TestControlNoticePairOrder（审计 X-4）：notice 必须先于兼容 say 到达，且同文。
// 客户端 dedupeControlNoticeSay 依赖此顺序。此处用 aiNotice 验证成对下发序；
// join 拒绝的成对序在 cmd/omb（system_say_test.go / spectate_test.go）同样钉死。
func TestControlNoticePairOrder(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("NOTICE")
	l := &messageLog{}
	s := NewSession(l.send(true), l.send(false))
	h.Register(s)
	rc.mu.Lock()
	aiNotice(s, ombv1.EvControlNotice_CN_AI_REQUEST_FAILED, "AI 请求失败：x")
	rc.mu.Unlock()
	msgs := l.take()
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want notice+say pair", len(msgs))
	}
	notice := msgs[0].msg.GetEvent().GetControlNotice()
	if notice == nil || notice.GetCode() != ombv1.EvControlNotice_CN_AI_REQUEST_FAILED || notice.GetText() != "AI 请求失败：x" {
		t.Fatalf("first message is not an AI notice: %+v", msgs[0].msg)
	}
	sayMsg := msgs[1].msg.GetEvent().GetSay()
	if sayMsg == nil || sayMsg.GetRobot() != 0 || sayMsg.GetText() != "AI 请求失败：x" {
		t.Fatalf("second message is not a same-text robot-0 say: %+v", msgs[1].msg)
	}
}

// TestAiNoticeCodes：AI 桥接的每条路径都映射到正确的结构化 code（与客户端
// AI_NOTICE_CODES 集合互钉；文案前缀由旧路径兼容测试覆盖）。
func TestAiNoticeCodes(t *testing.T) {
	cases := []struct {
		code ombv1.EvControlNotice_Code
		text string
	}{
		{ombv1.EvControlNotice_CN_AI_REQUEST_FAILED, "AI 请求失败：上游限流，请稍后再试"},
		{ombv1.EvControlNotice_CN_AI_DISABLED, "AI 未启用：服务器未配置 DEEPSEEK_API_KEY"},
		{ombv1.EvControlNotice_CN_AI_COMPILE_FAILED, "AI 生成脚本编译失败，已丢弃（旧脚本继续运行）：line 3"},
		{ombv1.EvControlNotice_CN_AI_STALE_SCRIPT, "AI 改码未生效：脚本已被手动更新，AI 结果丢弃"},
		{ombv1.EvControlNotice_CN_AI_EXPLAIN, "AI 改动说明：已把血量阈值改为 50"},
	}
	h := NewHub()
	rc := h.EnsureRoom("AICODE")
	l := &messageLog{}
	s := NewSession(l.send(true), l.send(false))
	h.Register(s)
	rc.mu.Lock()
	for _, c := range cases {
		aiNotice(s, c.code, c.text)
	}
	rc.mu.Unlock()
	msgs := l.take()
	if len(msgs) != len(cases)*2 {
		t.Fatalf("got %d messages, want %d notice+say pairs", len(msgs), len(cases)*2)
	}
	for i, c := range cases {
		notice := msgs[i*2].msg.GetEvent().GetControlNotice()
		if notice == nil || notice.GetCode() != c.code || notice.GetText() != c.text {
			t.Fatalf("pair %d: notice mismatch: %+v", i, msgs[i*2].msg)
		}
		say := msgs[i*2+1].msg.GetEvent().GetSay()
		if say == nil || say.GetText() != c.text {
			t.Fatalf("pair %d: compatible say text mismatch: %+v", i, msgs[i*2+1].msg)
		}
	}
}
