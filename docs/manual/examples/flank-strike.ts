// 单人侧翼：不直冲敌人，绕到侧后方再开火（原 partner-duo.ts，搭档机制已移除）。
// - 视野只有 20m 还不穿墙：看不见敌人时别站桩，边走边找
// - moveTo 只表达"朝这走"；侧翼点每帧重算，敌人一动就跟着绕
// - say 服务器强制 3 秒冷却，这里自记 3.5 秒，避免白调
import type { BotContext } from '@omb/bot-api'

let lastSay = -99 // 上次报点时间（秒）；自记 3.5 秒节流，服务器还有一层 3 秒强制冷却

function tick(bot: BotContext) {
  const enemy = bot.nearestEnemy()
  if (!enemy) {
    // 没接敌：朝最近的 Core 走，顺路吃资源
    const core = bot.nearestCore()
    if (core) bot.moveTo(core)
    return
  }

  // 侧翼：绕到敌人侧面 90° 的位置，别顶着炮口直冲
  const me = bot.self.position
  const dx = enemy.position.x - me.x
  const dy = enemy.position.y - me.y
  const len = Math.hypot(dx, dy) || 1
  // 前向向量转 90° 就是侧向，再拉出一段距离形成包抄角
  const target = {
    x: enemy.position.x + (-dy / len) * 6,
    y: enemy.position.y + (dx / len) * 6,
  }
  bot.moveTo(target)
  bot.aimAt(enemy)
  bot.fire()

  if (bot.game.time - lastSay > 3.5) {
    bot.say('enemy ' + enemy.id) // 自记 3.5 秒节流；服务器冷却内的调用会被静默丢掉
    lastSay = bot.game.time
  }
}
