package glue

import (
	"fmt"

	"github.com/modenicheng/oh-my-bot/server/internal/room"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

// Synthetic identities live only in the match, never in RoomConn.identities or
// sessions. Over-asks clamp to MaxSoloBots; humans keep their seats up to the
// room seat cap (room.MaxPlayers, default 200).
func addSoloBots(players map[uint64]SessionInfo, count uint32) {
	if count > uint32(room.MaxSoloBots) {
		count = uint32(room.MaxSoloBots)
	}
	used := make(map[uint32]bool, len(players))
	for pid := range players {
		used[stableRobotID(pid)] = true
	}
	candidate := uint64(0xffff_ffff_ffff_f000)
	colors := [...]string{"#a3e635", "#fbbf24", "#f472b6", "#22d3ee", "#a78bfa", "#34d399", "#f97316", "#ff5c5c"}
	for i := uint32(0); i < count && len(players) < room.MaxPlayers; {
		pid := candidate
		candidate++
		rid := stableRobotID(pid)
		if _, exists := players[pid]; exists || rid == 0 || used[rid] {
			continue
		}
		players[pid] = SessionInfo{PlayerID: pid, Nick: fmt.Sprintf("TEST-BOT-%d", i+1), Color: colors[int(i)%len(colors)], Bot: true}
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
//
// Cost contract (2026-10 200-player postmortem): scan() rebuilds the whole
// observation — every visible robot, all walls, all projectiles — and at
// full-room scale a single call can eat the entire per-tick quota. The script
// therefore plans at 4Hz (scan() only on replan ticks) and spends the other
// ticks on the cheap Go-side built-ins only (nearestEnemy / navigateTo /
// aimAt / fire). Amortized cost drops by orders of magnitude, which is what
// lets a 199-bot roster fit in the shared frame budget at all.
func soloBotSource(id uint32) string {
	return fmt.Sprintf("const botID = %d, personality = %d;\n", id, id%3) + `
const PLAN_EVERY = 0.25, HACK_R = 2.0, LOCK_R = 30, FIRE_RANGE = 16;
const PROJ_SPEED = 36, FIRE_MIN_ENERGY = 20, DASH_CD = 2.6;
const UPGRADE_TRACKS = ["hp", "attack", "speed", "shield", "energy"];
let plan = null, myUp = 0, mode = "objective", nextPlanAt = 0, dashAt = -9;
const cd = {};

function tick(bot) {
  const self = bot.self, now = bot.game.time, p = self.position;
  if (now >= nextPlanAt) { nextPlanAt = now + PLAN_EVERY; plan = replan(bot, p, now, self.hp); }
  const enemy = bot.nearestEnemy();
  const edist = enemy ? Math.hypot(enemy.position.x - p.x, enemy.position.y - p.y) : Infinity;

  if (mode === "flee") {
    if (self.hp >= 70) { mode = "objective"; }
    else {
      if (edist < 9 && self.energy >= 25 && now - dashAt >= DASH_CD) { dashAt = now; bot.dash(); }
      if (enemy) {
        const dx = p.x - enemy.position.x, dy = p.y - enemy.position.y, d = Math.max(Math.hypot(dx, dy), 1e-6);
        bot.navigateTo({ x: p.x + dx / d * 10, y: p.y + dy / d * 10 });
      } else if (plan) bot.navigateTo(plan);
      fight(bot, enemy, p, edist, self);
      return;
    }
  }
  if (plan && (mode === "hack" || myUp) && Math.hypot(plan.x - p.x, plan.y - p.y) < HACK_R) {
    bot.move(0, 0);
    bot.interact();
    fight(bot, enemy, p, edist, self);
    return;
  }
  mode = "objective";
  fight(bot, enemy, p, edist, self);
  if (plan) bot.navigateTo(plan);
}

function fight(bot, enemy, p, edist, self) {
  if (!enemy || edist > FIRE_RANGE || self.energy <= FIRE_MIN_ENERGY) return;
  const t = edist / PROJ_SPEED;
  bot.aimAt(Math.atan2(enemy.position.y + enemy.velocity.y * t - p.y, enemy.position.x + enemy.velocity.x * t - p.x));
  bot.fire();
  if (edist < 5 && self.hp < 60) {
    const dx = p.x - enemy.position.x, dy = p.y - enemy.position.y, d = Math.max(edist, 1e-6);
    bot.navigateTo({ x: p.x + dx / d * 8, y: p.y + dy / d * 8 });
  }
}

function buyUpgrades(bot) {
  let points = bot.self.upgrade.points, buys = 0;
  const levels = { ...bot.self.upgrade.levels }, costs = bot.game.upgradeCosts;
  for (const track of UPGRADE_TRACKS) {
    while (buys < 8 && levels[track] < costs.length && points >= costs[levels[track]]) {
      bot.buyUpgrade(track);
      points -= costs[levels[track]];
      levels[track]++;
      buys++;
    }
    if (buys === 8) break;
  }
}

function replan(bot, p, now, hp) {
  buyUpgrades(bot);
  const scan = bot.scan();
  const unlocked = bot.game.phase === "CORE_OPEN";
  const reachable = q => unlocked || Math.hypot(q.x, q.y) > LOCK_R;
  const dist = q => Math.hypot(q.x - p.x, q.y - p.y);

  let threat = 0;
  for (const r of scan.robots) if (dist(r.position) < 10) threat++;
  if (hp < 45 && threat > 0) {
    mode = "flee";
    const packs = scan.healthPacks.filter(h => h.available && dist(h) < 50).sort((a, b) => dist(a) - dist(b));
    if (packs[0]) return { x: packs[0].x, y: packs[0].y };
    const e = scan.robots.sort((a, b) => dist(a.position) - dist(b.position))[0].position;
    const dx = p.x - e.x, dy = p.y - e.y, d = Math.max(Math.hypot(dx, dy), 1e-6);
    return { x: p.x + dx / d * 14, y: p.y + dy / d * 14 };
  }

  if (myUp) {
    const mine = scan.uplinks.find(u => u.id === myUp && u.holder === botID);
    if (mine) { mode = "hack"; return { x: mine.x, y: mine.y }; }
    if (mode === "hack") { cd[myUp] = now + 30; }
    myUp = 0;
  }

  const uplinks = scan.uplinks
    .filter(u => u.ready && reachable(u) && !(cd[u.id] > now))
    .sort((a, b) => dist(a) - dist(b));
  if (uplinks.length) {
    const u = uplinks[personality % Math.min(uplinks.length, 3)];
    myUp = u.id;
    mode = "objective";
    return { x: u.x, y: u.y };
  }
  myUp = 0;

  const cores = scan.cores.filter(reachable).sort((a, b) => dist(a) - dist(b));
  if (cores.length) {
    const c = cores[Math.min(personality % 2, cores.length - 1)];
    mode = "objective";
    return { x: c.x, y: c.y };
  }
  mode = "objective";
  const angle = now / 12 + personality * 2.094;
  const scanWalls = scan.walls;
  for (let attempt = 0; attempt < 12; attempt++) {
    const heading = angle + attempt * Math.PI / 6;
    const target = { x: p.x + 8 * Math.cos(heading), y: p.y + 8 * Math.sin(heading) };
    const blocked = scanWalls.some(w => Math.min(p.x,target.x) <= w.max.x+0.7 && Math.max(p.x,target.x) >= w.min.x-0.7 && Math.min(p.y,target.y) <= w.max.y+0.7 && Math.max(p.y,target.y) >= w.min.y-0.7);
    if (!blocked) return target;
  }
  return { x: p.x, y: p.y };
}
`
}
