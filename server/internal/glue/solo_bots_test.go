package glue

import (
	"math"
	"os"
	"reflect"
	"testing"
	"time"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/script"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func TestSoloBotIdentityCapacity(t *testing.T) {
	for _, humans := range []int{1, 62, 64} {
		players := map[uint64]SessionInfo{}
		for i := 0; i < humans; i++ {
			pid := uint64(0xffff_ffff_ffff_f000) + uint64(i) // deliberately overlaps reserved candidates
			players[pid] = SessionInfo{PlayerID: pid, Nick: "human"}
		}
		addSoloBots(players, 100)
		want := min(64, humans+3)
		if len(players) != want {
			t.Fatalf("%d humans: got %d total, want %d", humans, len(players), want)
		}
		seen := map[uint32]bool{}
		bots := 0
		for pid, info := range players {
			rid := stableRobotID(pid)
			if rid == 0 || seen[rid] {
				t.Fatal("duplicate or zero robot ID")
			}
			seen[rid] = true
			if info.Bot {
				bots++
			} else if info.Nick != "human" {
				t.Fatal("human overwritten")
			}
		}
		if bots != want-humans {
			t.Fatal("incorrect synthetic count")
		}
	}
	a, b := map[uint64]SessionInfo{}, map[uint64]SessionInfo{}
	addSoloBots(a, 3)
	addSoloBots(b, 3)
	if !reflect.DeepEqual(a, b) {
		t.Fatal("synthetic identities are not stable")
	}
}

func TestSoloBotScriptIntents(t *testing.T) {
	rt := script.NewGojaRuntime(script.Config{TickTimeout: time.Second})
	defer rt.Close()
	if err := rt.Load(soloBotSource(3)); err != nil {
		t.Fatal(err)
	}
	frame := sim.ScriptFrame{
		Self: sim.RobotView{ID: 3, Pos: sim.Vec2{X: 40}, HpX10: 1000, EnergyX10: 1000},
		Obs:  sim.Observation{Frame: sim.FrameView{Phase: sim.PhaseOuterRing}},
	}
	run := func() sim.ScriptCommands {
		t.Helper()
		cmd, err := rt.Tick(frame)
		if err != nil {
			t.Fatal(err)
		}
		frame.Obs.Frame.Tick++
		return soloBotCommands(cmd)
	}
	frame.Obs.Cores = []sim.CoreView{{ID: 1, Pos: sim.Vec2{X: 50}, Alive: true}}
	if c := run(); c.Move.X <= 0 || *c.Fire || *c.Interact {
		t.Fatalf("expected core pursuit only: %+v", c)
	}
	frame.Obs.Robots = []sim.RobotView{{ID: 4, Pos: sim.Vec2{X: 42}, HpX10: 1000}}
	if c := run(); !*c.Fire || c.Aim == nil {
		t.Fatal("visible enemy not targeted")
	}
	frame.Obs.PartnerID = 4
	if c := run(); *c.Fire {
		t.Fatal("partner targeted or stale fire retained")
	}
	frame.Obs.PartnerID = 0
	frame.Obs.Robots = nil
	if c := run(); *c.Fire {
		t.Fatal("fire held after enemy vanished")
	}
	frame.Obs.Uplinks = []sim.UplinkView{{ID: 8, Pos: frame.Self.Pos, Active: true}}
	if c := run(); !*c.Interact || c.Move.Len() != 0 || *c.Fire {
		t.Fatal("bot did not stop and hack")
	}
	frame.Obs.Uplinks[0].HackingID = 3
	for i := 0; i < int(sim.HackDuration); i++ {
		if c := run(); !*c.Interact || c.Move.Len() != 0 {
			t.Fatalf("bot abandoned its own channel at tick %d", i)
		}
	}
	frame.Obs.Uplinks[0].HackingID = 0
	if c := run(); *c.Interact || c.Move.X <= 0 {
		t.Fatal("bot did not release completed Uplink during personal cooldown")
	}
	// A target across the locked center should produce a tangential route.
	frame.Obs.Uplinks = nil
	frame.Obs.Cores[0].Pos = sim.Vec2{X: -40}
	if c := run(); c.Move.Y <= 0 || c.Move.X != 0 {
		t.Fatalf("bot drives through locked center: %+v", *c.Move)
	}
	frame.Obs.Frame.Phase = sim.PhaseCoreOpen
	if c := run(); c.Move.X >= 0 || c.Move.Y != 0 {
		t.Fatal("bot cannot use newly opened inner region")
	}
}

