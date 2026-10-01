package glue

import (
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/script"
)

// sendScriptLogsLocked drains one robot's private script console and sends it
// only to that robot owner's currently bound session. The caller holds rc.mu.
// Logs are never broadcast, copied to spectators, or appended to MatchEventLog.
func (m *Match) sendScriptLogsLocked(robotID uint32, rt *script.GojaRuntime) {
	logs := rt.DrainLogs()
	if len(logs) == 0 {
		return
	}
	playerID, ok := m.playerOf[robotID]
	if !ok {
		return
	}
	session := m.rc.sessions[playerID]
	if session == nil || session.SendReliable == nil {
		return
	}
	currentRevision := rt.Rev()
	for _, entry := range logs {
		// A hot swap resets the runtime buffer; this guard also prevents a late
		// worker result from replaying output from an obsolete revision.
		if entry.Revision != currentRevision {
			continue
		}
		event := &ombv1.ServerEvent{
			Tick: entry.Tick,
			Kind: &ombv1.ServerEvent_ScriptLog{ScriptLog: &ombv1.EvScriptLog{
				RobotId: robotID, ScriptRev: entry.Revision, Tick: entry.Tick,
				Level: entry.Level, Text: entry.Text, Truncated: entry.Truncated,
			}},
		}
		session.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: event}})
	}
}
