package room

import (
	"errors"
	"fmt"
	"sync"
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

// --- test doubles -------------------------------------------------------

type fakeHandle struct {
	abortOnce sync.Once
	aborted   chan struct{}
}

func newFakeHandle() *fakeHandle {
	return &fakeHandle{aborted: make(chan struct{})}
}

func (h *fakeHandle) Abort() {
	h.abortOnce.Do(func() { close(h.aborted) })
}

type fakeLauncher struct {
	mu       sync.Mutex
	launches int
	seeds    []uint64
	rosters  [][]uint64
	handles  []*fakeHandle
}

func newFakeLauncher() *fakeLauncher {
	return &fakeLauncher{}
}

func (l *fakeLauncher) Launch(seed uint64, playerIDs []uint64) MatchHandle {
	l.mu.Lock()
	defer l.mu.Unlock()
	roster := make([]uint64, len(playerIDs))
	copy(roster, playerIDs)
	h := newFakeHandle()
	l.launches++
	l.seeds = append(l.seeds, seed)
	l.rosters = append(l.rosters, roster)
	l.handles = append(l.handles, h)
	return h
}

func (l *fakeLauncher) LaunchWarmup(seed uint64, playerIDs []uint64) MatchHandle {
	return l.Launch(seed, playerIDs)
}

func (l *fakeLauncher) launchCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.launches
}

func newTestRoom(t *testing.T) (*Room, *fakeLauncher) {
	t.Helper()
	r := NewRoom("ABC234", 1)
	l := newFakeLauncher()
	r.SetSimLauncher(l)
	if err := r.Join(1, "host", "#ff0000"); err != nil {
		t.Fatalf("host join: %v", err)
	}
	return r, l
}

// --- room code ----------------------------------------------------------

func TestGenerateCodeFormat(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 500; i++ {
		c := GenerateCode()
		if len(c) != 6 {
			t.Fatalf("code %q: want 6 chars, got %d", c, len(c))
		}
		for _, ch := range c {
			switch ch {
			case '0', 'O', '1', 'I':
				t.Fatalf("code %q contains confusable %q", c, ch)
			}
			isValid := (ch >= 'A' && ch <= 'Z') || (ch >= '2' && ch <= '9')
			if !isValid {
				t.Fatalf("code %q contains invalid char %q", c, ch)
			}
		}
		seen[c] = true
	}
	if len(seen) < 100 {
		t.Fatalf("expected mostly unique codes over 500 draws, got %d unique", len(seen))
	}
}

// --- membership ---------------------------------------------------------

func TestJoinLeave(t *testing.T) {
	r, _ := newTestRoom(t)

	if err := r.Join(2, "alice", "#00ff00"); err != nil {
		t.Fatalf("join: %v", err)
	}
	if r.MemberCount() != 2 {
		t.Fatalf("count = %d, want 2", r.MemberCount())
	}
	if err := r.Join(2, "alice", "#00ff00"); err != ErrAlreadyJoined {
		t.Fatalf("duplicate join err = %v, want ErrAlreadyJoined", err)
	}
	if err := r.Leave(2); err != nil {
		t.Fatalf("leave: %v", err)
	}
	if r.MemberCount() != 1 {
		t.Fatalf("count = %d, want 1", r.MemberCount())
	}
	if err := r.Leave(2); err != ErrNotMember {
		t.Fatalf("leave non-member err = %v, want ErrNotMember", err)
	}
	if err := r.Leave(99); err != ErrNotMember {
		t.Fatalf("leave stranger err = %v, want ErrNotMember", err)
	}
}

func TestJoinCap64(t *testing.T) {
	r, _ := newTestRoom(t) // player 1 already seated
	for id := uint64(2); id <= 64; id++ {
		if err := r.Join(id, fmt.Sprintf("p%d", id), "#000000"); err != nil {
			t.Fatalf("join %d: %v", id, err)
		}
	}
	if r.MemberCount() != 64 {
		t.Fatalf("count = %d, want 64", r.MemberCount())
	}
	if err := r.Join(65, "overflow", "#ffffff"); err != ErrRoomFull {
		t.Fatalf("65th join err = %v, want ErrRoomFull", err)
	}
	if r.MemberCount() != 64 {
		t.Fatalf("count changed after rejected join: %d", r.MemberCount())
	}
	// Leaving frees the seat again.
	if err := r.Leave(30); err != nil {
		t.Fatalf("leave: %v", err)
	}
	if err := r.Join(65, "backfill", "#ffffff"); err != nil {
		t.Fatalf("join after leave: %v", err)
	}
}

