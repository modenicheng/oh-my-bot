// 最小闭环：看 → 选 → 瞄 → 打。
// - scan() 免费；robots 里只有 20m 内、没被墙挡住的存活机器人
// - 有敌人就每帧调 fire()，敌人一离开视野，开火意图自然停
// - 提交时 import type 行会被服务器剥掉，正文里不能出现类型注解
import type { BotContext } from '@omb/bot-api'

function tick(bot: BotContext) {
  const obs = bot.scan() // 免费读当帧快照；robots 只含 20m 内且没被墙挡住的活人
  const enemy = obs.robots[0]
  if (enemy) {
    bot.aimAt(enemy) // 传实体直接瞄；目标不可见会当场抛异常
    bot.fire() // 服务器强制 250ms 节流，能量不够或护盾开着就安静地不射
  }
}
