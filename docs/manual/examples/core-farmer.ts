// 教学点：cores 恒全量可见 → nearestCore 做全局导航；路过敌人顺手还击。
// - 拾取无需 API：走到 Core 0.6m 内自动得分（普通 +10 / Mega +25）
// - 敌人在视野内时每 tick 调 fire()，离开视野即停火
// - 本 tick 的 fire 意图会阻止黑入；本例不尝试抢 Uplink
import type { BotModule } from '@omb/bot-api'

const bot = {
  tick(bot) {
    const core = bot.nearestCore() // 全图最近存活 Core（不是视野内），无则 null
    if (core) {
      bot.moveTo(core) // 移动与瞄准互不干扰，可以边走边打
    } else {
      bot.move(0, 0) // 暂无 Core：原地待刷
    }

    const enemy = bot.nearestEnemy()
    if (enemy) {
      bot.aimAt(enemy) // 有效射程 16m，超过后散布增大，远距命中靠运气
      bot.fire()
    }
  },
}
export default bot
