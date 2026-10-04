package glue

import "testing"

func TestPlayerBotStateSurvivesMatchReplacementAndLeavesWithRoom(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("BOT-STATE")
	player, _ := bindLogged(t, h, rc, "pilot")
	source := `function tick(bot) { bot.move(1, 0) }`

	m1 := assembledTestMatch(t, rc, player)
	rc.mu.Lock()
	rc.match = m1
	ok, errMsg, _ := m1.submitScriptLocked(player.playerID, source)
	rc.mu.Unlock()
	if !ok || errMsg != "" {
		t.Fatalf("script submit = ok:%t err:%q", ok, errMsg)
	}
	player.ToggleAssist()
	m1.step()
	rc.mu.Lock()
	if rc.scriptSource[player.playerID] != source || !rc.assist[player.playerID] {
		rc.mu.Unlock()
		t.Fatalf("room bot state = source:%q assist:%t", rc.scriptSource[player.playerID], rc.assist[player.playerID])
	}
	rc.match = nil
	rc.mu.Unlock()
	stopTestMatch(t, m1)

	rc.mu.Lock()
	info := rc.identities[player.nick]
	info.ScriptSource = rc.scriptSource[player.playerID]
	info.Assist = rc.assist[player.playerID]
	rc.mu.Unlock()
	m2, err := NewMatch(rc, 77, 2, map[uint64]SessionInfo{player.playerID: info}, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m2) })
	rc.mu.Lock()
	rc.match = m2
	rid := m2.robotOf[player.playerID]
	rt := m2.scriptPool.RuntimeOf(rid)
	robot, _ := m2.sim.Robot(rid)
	rc.mu.Unlock()
	if rt == nil {
		t.Fatal("new match did not restore a runtime")
	}
	if rt.Source() != source {
		t.Fatalf("new match source = %q, want %q", rt.Source(), source)
	}
	if !robot.Control.Assist {
		t.Fatal("assist preference was not restored into the new match")
	}

	player.LeaveRoom()
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if _, ok := rc.scriptSource[player.playerID]; ok {
		t.Fatal("script source survived explicit room leave")
	}
	if _, ok := rc.assist[player.playerID]; ok {
		t.Fatal("assist preference survived explicit room leave")
	}
}

// A player whose first-ever script submit fails compilation must not leave a
// registered empty runtime behind (it would tick as ErrNoModule forever).
// A player with an already-loaded script keeps the old version on failure
// (Hot Swap semantics).
func TestFailedFirstScriptLoadLeavesNoRuntime(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("BADJS")
	player, _ := bindLogged(t, h, rc, "pilot")
	m := assembledTestMatch(t, rc, player)
	rc.mu.Lock()
	rc.match = m
	rc.mu.Unlock()
	rid := m.robotOf[player.playerID]

	// First submit with broken source: rejected, and no runtime registered.
	rc.mu.Lock()
	ok, errMsg, _ := m.submitScriptLocked(player.playerID, "function tick(ctx){ broken")
	rc.mu.Unlock()
	if ok || errMsg == "" {
		t.Fatalf("broken first submit accepted: ok=%t err=%q", ok, errMsg)
	}
	if rt := m.scriptPool.RuntimeOf(rid); rt != nil {
		t.Fatal("failed first load left an empty runtime registered")
	}
	if n := len(m.scriptPool.IDs()); n != 0 {
		t.Fatalf("pool holds %d runtimes after failed first load", n)
	}

	// A valid submit then registers and runs normally.
	rc.mu.Lock()
	ok, errMsg, _ = m.submitScriptLocked(player.playerID, "function tick(bot){}")
	rc.mu.Unlock()
	if !ok || errMsg != "" {
		t.Fatalf("valid submit rejected: ok=%t err=%q", ok, errMsg)
	}
	if m.scriptPool.RuntimeOf(rid) == nil {
		t.Fatal("valid submit did not register a runtime")
	}

	// A later broken submit keeps the loaded version registered (Hot Swap).
	rc.mu.Lock()
	ok, errMsg, _ = m.submitScriptLocked(player.playerID, "function tick(ctx){ still broken")
	rc.mu.Unlock()
	if ok || errMsg == "" {
		t.Fatalf("broken resubmit accepted: ok=%t err=%q", ok, errMsg)
	}
	if m.scriptPool.RuntimeOf(rid) == nil {
		t.Fatal("broken resubmit dropped the loaded runtime (must keep old version)")
	}
	m.step() // must not panic and must keep the runtime alive.
	if m.scriptPool.RuntimeOf(rid) == nil {
		t.Fatal("runtime dropped after step")
	}
}
