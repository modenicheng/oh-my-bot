package snapshot

import (
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// BuildSpectatorObservation builds the read-only live spectator feed: every
// robot, projectile, core and uplink, ignoring AOI radii and wall occlusion.
// There is no observer robot, so nothing may fall back to a (0,0) center.
// Uplink PersonalCDs are stripped entirely — per-robot cooldowns are private
// state and must never leak to spectators.
func BuildSpectatorObservation(w World) sim.Observation {
	obs := sim.Observation{
		Frame:       w.FrameView,
		Robots:      append([]sim.RobotView(nil), w.Robots...),
		Projectiles: append([]sim.ProjView(nil), w.Projectiles...),
		Cores:       append([]sim.CoreView(nil), w.Cores...),
	}
	for _, u := range w.Uplinks {
		cu := u
		cu.PersonalCDs = nil
		obs.Uplinks = append(obs.Uplinks, cu)
	}
	return obs
}