// --- legal transitions --------------------------------------------------

func TestLegalTransitions(t *testing.T) {
	t.Run("idle_to_warmup_to_running_to_ended_via_abort", func(t *testing.T) {
		r, l := newTestRoom(t)
		mustAction(t, r, 1, ActionWarmup)
		if r.State() != Warmup {
			t.Fatalf("state = %v, want Warmup", r.State())
		}
		mustAction(t, r, 1, ActionStart)
		if r.State() != Running {
			t.Fatalf("state = %v, want Running", r.State())
		}
		select {
		case <-l.handles[0].aborted:
		default:
			t.Error("START left the warmup loop alive")
		}
		if l.launches != 2 { // warmup 实例 + 正式赛各 launch 一次
			t.Fatalf("launches = %d, want 2 (warmup + start)", l.launches)
		}
		mustAction(t, r, 1, ActionAbort)
		if r.State() != Ended {
			t.Fatalf("state = %v, want Ended", r.State())
		}
		select {
		case <-l.handles[len(l.handles)-1].aborted: // 正式赛是最新实例
		default:
			t.Fatal("abort did not reach the match handle")
		}
	})

	t.Run("idle_straight_to_running_single_player", func(t *testing.T) {
		r, l := newTestRoom(t)
		mustAction(t, r, 1, ActionStart) // Idle → Running allowed
		if r.State() != Running {
			t.Fatalf("state = %v, want Running", r.State())
		}
		if l.launches != 1 {
			t.Fatalf("launches = %d, want 1", l.launches)
		}
		r.EndMatch() // natural end
		if r.State() != Ended {
			t.Fatalf("state = %v, want Ended", r.State())
		}
	})

	t.Run("ended_restart_back_to_warmup_then_next_match", func(t *testing.T) {
		r, l := newTestRoom(t)
		mustAction(t, r, 1, ActionWarmup)
		mustAction(t, r, 1, ActionStart)
		r.EndMatch()
		mustAction(t, r, 1, ActionRestart) // Ended → Warmup
		if r.State() != Warmup {
			t.Fatalf("state = %v, want Warmup", r.State())
		}
		mustAction(t, r, 1, ActionStart)
		if r.State() != Running {
			t.Fatalf("state = %v, want Running", r.State())
		}
		if l.launches != 4 { // warmup + start + restart-warmup + start
			t.Fatalf("launches = %d, want 4", l.launches)
		}
		if l.seeds[0] == l.seeds[1] {
			t.Fatal("two matches reused the same seed")
		}
		if r.Seed() != l.seeds[len(l.seeds)-1] {
			t.Fatalf("Seed() = %d, want latest %d", r.Seed(), l.seeds[len(l.seeds)-1])
		}
		if r.SessionSeq() != 2 {
			t.Fatalf("SessionSeq = %d, want 2", r.SessionSeq())
		}
	})

	t.Run("ended_warmup_directly", func(t *testing.T) {
		r, _ := newTestRoom(t)
		mustAction(t, r, 1, ActionStart)
		mustAction(t, r, 1, ActionAbort)
		mustAction(t, r, 1, ActionWarmup) // Ended → Warmup also via WARMUP
		if r.State() != Warmup {
			t.Fatalf("state = %v, want Warmup", r.State())
		}
	})
}

// --- illegal transitions ------------------------------------------------

func TestIllegalTransitions(t *testing.T) {
	cases := []struct {
		name   string
		setup  func(r *Room)
		action Action
	}{
		{"abort_from_idle", func(r *Room) {}, ActionAbort},
		{"abort_from_warmup", func(r *Room) { mustAction(t, r, 1, ActionWarmup) }, ActionAbort},
		{"abort_from_ended", func(r *Room) {
			mustAction(t, r, 1, ActionStart)
			mustAction(t, r, 1, ActionAbort)
		}, ActionAbort},
		{"restart_from_idle", func(r *Room) {}, ActionRestart},
		{"restart_from_warmup", func(r *Room) { mustAction(t, r, 1, ActionWarmup) }, ActionRestart},
		{"restart_from_running", func(r *Room) { mustAction(t, r, 1, ActionStart) }, ActionRestart},
		{"warmup_from_running", func(r *Room) { mustAction(t, r, 1, ActionStart) }, ActionWarmup},
		{"start_from_running", func(r *Room) { mustAction(t, r, 1, ActionStart) }, ActionStart},
		{"start_from_ended", func(r *Room) {
			mustAction(t, r, 1, ActionStart)
			r.EndMatch()
		}, ActionStart},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, _ := newTestRoom(t)
			tc.setup(r)
			before := r.State()
			err := r.HostCommand(1, tc.action)
			if err == nil {
				t.Fatalf("%s from %v: accepted, want rejection", tc.action, before)
			}
			if r.State() != before {
				t.Fatalf("state changed on rejected command: %v → %v", before, r.State())
			}
		})
	}
}

