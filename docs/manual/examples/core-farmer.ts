// 教学点：cores 恒全量可见 → nearestCore 做全局导航；路过敌人顺手还击。
// - 拾取无需 API：走到 Core 0.6m 内自动得分（普通 +10 / Mega +25）
// - fire() 一旦调用即锁存：farmer 从此进入全自动还击（直到死亡清轴）
// - 锁存的 fire 与黑桩永久互斥：farmer 别再去抢 Uplink
import type { BotModule } from '@omb/bot-api'

const bot = {
  tick(ctx) {
    const core = ctx.api.nearestCore() // 全图最近存活 Core（不是视野内），无则 null
    if (core) {
      ctx.api.moveTo(core) // 移动与瞄准互不干扰，可以边走边打
    } else {
      ctx.api.move(0, 0) // 暂无 Core：原地待刷（move 每帧重调即可覆盖）
    }

    const enemy = ctx.api.nearestEnemy()
    if (enemy) {
      ctx.api.aimAt(enemy) // 有效射程 16m，超过后散布增大，远距命中靠运气
      ctx.api.fire()
    }
  },
}
export default bot
