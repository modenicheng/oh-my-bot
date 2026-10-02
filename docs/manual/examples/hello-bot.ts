// 教学点：最小闭环——scan 感知 → 选择可见敌人 → aimAt 实体重载转向 → fire 开火。
// 注意：动作只对当前 tick 生效；有敌人时每 tick 调用 fire()，敌人消失即停火。
// 提交契约：import type / export default 行会被服务器剥除；正文不得出现任何类型注解。
import type { BotContext } from '@omb/bot-api'

function tick(bot: BotContext) {
  const obs = bot.scan() // 免费读取当帧快照；robots 只含 20m 内且未被墙遮挡的存活机器人
  const enemy = obs.robots[0]
  if (enemy) {
    bot.aimAt(enemy) // L1 重载：按实体方位角转向（目标可见才不抛错）
    bot.fire() // 服务器强制 250ms 节流 + 能量>=5；护盾开启时静默不射
  }
}
