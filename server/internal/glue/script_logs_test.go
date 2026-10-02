package glue

import (
	"testing"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
)

func scriptLogsOf(messages []sentMessage) []*ombv1.EvScriptLog {
	var logs []*ombv1.EvScriptLog
	for _, sent := range messages {
		if event := sent.msg.GetEvent(); event != nil && event.GetScriptLog() != nil {
			logs = append(logs, event.GetScriptLog())
		}
	}
	return logs
}

func TestScriptConsoleIsOwnerOnlyAcrossLoadAndTick(t *testing.T) {
	h := NewHub()
	rc := h.EnsureRoom("LOGS")
	owner, ownerMessages := bindLogged(t, h, rc, "owner")
	opponent, opponentMessages := bindLogged(t, h, rc, "opponent")

	players := map[uint64]SessionInfo{
		owner.playerID:    {PlayerID: owner.playerID, Nick: owner.nick, Color: owner.color},
		opponent.playerID: {PlayerID: opponent.playerID, Nick: opponent.nick, Color: opponent.color},
	}
	m, err := NewMatch(rc, 42, 1, players, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopTestMatch(t, m) })
	rc.mu.Lock()
	rc.match = m
	rc.mu.Unlock()

	_, spectatorMessages := bindSpectator(t, h, rc)
	ownerMessages.take()
	opponentMessages.take()
	spectatorMessages.take()

	owner.SubmitScript(&ombv1.ScriptSubmit{
		ClientScriptId: 7,
		Source:         `console.info("loaded"); function tick(bot) { console.warn("tick", bot.self.id); bot.move(1, 0); }`,
	})

	loadLogs := scriptLogsOf(ownerMessages.take())
	if len(loadLogs) != 1 || loadLogs[0].GetText() != "loaded" || loadLogs[0].GetScriptRev() != 1 {
		t.Fatalf("owner load log mismatch: %+v", loadLogs)
	}
	if got := scriptLogsOf(opponentMessages.take()); len(got) != 0 {
		t.Fatalf("opponent received private load logs: %+v", got)
	}
	if got := scriptLogsOf(spectatorMessages.take()); len(got) != 0 {
		t.Fatalf("spectator received private load logs: %+v", got)
	}

	m.step()
	tickLogs := scriptLogsOf(ownerMessages.take())
	if len(tickLogs) != 1 {
		t.Fatalf("owner tick logs: %+v", tickLogs)
	}
	log := tickLogs[0]
	if log.GetRobotId() != m.robotOf[owner.playerID] || log.GetScriptRev() != 1 || log.GetTick() == 0 || log.GetLevel() != "warn" {
		t.Fatalf("tick log metadata mismatch: %+v", log)
	}
	if got := scriptLogsOf(opponentMessages.take()); len(got) != 0 {
		t.Fatalf("opponent received private tick logs: %+v", got)
	}
	if got := scriptLogsOf(spectatorMessages.take()); len(got) != 0 {
		t.Fatalf("spectator received private tick logs: %+v", got)
	}
}
