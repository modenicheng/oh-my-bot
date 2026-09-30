// 教学点：近战三件套——贴脸、低血开盾、断dash撤离；以及能量经济（100 上限，回复 10/s）。
// - shield(false) 是唯一能主动关掉的锁存轴：状态机每帧显式给值，不残留
// - dash 方向取本 tick 的 move 向量：先 move 再 dash（顺序无关）
// - dash() 是电平锁存：CD 到就自动再冲并耗 20 能量，所以只在撤离分支调一次
import type { BotModule } from '@omb/bot-api'

let dashing = 0 // 撤离状态剩余时间（秒），>0 期间只逃不打

const bot = {
  tick(ctx) {
    const enemy = ctx.api.nearestEnemy()
    if (!enemy) {
      ctx.api.shield(false)
      return // 没敌人：关盾省能量，原地
    }

    const me = ctx.self.position
    const dist = Math.hypot(enemy.position.x - me.x, enemy.position.y - me.y)

    if (dashing > 0) {
      // 撤离窗口：背向敌人 move + dash（dash 已在进入分支时调过一次）
      dashing -= 1 / 60
      ctx.api.move(me.x - enemy.position.x, me.y - enemy.position.y)
      ctx.api.shield(me.hp < 50) // 血量低就带盾撤
      return
    }

    if (me.hp < 30 && ctx.self.energy >= 20) {
      // 低血：开盾 + 反向 dash 撤离（耗 20 能量 + 盾 18/s，量入为出）
      ctx.api.shield(true)
      ctx.api.move(me.x - enemy.position.x, me.y - enemy.position.y)
      ctx.api.dash() // 只在这一帧调用；电平锁存 CD 到自动断
      dashing = 1.5
      return
    }

    // 常态：贴脸 + 全自动射击（fire 锁存后持续输出，注意与 hack 互斥）
    ctx.api.moveTo(enemy.position)
    ctx.api.aimAt(enemy)
    ctx.api.fire()
  },
}
export default bot
