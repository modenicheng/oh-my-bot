// 教学点：Uplink 黑入 = 站桩引导 8s；个人 CD 30s 服务器不下发，必须自己用 game.time 记。
// - canHack 要求本 tick 未 fire：本 bot 从不调 fire()（调过即锁存，与 hack 永久互斥）
// - 引导中断（出圈/开火/死亡）进度清零但不进 CD；只有成功才启动 30s 个人 CD
// - interact() 调一次即锁存为"按住"——引导正需要持续按住，出圈自动断、回圈自动续
import type { BotModule } from '@omb/bot-api'

let cdUntil = -1 // 个人 CD 截止时间（秒），-1 表示从未黑入过
let started = 0 // 当前引导起始时间（秒），0 表示未在引导

const bot = {
  tick(ctx) {
    const uplink = ctx.api.nearestUplink() // 全图最近"激活"桩；主桩 CORE_OPEN 才进候选
    if (!uplink) return
    if (ctx.game.time < cdUntil) {
      // 还在 CD：远离桩（2.5m 外不会被误引导），等窗口
      ctx.api.moveTo({ x: uplink.x + 6, y: uplink.y + 6 })
      return
    }

    const me = ctx.self.position
    const dist = Math.hypot(uplink.x - me.x, uplink.y - me.y)
    if (dist > 2) {
      ctx.api.moveTo(uplink) // 站到桩旁；引导半径 2.5m（主桩 3m）
    } else {
      ctx.api.interact() // 按住引导；成功与否无事件，自己计时
      if (!started) started = ctx.game.time
      if (ctx.game.time - started > 8.5) {
        // 超过引导时长视为已完成 → 进入自记 30s CD（宁可多等半秒防误判）
        cdUntil = ctx.game.time + 30
        started = 0
      }
    }
  },
}
export default bot
