// 贴脸、低血开盾、不行就跑。能量上限 100，每秒回 10。
// - 每个动作都只对这一帧有效；撤离分支要每帧调 dash()，离开分支就停
// - dash 方向跟当前 move 向量；向量为零时朝地口方向冲
// - shield 和 dash 互斥且 shield 优先，所以这里按血量二选一
import type { BotContext } from '@omb/bot-api'

let dashing = 0 // 撤离剩余时间（秒），大于 0 期间只逃不打

function tick(bot: BotContext) {
  const enemy = bot.nearestEnemy()
  if (!enemy) {
    bot.shield(false)
    bot.move(0, 0)
    dashing = 0
    return // 没敌人：这一帧关盾刹车，其他动作自动停
  }

  const me = bot.self.position

  if (dashing > 0) {
    // 撤离窗口：背对敌人一直冲；能量不够时服务器自动停
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
    bot.shield(true) // 不冲刺时举盾撤离，同时不开火
    return
  }

  // 常态：关盾贴脸打；敌人消失后脚本自然停火
  bot.shield(false)
  bot.moveTo(enemy.position)
  bot.aimAt(enemy)
  bot.fire()
}
