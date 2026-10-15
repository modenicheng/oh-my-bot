// 捡分为主，路过顺手打两枪。
// - nearestCore 只挑当前可见目标，navigateTo 只使用观察到的墙面与边界
// - 拾取不用调 API：机器人边缘碰到 Core 就自动捡（普通 +10，Mega +25）
// - navigateTo 不躲移动中的机器人，不评估威胁，也不预判弹道
// - 有敌人就每帧 fire()，敌人出视野就停火
// - 这个例子的 fire 意图会挡住黑入，所以它不去抢桩
import type { BotContext } from '@omb/bot-api'

function tick(bot: BotContext) {
  const core = bot.nearestCore() // 当前观察内最近的存活 Core，没有就 null
  if (core) {
    bot.navigateTo(core) // 局部确定性寻路；碰到 Core 自动拾取
  } else {
    const angle = bot.scan().tick / 180 + bot.self.id
    bot.move(Math.cos(angle), Math.sin(angle))
  }

  const enemy = bot.nearestEnemy()
  if (enemy) {
    bot.aimAt(enemy) // 有效射程 16m，超出后散布变大，远距离靠运气
    bot.fire()
  }
}