func TestStartWithNoPlayersRejected(t *testing.T) {
	r := NewRoom("ABC234", 1)
	r.SetSimLauncher(newFakeLauncher())
	if err := r.HostCommand(1, ActionStart); err != ErrNoPlayers {
		t.Fatalf("err = %v, want ErrNoPlayers", err)
	}
}

func TestStartWithoutLauncherRejected(t *testing.T) {
	r := NewRoom("ABC234", 1)
	if err := r.Join(1, "host", "#ff0000"); err != nil {
		t.Fatal(err)
	}
	if err := r.HostCommand(1, ActionStart); err != ErrNoLauncher {
		t.Fatalf("err = %v, want ErrNoLauncher", err)
	}
	if r.State() != Idle {
		t.Fatalf("state = %v, want Idle", r.State())
	}
}

// All three launch actions share prepareLaunchLocked; the error precedence
// (players → launcher → solo-bots capability) and the no-mutation guarantee
// must hold for every one of them.
func TestLaunchPreparationErrorPrecedence(t *testing.T) {
	t.Run("no_players_before_no_launcher", func(t *testing.T) {
		// Members absent but launcher configured: the players check wins over
		// a nil launcher for the actions reachable without members. (RESTART
		// cannot reach this branch in practice: when the last member leaves,
		// hostship resets to 0 and ErrNotHost fires first — preserved behavior.)
		r := NewRoom("ABC234", 1)
		r.SetSimLauncher(nil) // both failures reachable; players must win
		for _, a := range []Action{ActionWarmup, ActionStart} {
			err := r.HostCommand(1, a)
			if !errors.Is(err, ErrNoPlayers) {
				t.Fatalf("%s err = %v, want ErrNoPlayers", a, err)
			}
		}
	})

	t.Run("launcher_check_before_solo_bots_capability", func(t *testing.T) {
		r, _ := newTestRoom(t) // launcher set, 1 member
		r.SetSimLauncher(nil)
		// Enable solo bots so both failure modes are reachable.
		if err := r.HostCommand(1, ActionSoloBots); err != nil {
			t.Fatal(err)
		}
		for _, a := range []Action{ActionWarmup, ActionStart} {
			if err := r.HostCommand(1, a); err != ErrNoLauncher {
				t.Fatalf("%s err = %v, want ErrNoLauncher", a, err)
			}
		}
		if r.State() != Idle {
			t.Fatalf("state = %v, want Idle", r.State())
		}
	})

	t.Run("solo_bots_capability_across_all_launch_actions", func(t *testing.T) {
		for _, a := range []Action{ActionWarmup, ActionStart, ActionRestart} {
			t.Run(a.String(), func(t *testing.T) {
				r, launcher := newTestRoom(t)
				if a == ActionRestart {
					// Reach Ended with solo bots off (a plain launcher cannot
					// launch with bots on), then re-enable them for RESTART.
					mustAction(t, r, 1, ActionStart)
					r.EndMatch()
				}
				if err := r.HostCommand(1, ActionSoloBots); err != nil {
					t.Fatal(err)
				}
				before, launches := r.State(), launcher.launchCount()
				if err := r.HostCommand(1, a); err != ErrNoSoloBots {
					t.Fatalf("err = %v, want ErrNoSoloBots", err)
				}
				if r.State() != before || launcher.launchCount() != launches {
					t.Fatal("failed launch mutated room state")
				}
			})
		}
	})
}

// --- host permission ----------------------------------------------------

