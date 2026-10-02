// 教学点：单人侧翼走位——不直冲敌人，绕到敌人侧后方再开火（原 partner-duo.ts：搭档机制已移除）。
// - 感知只有 20m 且不穿墙：索敌为空时保持移动，别站桩
// - moveTo 只表达"朝这走"：侧翼点每帧重算，敌人移动时自动跟着绕
// - say 3s CD 服务器强制：发现敌人时每隔 3.5s 报点
import type { BotContext } from '@omb/bot-api'

let lastSay = -99 // 上次 say 的时间（秒），用于 3s 节流（服务器还有一层强制 CD）

function tick(bot: BotContext) {
  const enemy = bot.nearestEnemy()
  if (!enemy) {
    // 没接敌：朝最近的 Core 移动，顺路吃资源
    const core = bot.nearestCore()
    if (core) bot.moveTo(core)
    return
  }

  // 侧翼：绕到敌人侧面 90° 的位置，而不是顶着炮口直冲
  const me = bot.self.position
  const dx = enemy.position.x - me.x
  const dy = enemy.position.y - me.y
  const len = Math.hypot(dx, dy) || 1
  // 前向单位向量旋转 90° = 侧向；偏移一段距离形成包抄角
  const target = {
    x: enemy.position.x + (-dy / len) * 6,
    y: enemy.position.y + (dx / len) * 6,
  }
  bot.moveTo(target)
  bot.aimAt(enemy)
  bot.fire()

  if (bot.game.time - lastSay > 3.5) {
    bot.say('enemy ' + enemy.id) // 自记 3.5s 节流；服务器 CD 内仍会静默丢弃
    lastSay = bot.game.time
  }
}
