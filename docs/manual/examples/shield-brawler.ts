// 教学点：贴脸、低血开盾与 dash 撤离；能量上限 100，回复 10/s。
// - shield(false) 可主动关盾；move(0, 0) 可释放移动意图
// - dash 方向取当前 move 向量，零向量时用炮口方向
// - dash() 调一次后仍会每逢 CD/能量允许自动再冲；撤离结束不会取消
import type { BotModule } from '@omb/bot-api'

let dashing = 0 // 撤离状态剩余时间（秒），>0 期间只逃不打

const bot = {
  tick(ctx) {
    const enemy = ctx.api.nearestEnemy()
    if (!enemy) {
      ctx.api.shield(false)
      ctx.api.move(0, 0)
      dashing = 0
      return // 没敌人：关盾并刹车；已锁存的 fire/dash 仍可能触发
    }

    const me = ctx.self.position
    const dist = Math.hypot(enemy.position.x - me.x, enemy.position.y - me.y)

    if (dashing > 0) {
      // 撤离窗口：背向敌人 move + dash（dash 已在进入分支时调过一次）
      dashing -= 1 / 60
      ctx.api.move(me.x - enemy.position.x, me.y - enemy.position.y)
      ctx.api.shield(ctx.self.hp < 50) // 血量低就带盾撤
      return
    }

    if (ctx.self.hp < 30 && ctx.self.energy >= 20) {
      // 低血：开盾 + 反向 dash 撤离（耗 20 能量 + 盾 18/s，量入为出）
      ctx.api.shield(true)
      ctx.api.move(me.x - enemy.position.x, me.y - enemy.position.y)
      ctx.api.dash() // 调一次即持续锁存，之后 CD/能量允许仍会再冲
      dashing = 1.5
      return
    }

    // 常态：关盾后贴脸射击；fire 锁存后持续输出，与 hack 互斥
    ctx.api.shield(false)
    ctx.api.moveTo(enemy.position)
    ctx.api.aimAt(enemy)
    ctx.api.fire()
  },
}
export default bot