func TestNonHostCommandsRejected(t *testing.T) {
	r, l := newTestRoom(t)
	if err := r.Join(2, "guest", "#00ff00"); err != nil {
		t.Fatal(err)
	}
	for _, a := range []Action{ActionStart, ActionAbort, ActionRestart, ActionWarmup} {
		if err := r.HostCommand(2, a); err != ErrNotHost {
			t.Fatalf("guest %s err = %v, want ErrNotHost", a, err)
		}
	}
	if err := r.HostCommand(999, ActionStart); err != ErrNotHost {
		t.Fatalf("stranger Start err = %v, want ErrNotHost", err)
	}
	if r.State() != Idle {
		t.Fatalf("state = %v, want Idle (no guest command took effect)", r.State())
	}
	if l.launches != 0 {
		t.Fatalf("launches = %d, want 0", l.launches)
	}
	if !r.IsHost(1) || r.IsHost(2) {
		t.Fatal("IsHost broken")
	}
}

// --- seed & roster passed to launcher -----------------------------------

func TestStartPassesSeedAndRoster(t *testing.T) {
	r, l := newTestRoom(t)
	for id := uint64(2); id <= 5; id++ {
		if err := r.Join(id, fmt.Sprintf("p%d", id), "#000000"); err != nil {
			t.Fatal(err)
		}
	}
	mustAction(t, r, 1, ActionStart)

	if l.launches != 1 {
		t.Fatalf("launches = %d, want 1", l.launches)
	}
	seed := l.seeds[0]
	if seed == 0 {
		t.Fatal("seed = 0; crypto/rand should practically never yield 0")
	}
	if r.Seed() != seed {
		t.Fatalf("Seed() = %d, want %d", r.Seed(), seed)
	}
	want := []uint64{1, 2, 3, 4, 5}
	got := l.rosters[0]
	if len(got) != len(want) {
		t.Fatalf("roster len = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("roster = %v, want %v", got, want)
		}
	}
}

func TestAbortIsIdempotentOnHandle(t *testing.T) {
	r, l := newTestRoom(t)
	mustAction(t, r, 1, ActionStart)
	mustAction(t, r, 1, ActionAbort)
	// Second abort attempt is an illegal transition at the room level...
	if err := r.HostCommand(1, ActionAbort); err == nil {
		t.Fatal("double abort accepted")
	}
	// ...and the handle itself only fired once.
	select {
	case <-l.handles[0].aborted:
	default:
		t.Fatal("handle was never aborted")
	}
}

// --- session scores -----------------------------------------------------

func TestSessionScoresAccumulate(t *testing.T) {
	r, _ := newTestRoom(t)
	if err := r.Join(2, "bob", "#00ff00"); err != nil {
		t.Fatal(err)
	}
	if err := r.Join(3, "carol", "#0000ff"); err != nil {
		t.Fatal(err)
	}

	r.AddMatchResult(map[uint64]int32{1: 25, 2: 10, 3: 0})
	r.AddMatchResult(map[uint64]int32{2: 15, 3: 40, 1: -5})

	rows := r.SessionScores()
	// sorted: carol 40, bob 25, host 20
	if len(rows) != 3 {
		t.Fatalf("rows = %d, want 3", len(rows))
	}
	if rows[0].PlayerID != 3 || rows[0].Score != 40 || rows[0].Nick != "carol" {
		t.Fatalf("rows[0] = %+v, want carol/40", rows[0])
	}
	if rows[1].PlayerID != 2 || rows[1].Score != 25 {
		t.Fatalf("rows[1] = %+v, want bob/25", rows[1])
	}
	if rows[2].PlayerID != 1 || rows[2].Score != 20 {
		t.Fatalf("rows[2] = %+v, want host/20", rows[2])
	}

	// Left players keep their points on the board.
	if err := r.Leave(3); err != nil {
		t.Fatal(err)
	}
	rows = r.SessionScores()
	if len(rows) != 3 || rows[0].PlayerID != 3 {
		t.Fatalf("left player lost from session board: %+v", rows)
	}
}

func TestSessionScoresTieStable(t *testing.T) {
	r, _ := newTestRoom(t)
	r.AddMatchResult(map[uint64]int32{7: 10, 3: 10, 5: 10})
	rows := r.SessionScores()
	wantOrder := []uint64{3, 5, 7}
	for i, id := range wantOrder {
		if rows[i].PlayerID != id {
			t.Fatalf("rows[%d].PlayerID = %d, want %d (tie must break by id asc)", i, rows[i].PlayerID, id)
		}
	}
}

// --- broadcast ----------------------------------------------------------

