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
let held = 0;
const cooldowns = {};
function tick(bot) {
  const p = bot.self.position, now = bot.game.time;
  const scan = bot.scan();
  const dist = q => Math.hypot(q.x - p.x, q.y - p.y);
  const unlocked = bot.game.phase === "CORE_OPEN";
  const reachable = q => unlocked || Math.hypot(q.x, q.y) > 29;
  const enemy = bot.nearestEnemy();
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
    bot.move(0,0); bot.interact(); return;
  }
  if (enemy && bot.self.energy > 20) { bot.aimAt(enemy); bot.fire(); }
  let target = (preferUplink && uplink) || cores[0] || uplink || (enemy && enemy.position);
  if (!target) {
    const angle = now / 12 + personality * 2.094;
    target = {x: 48 * Math.cos(angle), y: 48 * Math.sin(angle)};
  }
  bot.navigateTo(target);
}
`
}
