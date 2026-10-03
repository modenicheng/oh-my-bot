// 绕圈巡逻：模块级状态 + 路标循环。
// - idx 写在 tick 外面才有记忆；热更成功后清零，从头开始
// - 到点判定用距离阈值，别写 == 0：一拍延迟加上加速度，永远踩不到精确点
// - moveTo 只表达"朝这走"，不保证到达，也不自动刹车
import type { BotContext } from '@omb/bot-api'

const waypoints = [
  { x: 30, y: 0 },
  { x: 0, y: 30 },
  { x: -30, y: 0 },
  { x: 0, y: -30 },
] // 外环一圈的示例路标（地图半径约 67m，你自己改成想去的点）
let idx = 0 // 模块级状态：当前目标路标

function tick(bot: BotContext) {
  const me = bot.self.position
  const target = waypoints[idx]
  const dx = target.x - me.x
  const dy = target.y - me.y
  if (dx * dx + dy * dy < 4) {
    // 距离小于 2m 就算到点，换下一个
    idx = (idx + 1) % waypoints.length
    return
  }
  bot.moveTo(target)
}
