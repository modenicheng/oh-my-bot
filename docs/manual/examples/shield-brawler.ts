// 教学点：贴脸、低血开盾与 dash 撤离；能量上限 100，回复 10/s。
// - 所有动作都是每 tick 意图；撤离分支持续调用 dash，离开即停
// - dash 方向取当前 move 向量，零向量时用炮口方向
// - shield 与 dash 互斥且 shield 优先，因此本例按血量选择其一
import type { BotContext } from '@omb/bot-api'

let dashing = 0 // 撤离状态剩余时间（秒），>0 期间只逃不打

function tick(bot: BotContext) {
  const enemy = bot.nearestEnemy()
  if (!enemy) {
    bot.shield(false)
    bot.move(0, 0)
    dashing = 0
    return // 没敌人：本 tick 关盾并刹车，其余动作自动停止
  }

  const me = bot.self.position

  if (dashing > 0) {
    // 撤离窗口：背向敌人持续 Dash；能量不足时服务端自动停
    dashing -= 1 / 60
    bot.move(me.x - enemy.position.x, me.y - enemy.position.y)
    bot.shield(false)
    bot.dash()
    return
  }

  if (bot.self.hp < 30 && bot.self.energy >= 20) {
    bot.move(me.x - enemy.position.x, me.y - enemy.position.y)
    bot.shield(false)
    bot.dash()
    dashing = 1.5
    return
  }

  if (bot.self.hp < 50 && bot.self.energy > 5) {
    bot.move(me.x - enemy.position.x, me.y - enemy.position.y)
    bot.shield(true) // 不冲刺时举盾撤离，不同时开火
    return
  }

  // 常态：关盾后贴脸射击；敌人消失后脚本自动停火
  bot.shield(false)
  bot.moveTo(enemy.position)
  bot.aimAt(enemy)
  bot.fire()
}
