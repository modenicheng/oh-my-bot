package glue

import (
	"fmt"

	"github.com/modenicheng/oh-my-bot/server/internal/room"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// Synthetic identities live only in the match, never in RoomConn.identities or
// sessions. Keep the existing 64-robot cap when humans fill the room.
func addSoloBots(players map[uint64]SessionInfo, count uint32) {
	if count > 3 {
		count = 3
	}
	used := make(map[uint32]bool, len(players))
	for pid := range players {
		used[stableRobotID(pid)] = true
	}
	candidate := uint64(0xffff_ffff_ffff_f000)
	colors := [...]string{"#a3e635", "#fbbf24", "#f472b6"}
	for i := uint32(0); i < count && len(players) < room.MaxPlayers; {
		pid := candidate
		candidate++
		rid := stableRobotID(pid)
		if _, exists := players[pid]; exists || rid == 0 || used[rid] {
			continue
		}
		players[pid] = SessionInfo{PlayerID: pid, Nick: fmt.Sprintf("TEST-BOT-%d", i+1), Color: colors[i], Bot: true}
		used[rid] = true
		i++
	}
}

// Player scripts deliberately retain omitted axes. Built-in opponents instead
// send complete intents each frame, so a vanished enemy cannot leave fire held
// and leaving an Uplink cannot leave interact held.
func soloBotCommands(cmd sim.ScriptCommands) sim.ScriptCommands {
	if cmd.Move == nil {
		cmd.Move = new(sim.Vec2)
	}
	if cmd.Fire == nil {
		cmd.Fire = new(bool)
	}
	if cmd.Dash == nil {
		cmd.Dash = new(bool)
	}
	if cmd.Shield == nil {
		cmd.Shield = new(bool)
	}
	if cmd.Interact == nil {
		cmd.Interact = new(bool)
	}
	return cmd
}

// No network, wall clock or random input: target choice depends only on the
// observer's ordinary script API and stable robot identity. Resolved commands
// (including timeouts) are recorded by the existing gameplay replay sink.
func soloBotSource(id uint32) string {
	return fmt.Sprintf("const botID = %d, personality = %d;\n", id, id%3) + `
let last = null, stuck = 0, escapeUntil = 0, held = 0;
const cooldowns = {};
function tick(ctx) {
  const api = ctx.api, p = ctx.self.position, now = ctx.game.time;
  const scan = ctx.scan();
  const dist = q => Math.hypot(q.x - p.x, q.y - p.y);
  const unlocked = ctx.game.phase === "CORE_OPEN";
  const reachable = q => unlocked || Math.hypot(q.x, q.y) > 29;
  const enemy = api.nearestEnemy();
  if (held && !scan.uplinks.some(u => u.id === held && u.holder === botID)) {
    cooldowns[held] = now + 30; held = 0;
  }

  // Interact only when stopped at an available Uplink; picking up Cores is
  // automatic. Rotate objective preference so all three bots do not pile up.
  const uplinks = scan.uplinks.filter(u => (u.ready || u.holder === botID) && reachable(u) && !(cooldowns[u.id] > now)).sort((a,b) => dist(a)-dist(b));
  const cores = scan.cores.filter(reachable).sort((a,b) => dist(a)-dist(b));
  const uplink = uplinks[0];
  const preferUplink = personality === 0 || Math.floor(now / 20) % 3 === personality;
  if (uplink && dist(uplink) < 1.5) {
    if (uplink.holder === botID) held = uplink.id;
    api.move(0,0); api.interact(); last = null; stuck = 0; return;
  }
  if (enemy && ctx.self.energy > 20) { api.aimAt(enemy); api.fire(); }
  let target = (preferUplink && uplink) || cores[0] || uplink || (enemy && enemy.position);
  if (!target) {
    const angle = now / 12 + personality * 2.094;
    target = {x: 48 * Math.cos(angle), y: 48 * Math.sin(angle)};
  }
  let dx = target.x-p.x, dy = target.y-p.y;
  // Route around the locked disk rather than continually driving into it.
  const length2 = dx*dx+dy*dy;
  const t = length2 ? Math.max(0, Math.min(1, -(p.x*dx+p.y*dy)/length2)) : 0;
  if (!unlocked && Math.hypot(p.x+t*dx, p.y+t*dy) < 30) {
    const r = Math.hypot(p.x,p.y), sign = personality === 1 ? -1 : 1;
    const outward = Math.max(0, 34-r);
    dx = -p.y*sign + p.x*outward; dy = p.x*sign + p.y*outward;
  }
  if (last && Math.hypot(p.x-last.x,p.y-last.y) < 0.015) stuck++; else stuck = 0;
  if (stuck > 20) { escapeUntil = now + 0.8; stuck = 0; }
  if (now < escapeUntil) { const x = dx; dx = -dy; dy = x; }
  const length = Math.hypot(dx,dy);
  api.move(length > 0.1 ? dx/length : 0, length > 0.1 ? dy/length : 0);
  last = {x:p.x,y:p.y};
}
`
}