func TestStateBroadcast(t *testing.T) {
	r, _ := newTestRoom(t)
	if err := r.Join(2, "bob", "#00ff00"); err != nil {
		t.Fatal(err)
	}

	ev := r.StateBroadcast()
	if ev.State != ombv1.EvRoomState_R_IDLE {
		t.Fatalf("state = %v, want R_IDLE", ev.State)
	}
	if ev.RobotsOnline != 2 {
		t.Fatalf("robots_online = %d, want 2", ev.RobotsOnline)
	}
	if ev.HostNick != "host" {
		t.Fatalf("host_nick = %q, want %q", ev.HostNick, "host")
	}

	mustAction(t, r, 1, ActionWarmup)
	ev = r.StateBroadcast()
	if ev.State != ombv1.EvRoomState_R_WARMUP {
		t.Fatalf("state = %v, want R_WARMUP", ev.State)
	}

	mustAction(t, r, 1, ActionStart)
	ev = r.StateBroadcast()
	if ev.State != ombv1.EvRoomState_R_RUNNING {
		t.Fatalf("state = %v, want R_RUNNING", ev.State)
	}

	mustAction(t, r, 1, ActionAbort)
	ev = r.StateBroadcast()
	if ev.State != ombv1.EvRoomState_R_ENDED {
		t.Fatalf("state = %v, want R_ENDED", ev.State)
	}
}

// --- concurrency --------------------------------------------------------

func TestConcurrentJoinLeave(t *testing.T) {
	r, _ := newTestRoom(t)
	const workers = 16
	const perWorker = 200

	var wg sync.WaitGroup
	errCh := make(chan error, workers*perWorker)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				id := uint64(2 + (w*perWorker+i)%(workers*perWorker)) // collides across workers
				if err := r.Join(id, "n", "#000000"); err != nil && err != ErrAlreadyJoined && err != ErrRoomFull {
					errCh <- fmt.Errorf("join %d: %w", id, err)
					return
				}
				r.StateBroadcast()
				r.SessionScores()
				if err := r.Leave(id); err != nil && err != ErrNotMember {
					errCh <- fmt.Errorf("leave %d: %w", id, err)
					return
				}
			}
		}(w)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatal(err)
	}
	if n := r.MemberCount(); n < 1 || n > MaxPlayers {
		t.Fatalf("member count %d out of range", n)
	}
}

func TestConcurrentCommandsAndBroadcast(t *testing.T) {
	r, l := newTestRoom(t)
	if err := r.Join(2, "bob", "#00ff00"); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	stop := make(chan struct{})

	// Broadcast and score readers hammering concurrently.
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					r.StateBroadcast()
					r.SessionScores()
					r.State()
					r.MemberCount()
				}
			}
		}()
	}

	// Host driving the full lifecycle round-trip repeatedly: each round is
	// Warmup → Start → Abort → Restart, which lands back in Warmup, so the
	// next round can begin with Start (Warmup → Running).
	done := make(chan struct{})
	var driverErr error
	go func() {
		defer close(done)
		for i := 0; i < 200; i++ {
			if err := r.HostCommand(1, ActionStart); err != nil {
				driverErr = fmt.Errorf("round %d Start: %w", i, err)
				return
			}
			if err := r.HostCommand(1, ActionAbort); err != nil {
				driverErr = fmt.Errorf("round %d Abort: %w", i, err)
				return
			}
			if err := r.HostCommand(1, ActionRestart); err != nil {
				driverErr = fmt.Errorf("round %d Restart: %w", i, err)
				return
			}
		}
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			_ = r.HostCommand(2, ActionStart) // must always fail, never panic
			r.AddMatchResult(map[uint64]int32{1: 1})
		}
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			_ = r.Join(100, "stranger", "#111111")
			_ = r.Leave(100)
		}
	}()

	<-done
	if driverErr != nil {
		t.Error(driverErr)
	}
	close(stop)
	wg.Wait()

	if r.State() != Warmup {
		t.Fatalf("final state = %v, want Warmup", r.State())
	}
	if l.launches != 400 {
		t.Fatalf("launches = %d, want 400 (warmup+start pairs)", l.launches)
	}
}

// --- helpers ------------------------------------------------------------

func mustAction(t *testing.T, r *Room, playerID uint64, a Action) {
	t.Helper()
	if err := r.HostCommand(playerID, a); err != nil {
		t.Fatalf("host %s: %v", a, err)
	}
}

