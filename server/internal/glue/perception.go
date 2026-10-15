package glue

import (
	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

func (match *Match) broadcastPerceivedEventLocked(event *ombv1.ServerEvent) {
	world := match.sim.WorldView()
	for playerID, session := range match.rc.sessions {
		robotID := match.robotOf[playerID]
		if start := event.GetMatchStart(); start != nil {
			session.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: &ombv1.ServerEvent{Tick: event.Tick, Kind: &ombv1.ServerEvent_MatchStart{MatchStart: &ombv1.EvMatchStart{Players: start.Players}}}}})
			continue
		}
		if eventPerceived(world, robotID, event) {
			session.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: event}})
		}
	}
	for _, session := range match.rc.spectators {
		session.SendReliable(&ombv1.ServerMsg{Payload: &ombv1.ServerMsg_Event{Event: event}})
	}
}

func eventPerceived(world sim.WorldView, observerID uint32, event *ombv1.ServerEvent) bool {
	if event.GetSay() != nil {
		return true
	}
	observer, found := robotOf(world, observerID)
	if !found {
		return false
	}
	positionVisible := func(position *ombv1.Vec2) bool {
		if position == nil {
			return false
		}
		point := sim.Vec2{X: position.X, Y: position.Y}
		return observer.Pos.Sub(point).Len() <= world.ScanRadius(observerID) && world.SurfaceVisible(observer.Pos, point)
	}
	robotVisible := func(robotID uint32) bool {
		if robotID == observerID {
			return true
		}
		robot, exists := robotOf(world, robotID)
		return exists && observer.Pos.Sub(robot.Pos).Len() <= world.ScanRadius(observerID) && world.LineOfSight(observer.Pos, robot.Pos)
	}
	switch payload := event.Kind.(type) {
	case *ombv1.ServerEvent_PhaseChange, *ombv1.ServerEvent_MatchEnd, *ombv1.ServerEvent_Scoreboard, *ombv1.ServerEvent_RoomState:
		return true
	case *ombv1.ServerEvent_AiUsage:
		return payload.AiUsage.Robot == observerID
	case *ombv1.ServerEvent_Shot:
		return positionVisible(payload.Shot.At)
	case *ombv1.ServerEvent_ProjectileImpact:
		return positionVisible(payload.ProjectileImpact.At)
	case *ombv1.ServerEvent_Kill:
		return positionVisible(payload.Kill.At)
	case *ombv1.ServerEvent_Heal:
		return positionVisible(payload.Heal.At)
	case *ombv1.ServerEvent_WallHit:
		return positionVisible(payload.WallHit.At)
	case *ombv1.ServerEvent_PointDropSpawn:
		return positionVisible(payload.PointDropSpawn.At)
	case *ombv1.ServerEvent_CorePickup:
		if payload.CorePickup.At != nil {
			return payload.CorePickup.By == observerID || positionVisible(payload.CorePickup.At)
		}
		return robotVisible(payload.CorePickup.By)
	case *ombv1.ServerEvent_PointDropPickup:
		if payload.PointDropPickup.At != nil {
			return payload.PointDropPickup.By == observerID || positionVisible(payload.PointDropPickup.At)
		}
		return robotVisible(payload.PointDropPickup.By)
	case *ombv1.ServerEvent_UplinkHack:
		if payload.UplinkHack.At != nil {
			return payload.UplinkHack.By == observerID || positionVisible(payload.UplinkHack.At)
		}
		return robotVisible(payload.UplinkHack.By)
	case *ombv1.ServerEvent_Respawn:
		return robotVisible(payload.Respawn.Robot)
	case *ombv1.ServerEvent_Say:
		return true
	case *ombv1.ServerEvent_Hit:
		return robotVisible(payload.Hit.To)
	case *ombv1.ServerEvent_ScriptError:
		return payload.ScriptError.Robot == observerID
	default:
		return false
	}
}