func TestSoloBotsMatchControlsReplayAndScores(t *testing.T) {
	t.Chdir(t.TempDir())
	h := NewHub()
	rc := h.EnsureRoom("BOTLOG")
	s, _ := bindLogged(t, h, rc, "host")
	players := map[uint64]SessionInfo{s.playerID: {PlayerID: s.playerID, Nick: s.nick, Color: s.color}}
	addSoloBots(players, 3)
	m, err := NewMatch(rc, 42, 1, players, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.match = m // Drive manually, not by a wall-clock goroutine.
	for i := 0; i < 180; i++ {
		m.step()
	}
	if len(rc.identities) != 1 || len(rc.sessions) != 1 || rc.Room.StateBroadcast().RobotsOnline != 1 {
		t.Fatal("synthetic bots leaked into membership or online count")
	}
	if len(m.runtimes) != 3 || len(m.sim.Snapshot().Robots) != 4 {
		t.Fatal("bots not assembled")
	}
	for rid := range m.botRobots {
		r, _ := m.sim.Robot(rid)
		if !r.Control.Assist {
			t.Fatalf("bot %d has no explicit assist", rid)
		}
	}
	// Complete the final pending frame, without producing another pending script.
	m.sim.Tick()
	want := m.sim.Snapshot()
	m.finish(m.sim.WorldView())
	if rows := rc.Room.SessionScores(); len(rows) != 1 || rows[0].PlayerID != s.playerID {
		t.Fatalf("bot score leaked into cumulative room scores: %+v", rows)
	}
	stopTestMatch(t, m)
	f, err := os.Open("data/matches/BOTLOG-1.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	records, err := sim.ReadMatchEventLog(f)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) == 0 || records[0].State == nil {
		t.Fatal("missing replay bootstrap")
	}
	botControls := map[uint32]int{}
	for _, rec := range records {
		if rec.Type == "control" {
			if m.botRobots[rec.RobotID] && rec.Control.Script != nil {
				botControls[rec.RobotID]++
			}
		}
	}
	for rid := range m.botRobots {
		if botControls[rid] < 20 {
			t.Fatalf("bot %d has too few recorded commands: %d", rid, botControls[rid])
		}
	}
	if _, err := f.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	replayed, err := sim.ReplayTo(f, want.Tick, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(want, replayed.Snapshot()) {
		t.Fatal("recorded bot controls do not reproduce the exact simulation state")
	}
}

func TestSoloBotsHostToggleAndReconnect(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("BOTHOST")
	host, log := bindLogged(t, h, rc, "host")
	guest, _ := bindLogged(t, h, rc, "guest")
	guest.HostCommand(ombv1.RoomAction_SOLO_BOTS)
	if rc.Room.SoloBots() != 0 {
		t.Fatal("guest changed bot config")
	}
	host.HostCommand(ombv1.RoomAction_SOLO_BOTS)
	if rc.Room.SoloBots() != 3 {
		t.Fatal("protobuf action not routed to room")
	}
	broadcast := false
	for _, sent := range log.take() {
		if rs := sent.msg.GetEvent().GetRoomState(); rs != nil && rs.SoloBots == 3 && rs.RobotsOnline == 2 {
			broadcast = true
		}
	}
	if !broadcast {
		t.Fatal("config not broadcast with real membership count")
	}
	replacement, _ := bindLogged(t, h, rc, "host")
	host.HostCommand(ombv1.RoomAction_SOLO_BOTS)
	if rc.Room.SoloBots() != 3 {
		t.Fatal("stale session changed bot config")
	}
	replacement.HostCommand(ombv1.RoomAction_SOLO_BOTS)
	if rc.Room.SoloBots() != 0 {
		t.Fatal("restored host cannot change config")
	}
}

func TestSoloBotsCancelledAssemblyClosesRuntimes(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("BOTSTOP")
	players := map[uint64]SessionInfo{}
	addSoloBots(players, 3)
	m, err := NewMatch(rc, 42, 1, players, true)
	if err != nil {
		t.Fatal(err)
	}
	a := &asyncHandle{}
	rc.launch.Store(a)
	a.Abort()
	(&launcherAdapter{rc}).publish(a, m)
	stopTestMatch(t, m)
	if rc.currentMatch() != nil {
		t.Fatal("cancelled bot match published")
	}
	for rid, rt := range m.runtimes {
		if err := rt.Load(soloBotSource(rid)); err != script.ErrClosed {
			t.Fatalf("bot %d runtime not closed: %v", rid, err)
		}
	}
}

type soloBotEvents struct{ events []*ombv1.ServerEvent }

func (s *soloBotEvents) OnEvent(_ uint32, ev *ombv1.ServerEvent) { s.events = append(s.events, ev) }

func TestSoloBotActuallyCollectsCoreAndCompletesHack(t *testing.T) {
	const rid = uint32(4) // resource-first personality
	sink := &soloBotEvents{}
	world := sim.NewSim(42, []uint32{rid}, sink)
	def := &sim.MapDef{
		CoreZone:  sim.CoreZoneDef{Radius: 28, UnlockPhase: sim.PhaseCoreOpen},
		CorePads:  []sim.CorePadDef{{ID: 100, Pos: sim.Vec2{X: 44}, Group: 0, Value: 10}},
		Uplinks:   []sim.UplinkDef{{ID: 101, Pos: sim.Vec2{X: 50}, InteractR: 2.5, ActivePhase: sim.PhaseOuterRing}},
		CoreRules: sim.CoreRulesDef{PeriodTicks: 3600, GroupWeights: map[sim.Phase][]float64{sim.PhaseOuterRing: {1}, sim.PhaseCoreOpen: {1}}},
	}
	for i := range def.Sectors {
		def.Sectors[i] = sim.Sector{ID: uint32(i), Center: sim.Vec2{X: 40}, SpawnArea: sim.Rect{Min: sim.Vec2{X: 40}, Max: sim.Vec2{X: 40}}}
	}
	if err := world.SetMap(def); err != nil {
		t.Fatal(err)
	}
	world.AssistToggle(rid)
	rt := script.NewGojaRuntime(script.Config{TickTimeout: time.Second})
	defer rt.Close()
	if err := rt.Load(soloBotSource(rid)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 900; i++ {
		world.Tick()
		wv := world.WorldView()
		frame := sim.ScriptFrame{Self: wv.Robots[0], Obs: sim.Observation{Frame: wv.Frame, Cores: wv.Cores, Uplinks: wv.Uplinks}}
		cmd, err := rt.Tick(frame)
		if err != nil {
			t.Fatal(err)
		}
		world.ApplyScriptCommands(rid, soloBotCommands(cmd))
	}
	cores, hacks := 0, 0
	for _, ev := range sink.events {
		if ev.GetCorePickup() != nil {
			cores++
		}
		if ev.GetUplinkHack() != nil {
			hacks++
		}
	}
	if cores != 1 || hacks != 1 {
		t.Fatalf("actual objectives: %d cores, %d uplinks; robot=%+v", cores, hacks, world.Snapshot().Robots[0])
	}
}

// 主动避障：机器人与目标之间隔一堵墙时，不得持续朝墙直行；
// 必须选择切向绕行向量（与直行方向有显著夹角）。
func TestSoloBotSteersAroundWall(t *testing.T) {
	rt := script.NewGojaRuntime(script.Config{TickTimeout: time.Second})
	defer rt.Close()
	if err := rt.Load(soloBotSource(3)); err != nil {
		t.Fatal(err)
	}
	// 机器人位于 (0,-5)，目标核心在 (0,5)，中间横亘一堵墙 y∈[-1,1]。
	frame := sim.ScriptFrame{
		Self: sim.RobotView{ID: 3, Pos: sim.Vec2{X: 0, Y: -5}, HpX10: 1000, EnergyX10: 1000},
		Obs: sim.Observation{
			Frame: sim.FrameView{Phase: sim.PhaseOuterRing, Map: &sim.MapDef{
				Seed: 42,
				Walls: []sim.Wall{
					{ID: 1, Min: sim.Vec2{X: -8, Y: -1}, Max: sim.Vec2{X: 8, Y: 1}},
				},
			}},
			Cores: []sim.CoreView{{ID: 10, Pos: sim.Vec2{X: 0, Y: 5}, Alive: true}},
		},
	}
	run := func() sim.ScriptCommands {
		t.Helper()
		cmd, err := rt.Tick(frame)
		if err != nil {
			t.Fatal(err)
		}
		frame.Obs.Frame.Tick++
		return soloBotCommands(cmd)
	}
	first := run()
	if first.Move.Y > 0.5 {
		t.Fatalf("bot drives straight into wall: %+v", first.Move)
	}
	// 直行方向 (0,1) 与实际移动方向的夹角应显著（>30°），说明已绕行。
	ang := math.Atan2(first.Move.Y, first.Move.X)
	if math.Abs(ang-math.Pi/2) < 30*math.Pi/180 {
		t.Fatalf("no meaningful steering: %+v ang=%v", first.Move, ang)
	}
	// 持续行进不回退到直行顶墙：模拟多帧位置推进，方向始终有横向分量。
	pos := frame.Self.Pos
	for i := 0; i < 40; i++ {
		frame.Self.Pos = sim.Vec2{X: pos.X + first.Move.X*0.5*float64(i+1), Y: pos.Y + first.Move.Y*0.5*float64(i+1)}
		c := run()
		if c.Move.Len() == 0 {
			continue
		}
		// 越过墙的 y 区间前，不得出现几乎纯 +Y 的持续顶墙。
		if frame.Self.Pos.Y < -1.6 && c.Move.Y > 0.9 && math.Abs(c.Move.X) < 0.45 {
			t.Fatalf("bot reverts to head-on wall pushing at %v: %+v", frame.Self.Pos, c.Move)
		}
	}
}

// 锁区关闭时贴边绕行不因新增避障逻辑退化：无墙场景直行不受影响。
func TestSoloBotNoWallStillDirect(t *testing.T) {
	rt := script.NewGojaRuntime(script.Config{TickTimeout: time.Second})
	defer rt.Close()
	if err := rt.Load(soloBotSource(3)); err != nil {
		t.Fatal(err)
	}
	frame := sim.ScriptFrame{
		Self: sim.RobotView{ID: 3, Pos: sim.Vec2{X: 0, Y: 0}, HpX10: 1000, EnergyX10: 1000},
		Obs: sim.Observation{
			Frame: sim.FrameView{Phase: sim.PhaseCoreOpen, Map: &sim.MapDef{Seed: 42}},
			Cores: []sim.CoreView{{ID: 10, Pos: sim.Vec2{X: 30, Y: 0}, Alive: true}},
		},
	}
	cmd, err := rt.Tick(frame)
	if err != nil {
		t.Fatal(err)
	}
	c := soloBotCommands(cmd)
	if c.Move.X < 0.9 || math.Abs(c.Move.Y) > 0.1 {
		t.Fatalf("open-field direct movement regressed: %+v", c.Move)
	}
}
