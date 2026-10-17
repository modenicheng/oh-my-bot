package room

import (
	"testing"
)

type soloFakeLauncher struct {
	fakeLauncher
	botRosters []struct {
		players []uint64
		bots    uint32
	}
}

func (l *soloFakeLauncher) LaunchWithBots(seed uint64, playerIDs []uint64, botCount uint32) MatchHandle {
	l.botRosters = append(l.botRosters, struct {
		players []uint64
		bots    uint32
	}{players: append([]uint64(nil), playerIDs...), bots: botCount})
	return l.Launch(seed, playerIDs)
}

func (l *soloFakeLauncher) LaunchWarmupWithBots(seed uint64, playerIDs []uint64, botCount uint32) MatchHandle {
	return l.LaunchWithBots(seed, playerIDs, botCount)
}

func TestHostSpectatorDoesNotBecomeAPlayer(t *testing.T) {
	r := NewRoom("SPEC01", 0)
	if err := r.SetHostSpectator(42); err != nil {
		t.Fatal(err)
	}
	if !r.HostSpectator() || !r.IsHost(42) {
		t.Fatal("host spectator did not retain host control")
	}
	if r.MemberCount() != 0 || r.StateBroadcast().RobotsOnline != 0 || len(r.SessionScores()) != 0 {
		t.Fatal("host spectator occupied a player/session seat")
	}
	if err := r.Join(7, "player", "#fff"); err != nil {
		t.Fatal(err)
	}
	if r.MemberCount() != 1 || r.StateBroadcast().RobotsOnline != 1 {
		t.Fatal("normal player did not join spectator-host room")
	}
	if got := r.StateBroadcast().GetHostSpectator(); !got {
		t.Fatal("room state did not expose host spectator mode")
	}
}

func TestHostSpectatorEmptyRosterRequiresPlayerOrBot(t *testing.T) {
	r := NewRoom("SPEC02", 42)
	if err := r.SetHostSpectator(42); err != nil {
		t.Fatal(err)
	}
	launcher := &soloFakeLauncher{}
	r.SetSimLauncher(launcher)
	for _, action := range []Action{ActionStart, ActionWarmup} {
		if err := r.HostCommand(42, action); err != ErrNoPlayers {
			t.Fatalf("%s err = %v, want ErrNoPlayers", action, err)
		}
		if r.State() != Idle {
			t.Fatalf("%s changed state to %s", action, r.State())
		}
	}
	if err := r.HostCommand(42, ActionSoloBots); err != nil {
		t.Fatal(err)
	}
	r.SetSoloBots(1)
	if err := r.HostCommand(42, ActionStart); err != nil {
		t.Fatalf("solo Bot should make spectator-host launchable: %v", err)
	}
	if r.State() != Running || len(launcher.botRosters) != 1 || launcher.botRosters[0].bots != 1 {
		t.Fatalf("unexpected bot launch: state=%s rosters=%+v", r.State(), launcher.botRosters)
	}
}

func TestHostSpectatorCanBeExplicitlyReleased(t *testing.T) {
	r := NewRoom("SPEC03", 42)
	if err := r.SetHostSpectator(42); err != nil {
		t.Fatal(err)
	}
	if err := r.ReleaseHostSpectator(42); err != nil {
		t.Fatal(err)
	}
	if r.HostSpectator() || r.HostID() != 0 {
		t.Fatal("released host spectator retained host identity")
	}
}

func TestHostSpectatorDurationConfigClosesAtCreation(t *testing.T) {
	for _, configured := range []bool{false, true} {
		t.Run(map[bool]string{false: "defaults", true: "custom"}[configured], func(t *testing.T) {
			r := NewRoom("SPECDR", 0)
			var wantMatch, wantCore uint32
			if configured {
				wantMatch, wantCore = 10800, 3600
				if !r.SetDurationConfig(wantMatch, wantCore) {
					t.Fatal("creator's duration config rejected")
				}
			}
			if err := r.SetHostSpectator(42); err != nil {
				t.Fatal(err)
			}
			if r.SetDurationConfig(7200, 1800) {
				t.Fatal("later join could replace spectator host's duration config")
			}
			if match, core := r.DurationConfig(); match != wantMatch || core != wantCore {
				t.Fatalf("duration config = %d/%d, want %d/%d", match, core, wantMatch, wantCore)
			}
			if err := r.ReleaseHostSpectator(42); err != nil {
				t.Fatal(err)
			}
			if r.SetDurationConfig(7200, 1800) {
				t.Fatal("explicit leave reopened the creation window")
			}
		})
	}
}

func TestHostSpectatorLeaveTransfersHostAndReleasesNick(t *testing.T) {
	r := NewRoom("SPECLV", 0)
	if err := r.SetHostSpectator(42); err != nil {
		t.Fatal(err)
	}
	r.SetPendingNick(42, "host")
	for _, id := range []uint64{7, 8} {
		if err := r.Join(id, "player", "red"); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.ReleaseHostSpectator(7); err != ErrNotHost {
		t.Fatalf("non-host release = %v, want ErrNotHost", err)
	}
	if err := r.ReleaseHostSpectator(42); err != nil {
		t.Fatal(err)
	}
	if r.HostID() != 7 || r.HostSpectator() || r.MemberCount() != 2 {
		t.Fatal("host leave did not transfer control to the first seated player")
	}
	if _, retained := r.pendingNicks[42]; retained {
		t.Fatal("explicit host leave retained nickname metadata")
	}
}

func TestHostSpectatorEmptyEndedRosterRejectsAllLaunches(t *testing.T) {
	r := NewRoom("SPECEN", 0)
	if err := r.SetHostSpectator(42); err != nil {
		t.Fatal(err)
	}
	l := &soloFakeLauncher{}
	r.SetSimLauncher(l)
	r.SetSoloBots(1)
	if err := r.HostCommand(42, ActionStart); err != nil {
		t.Fatal(err)
	}
	if err := r.HostCommand(42, ActionAbort); err != nil {
		t.Fatal(err)
	}
	r.SetSoloBots(0)
	seed, seq, launches := r.Seed(), r.SessionSeq(), l.launchCount()
	for _, action := range []Action{ActionStart, ActionWarmup, ActionRestart} {
		if err := r.HostCommand(42, action); err != ErrNoPlayers {
			t.Fatalf("%s = %v, want ErrNoPlayers", action, err)
		}
		if r.State() != Ended || r.Seed() != seed || r.SessionSeq() != seq || l.launchCount() != launches {
			t.Fatalf("%s mutated an empty ended room", action)
		}
	}
}
