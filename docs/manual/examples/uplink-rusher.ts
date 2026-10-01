// 教学点：Uplink 站桩引导 8s；成功事件和个人 CD 不下发，本例仅估算等待时间。
// - 黑入要求本 tick 无 fire 意图；本例从不调 fire()，避免锁存阻止引导
// - 引导中断（出圈/开火/死亡）进度清零但不进 CD；只有成功才启动 30s 个人 CD
// - interact() 调一次即锁存为"按住"——引导正需要持续按住，出圈自动断、回圈自动续
import type { BotModule } from '@omb/bot-api'

let cdUntil = -1 // 本例的全局等待截止时间；真实 CD 按机器人和桩分别记录
let started = -1 // 估算的引导起始时间（秒），不能用来确认成功
let targetKey = ''

const bot = {
  tick(bot) {
    const uplink = bot.nearestUplink() // 全图最近"激活"桩；主桩 CORE_OPEN 才进候选
    if (!uplink || bot.self.hp <= 0) {
      started = -1
      bot.move(0, 0)
      return
    }
    const key = uplink.x + ',' + uplink.y
    if (key !== targetKey) { targetKey = key; started = -1 }
    if (bot.game.time < cdUntil) {
      // 还在 CD：远离桩（2.5m 外不会被误引导），等窗口
      bot.moveTo({ x: uplink.x + 6, y: uplink.y + 6 })
      return
    }

    const me = bot.self.position
    const dist = Math.hypot(uplink.x - me.x, uplink.y - me.y)
    if (dist > 1) {
      started = -1 // 离开保守站桩范围就重新计时
      bot.move((uplink.x - me.x) / 3, (uplink.y - me.y) / 3)
    } else {
      bot.move(0, 0) // 显式刹车，防止旧移动意图把机器人带出引导圈
      bot.interact()
      if (started < 0) started = bot.game.time
      if (bot.game.time - started > 8.5) {
        // 只估算已完成；争抢、中断或手操可使估算失准，服务器仍强制真实 CD
        cdUntil = bot.game.time + 30
        started = -1
      }
    }
  },
}
export default bot
