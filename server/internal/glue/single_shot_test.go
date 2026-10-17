package glue

import (
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func latestShotGeneration(t *testing.T, messages []sentMessage) uint32 {
	t.Helper()
	var generation uint32
	for _, message := range messages {
		if boot := message.msg.GetEvent().GetMapBootstrap(); boot != nil {
			if !boot.DiscreteShotSupported {
				t.Fatal("no discrete-shot capability")
			}
			generation = boot.Generation
		}
		if self := message.msg.GetSnapshot().GetSelf(); self != nil && self.InputGeneration != nil {
			generation = *self.InputGeneration
		}
	}
	if generation == 0 {
		t.Fatal("no owner generation")
	}
	return generation
}

func TestSingleShotOwnerOnlyAndAdmissionRejection(t *testing.T) {
	h, rc, owner, ownerLog, m := spectatorMatch(t, true)
	peer, peerLog := bindLogged(t, h, rc, "peer")
	_ = peer
	_, spectatorLog := bindSpectator(t, h, rc)
	r, _ := m.sim.Robot(m.robotOf[owner.playerID])
	in := &ombv1.ClientInput{Seq: 10, SingleShot: &ombv1.SingleShot{Aim: 1, ObservedTick: m.tick, Generation: r.SingleShots.Generation}}
	m.ApplyClientInput(owner.playerID, in)
	m.step()
	results := 0
	for _, sent := range ownerLog.take() {
		if result := sent.msg.GetEvent().GetSingleShotResult(); result != nil {
			if !sent.reliable || result.Seq != 10 || result.Robot != r.ID || result.Outcome != "fired" {
				t.Fatalf("bad terminal result: %v", result)
			}
			results++
		}
	}
	if results != 1 {
		t.Fatalf("owner received %d results", results)
	}
	for _, log := range []*messageLog{peerLog, spectatorLog} {
		for _, sent := range log.take() {
			if sent.msg.GetEvent().GetSingleShotResult() != nil {
				t.Fatal("private result leaked")
			}
		}
	}
	m.ApplyClientInput(owner.playerID, in)
	if messages := ownerLog.take(); len(messages) != 0 {
		t.Fatal("completed accepted request received conflicting duplicate terminal")
	}
	// An unknown old request remains an actual sequence rejection.
	in.Seq = 9
	m.ApplyClientInput(owner.playerID, in)
	found := false
	for _, sent := range ownerLog.take() {
		if result := sent.msg.GetEvent().GetSingleShotResult(); result != nil {
			found = result.Seq == 9 && result.Outcome == "sequence"
		}
	}
	if !found {
		t.Fatal("no correlated admission rejection")
	}
}

func TestSingleShotPendingDuplicateDoesNotRaceOriginalTerminal(t *testing.T) {
	_, _, owner, log, m := spectatorMatch(t, true)
	r, _ := m.sim.Robot(m.robotOf[owner.playerID])
	in := &ombv1.ClientInput{Seq: 10, SingleShot: &ombv1.SingleShot{Aim: 1, ObservedTick: m.tick, Generation: r.SingleShots.Generation}}
	m.ApplyClientInput(owner.playerID, in)
	m.ApplyClientInput(owner.playerID, in)
	if messages := log.take(); len(messages) != 0 {
		t.Fatal("pending duplicate produced premature terminal")
	}
	m.step()
	results := 0
	for _, sent := range log.take() {
		if result := sent.msg.GetEvent().GetSingleShotResult(); result != nil {
			if result.Seq != 10 || result.Outcome != "fired" {
				t.Fatalf("conflicting result: %v", result)
			}
			results++
		}
	}
	if results != 1 {
		t.Fatalf("results=%d, want one original terminal", results)
	}
}

func TestSingleShotEvictedDuplicateHasNoConflictingTerminal(t *testing.T) {
	_, _, owner, log, m := spectatorMatch(t, true)
	rid := m.robotOf[owner.playerID]
	r, _ := m.sim.Robot(rid)
	generation := r.SingleShots.Generation
	for seq := uint32(100); seq <= 132; seq++ {
		m.ApplyClientInput(owner.playerID, &ombv1.ClientInput{Seq: seq, SingleShot: &ombv1.SingleShot{Aim: 1, ObservedTick: m.tick, Generation: generation}})
		m.step()
	}
	fired := false
	for _, sent := range log.take() {
		if result := sent.msg.GetEvent().GetSingleShotResult(); result != nil && result.Seq == 100 {
			if result.Outcome != "fired" {
				t.Fatalf("initial seq 100 outcome: %s", result.Outcome)
			}
			fired = true
		}
	}
	if !fired {
		t.Fatal("initial seq 100 never fired")
	}
	before := m.sim.Snapshot().NextProjectile
	m.ApplyClientInput(owner.playerID, &ombv1.ClientInput{Seq: 100, SingleShot: &ombv1.SingleShot{Aim: 1, ObservedTick: m.tick, Generation: generation}})
	for _, sent := range log.take() {
		if result := sent.msg.GetEvent().GetSingleShotResult(); result != nil {
			t.Fatalf("evicted duplicate emitted conflicting terminal: %v", result)
		}
	}
	r, _ = m.sim.Robot(rid)
	if m.sim.Snapshot().NextProjectile != before || len(r.SingleShots.Pending) != 0 || r.LatestSeq != 132 {
		t.Fatal("old request mutated shot/input state")
	}
	// An unknown old sequence still inside the feedback horizon is rejected.
	m.ApplyClientInput(owner.playerID, &ombv1.ClientInput{Seq: 134})
	m.ApplyClientInput(owner.playerID, &ombv1.ClientInput{Seq: 133, SingleShot: &ombv1.SingleShot{Aim: 1, ObservedTick: m.tick, Generation: generation}})
	found := false
	for _, sent := range log.take() {
		if result := sent.msg.GetEvent().GetSingleShotResult(); result != nil {
			found = result.Seq == 133 && result.Outcome == "sequence"
		}
	}
	if !found {
		t.Fatal("recent unknown old sequence lost rejection")
	}
}

func TestSingleShotGenerationLifecycleSnapshotsWithoutMapReload(t *testing.T) {
	_, rc, owner, log, m := spectatorMatch(t, true)
	rid := m.robotOf[owner.playerID]
	rc.mu.Lock()
	m.bootstrapLocked(owner)
	rc.mu.Unlock()
	first := latestShotGeneration(t, log.take())
	m.step()
	log.take()
	m.ApplyClientInput(owner.playerID, &ombv1.ClientInput{Seq: 20, SingleShot: &ombv1.SingleShot{Aim: 0, ObservedTick: m.tick, Generation: first}})
	rc.mu.Lock()
	m.releaseHumanLocked(owner.playerID)
	m.bootstrapLocked(owner)
	rc.mu.Unlock()
	second := latestShotGeneration(t, log.take())
	if first == second {
		t.Fatal("connection generation reused")
	}
	m.step()
	for _, sent := range log.take() {
		if result := sent.msg.GetEvent().GetSingleShotResult(); result != nil && result.Outcome == "fired" {
			t.Fatal("disconnect retained pending shot")
		}
	}
	m.sim.Respawn(rid)
	m.step()
	messages := log.take()
	third := latestShotGeneration(t, messages)
	if third == second {
		t.Fatal("respawn generation reused")
	}
	for _, sent := range messages {
		if sent.msg.GetEvent().GetMapBootstrap() != nil {
			t.Fatal("respawn reloaded map")
		}
	}
	// Resync clears the lane and advertises a fresh generation in SelfState.
	m.ForceResync(owner.playerID)
	m.step()
	fourth := latestShotGeneration(t, log.take())
	if third == fourth {
		t.Fatal("full resync generation reused")
	}
	players := map[uint64]SessionInfo{owner.playerID: {PlayerID: owner.playerID, Nick: owner.nick}}
	replacement, err := NewMatch(rc, 42, 2, players, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, replacement) })
	rc.mu.Lock()
	rc.match = replacement
	replacement.bootstrapLocked(owner)
	rc.mu.Unlock()
	if fifth := latestShotGeneration(t, log.take()); fifth <= fourth {
		t.Fatal("replacement match generation reused")
	}
}

func TestSingleShotCannotRetryNotReadySequence(t *testing.T) {
	_, rc, owner, log, m := spectatorMatch(t, true)
	rc.mu.Lock()
	m.bootstrapLocked(owner)
	rc.mu.Unlock()
	generation := latestShotGeneration(t, log.take())
	in := &ombv1.ClientInput{Seq: 99, SingleShot: &ombv1.SingleShot{Generation: generation, ObservedTick: m.tick}}
	m.ApplyClientInput(owner.playerID, in)
	m.step()
	log.take()
	in.SingleShot.ObservedTick = m.tick
	m.ApplyClientInput(owner.playerID, in)
	m.step()
	for _, sent := range log.take() {
		if result := sent.msg.GetEvent().GetSingleShotResult(); result != nil && result.Outcome == "fired" {
			t.Fatal("not-ready rejection retried")
		}
	}
}