// soloLauncher preserves the base launcher contract while recording the optional
// next-match bot configuration independently from real seated players.
type soloLauncher struct {
	*fakeLauncher
	counts  []uint32
	warmups []bool
}

func (l *soloLauncher) LaunchWithBots(seed uint64, ids []uint64, count uint32) MatchHandle {
	l.counts = append(l.counts, count)
	l.warmups = append(l.warmups, false)
	return l.Launch(seed, ids)
}
func (l *soloLauncher) LaunchWarmupWithBots(seed uint64, ids []uint64, count uint32) MatchHandle {
	l.counts = append(l.counts, count)
	l.warmups = append(l.warmups, true)
	return l.Launch(seed, ids)
}

func TestSoloBotsNextLaunchConfiguration(t *testing.T) {
	r, base := newTestRoom(t)
	launcher := &soloLauncher{fakeLauncher: base}
	r.SetSimLauncher(launcher)
	if err := r.HostCommand(2, ActionSoloBots); err != ErrNotHost {
		t.Fatalf("guest: %v", err)
	}
	if err := r.HostCommand(1, ActionSoloBots); err != nil {
		t.Fatal(err)
	}
	if rs := r.StateBroadcast(); rs.SoloBots != MaxSoloBots || rs.RobotsOnline != 1 {
		t.Fatalf("state: %+v", rs)
	}
	if err := r.HostCommand(1, ActionWarmup); err != nil {
		t.Fatal(err)
	}
	if len(launcher.counts) != 1 || launcher.counts[0] != MaxSoloBots || !launcher.warmups[0] {
		t.Fatal("warmup lost config")
	}
	warm := base.handles[0]
	// Changing configuration in warmup never mutates the active simulation.
	if err := r.HostCommand(1, ActionSoloBots); err != nil {
		t.Fatal(err)
	}
	if base.launchCount() != 1 {
		t.Fatal("toggle relaunched active warmup")
	}
	select {
	case <-warm.aborted:
		t.Fatal("toggle aborted warmup")
	default:
	}
	if err := r.HostCommand(1, ActionStart); err != nil {
		t.Fatal(err)
	}
	if len(launcher.counts) != 1 {
		t.Fatal("disabled bots still launched")
	}
	if err := r.HostCommand(1, ActionSoloBots); err == nil {
		t.Fatal("changed configuration during running match")
	}
	if err := r.HostCommand(1, ActionAbort); err != nil {
		t.Fatal(err)
	}
	if err := r.HostCommand(1, ActionSoloBots); err != nil {
		t.Fatal(err)
	}
	if err := r.HostCommand(1, ActionRestart); err != nil {
		t.Fatal(err)
	}
	if err := r.HostCommand(1, ActionStart); err != nil {
		t.Fatal(err)
	}
	if len(launcher.counts) != 3 || !launcher.warmups[1] || launcher.warmups[2] {
		t.Fatal("restart/formal launch lost config")
	}
	for _, roster := range base.rosters {
		if len(roster) != 1 || roster[0] != 1 {
			t.Fatalf("synthetic bot leaked into member roster: %v", roster)
		}
	}
}

func TestUnsupportedSoloBotsKeepStateAndHandle(t *testing.T) {
	for _, action := range []Action{ActionWarmup, ActionStart, ActionRestart} {
		t.Run(action.String(), func(t *testing.T) {
			r, launcher := newTestRoom(t)
			if action == ActionStart {
				if err := r.HostCommand(1, ActionWarmup); err != nil {
					t.Fatal(err)
				}
			}
			if action == ActionRestart {
				if err := r.HostCommand(1, ActionStart); err != nil {
					t.Fatal(err)
				}
				if err := r.HostCommand(1, ActionAbort); err != nil {
					t.Fatal(err)
				}
			}
			before, launches, handle := r.State(), launcher.launchCount(), r.match
			if err := r.HostCommand(1, ActionSoloBots); err != nil {
				t.Fatal(err)
			}
			if err := r.HostCommand(1, action); err != ErrNoSoloBots {
				t.Fatalf("got %v", err)
			}
			if r.State() != before || r.match != handle || launcher.launchCount() != launches {
				t.Fatal("failed launch mutated room state")
			}
			if action == ActionStart {
				select {
				case <-launcher.handles[0].aborted:
					t.Fatal("failed launch aborted live warmup")
				default:
				}
			}
		})
	}
}
