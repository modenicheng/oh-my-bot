// 预测命中才开盾：平时关盾省能量，算出弹道即将命中才举盾。
// - scan().projectiles 的 heading 是含散布后的瞬时飞行方向（弧度），弹速 30 m/s
// - 管线延迟：快照是第 N tick 的，shield(true) 在第 N+2 tick 才结算，
//   所以拦截窗口要按「从现在起 2~8 tick 内命中」来算，宁早勿晚
// - 护盾 18 能量/秒、减伤 65%；一次命中 12 伤害，盾下只掉 4.2
// - 弹丸会拐弯（越远散布越大），远弹的 heading 误差大，
//   所以同时用上一帧位置差分校验方向，两说一致才算真威胁
import type { BotContext } from '@omb/bot-api'

const PROJ_SPEED = 0.5 // 30 m/s ÷ 60 tick
const LEAD = 2 // 管线延迟（tick）：快照→脚本→下一 tick 生效
const WINDOW = 8 // 拦截窗口（tick）：窗口内将命中就开盾（含 LEAD）
const RADIUS = 1.1 // 命中判定半径：机身 0.6 + 散布容差

const lastPos = new Map() // 弹 id → 上一帧位置

function tick(bot: BotContext) {
  const me = bot.self.position
  const obs = bot.scan()
  let threat = false

  for (const p of obs.projectiles) {
    const prev = lastPos.get(p.id)
    lastPos.set(p.id, { x: p.x, y: p.y })
    if (p.owner === bot.self.id) continue // 自己的弹不拦

    // 声明的方向 vs 实测位移方向，两者都指向我才算威胁
    const dx = me.x - p.x
    const dy = me.y - p.y
    const dist = Math.hypot(dx, dy)
    if (dist > 20) continue // 视野外不会有弹（20m 裁剪），保险起见

    const along = dx * Math.cos(p.heading) + dy * Math.sin(p.heading)
    if (along <= 0) continue // 弹头已朝反方向飞：不会回来

    // 直线外推：t tick 后的最近距离（忽略散布微调，近弹误差很小）
    const cross = Math.abs(dx * Math.sin(p.heading) - dy * Math.cos(p.heading))
    const tHit = Math.max(0, along - RADIUS) * PROJ_SPEED // 命中前剩余 tick（近似）
    if (cross > RADIUS || tHit > WINDOW) continue

    // 用实测位移复核（散布中的弹 heading 每帧微变，位移是真话）
    if (prev) {
      const mx = p.x - prev.x
      const my = p.y - prev.y
      const m = Math.hypot(mx, my)
      if (m > 1e-6) {
        const mAlong = dx * mx / m + dy * my / m
        const mCross = Math.abs(dx * my / m - dy * mx / m)
        if (mAlong <= 0 || mCross > RADIUS * 2) continue // 实测方向不认可
      }
    }

    threat = true
    break
  }

  // 清理消失的弹 id，防止 Map 无限增长（弹丸存活≤40 tick，64 足够滚动清理）
  if (lastPos.size > 64) {
    const seen = new Set(obs.projectiles.map(p => p.id))
    for (const id of lastPos.keys()) if (!seen.has(id)) lastPos.delete(id)
  }

  // 能量见底时举不住盾（18/s 耗能），留一点余量避免盾中途熄灭白花钱
  bot.shield(threat && bot.self.energy > 1.2)

  const enemy = bot.nearestEnemy()
  if (enemy) {
    bot.aimAt(enemy)
    bot.fire()
    bot.moveTo(enemy.position)
  } else {
    bot.move(0, 0)
  }
}
