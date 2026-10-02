// 教学点：cores 恒全量可见 → nearestCore 选目标 → navigateTo 做静态导航；路过敌人顺手还击。
// - 拾取无需 API：机器人圆形边缘接触 Core 即自动得分（普通 +10 / Mega +25）
// - navigateTo 避开墙、竞技场边界和未解锁中央区；不躲动态机器人、不评估威胁、不预测弹道
// - 敌人在视野内时每 tick 调 fire()，离开视野即停火
// - 本 tick 的 fire 意图会阻止黑入；本例不尝试抢 Uplink
import type { BotContext } from '@omb/bot-api'

function tick(bot: BotContext) {
  const core = bot.nearestCore() // 全图最近存活 Core（不是视野内），无则 null
  if (core) {
    bot.navigateTo(core) // 服务器确定性静态 A*；接触 Core 后自动拾取
  } else {
    bot.move(0, 0) // 暂无 Core：原地待刷
  }

  const enemy = bot.nearestEnemy()
  if (enemy) {
    bot.aimAt(enemy) // 有效射程 16m，超过后散布增大，远距命中靠运气
    bot.fire()
  }
}
