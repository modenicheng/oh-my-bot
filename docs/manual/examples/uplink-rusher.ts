// 抢桩：站在桩旁引导 8 秒。
// - 黑入要求这一帧没有 fire 意图，所以本例从头到尾不调 fire()
// - 松手、出圈、开火、死亡会中断；0.5 秒内进度保持，之后每秒回退 0.5 秒；只有成功才进入 30 秒个人冷却
// - 站桩期间每帧调 interact()，离开桩就停
// - 成功事件和个人冷却都不下发，下面的时间只能估算，不能当成功凭据
import type { BotContext } from '@omb/bot-api'

let cdUntil = -1 // 本例自己的等待截止时间；真实冷却按机器人、按桩分别记
let started = -1 // 估算的引导起始时间（秒），只用来计时，不能确认成功
let targetKey = ''

function tick(bot: BotContext) {
  const uplink = bot.nearestUplink() // 全图最近的"激活"桩；主桩 4:00 后才进候选
  if (!uplink || bot.self.hp <= 0) {
    started = -1
    bot.move(0, 0)
    return
  }
  const key = uplink.x + ',' + uplink.y
  if (key !== targetKey) { targetKey = key; started = -1 }
  if (bot.game.time < cdUntil) {
    // 还在估算的冷却里：站到 2.5m 外等窗口，远了就不会误触发引导
    bot.moveTo({ x: uplink.x + 6, y: uplink.y + 6 })
    return
  }

  const me = bot.self.position
  const dist = Math.hypot(uplink.x - me.x, uplink.y - me.y)
  if (dist > 1) {
    started = -1 // 离开保守的站桩范围，重新计时
    bot.move((uplink.x - me.x) / 3, (uplink.y - me.y) / 3)
  } else {
    bot.move(0, 0) // 显式刹车，别让惯性把你带出引导圈
    bot.interact()
    if (started < 0) started = bot.game.time
    if (bot.game.time - started > 8.5) {
      // 只能估算"应该完成了"；争抢、中断、手操都会让估算失准，服务器仍按真实冷却执行
      cdUntil = bot.game.time + 30
      started = -1
    }
  }
}
