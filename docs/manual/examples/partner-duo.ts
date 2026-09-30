// 教学点：partner() 恒可见（隔墙、无限距）= 唯一全图信标；夹击走位靠"搭档与敌人连线的延长侧"。
// - partner() 奇数局末位为 null：先判空
// - 搭档间弹丸互免：不用担心误伤，两人交叉火力随便打
// - say 3s CD 服务器强制：只在状态变化沿上报，不做每帧广播
import type { BotModule } from '@omb/bot-api'

let lastSay = -99 // 上次 say 的时间（秒），用于 3s 节流（服务器还有一层强制 CD）

const bot = {
  tick(ctx) {
    const partner = ctx.api.partner()
    if (!partner) {
      // 无搭档（奇数局末位）：退化为普通索敌
      const e = ctx.api.nearestEnemy()
      if (e) { ctx.api.aimAt(e); ctx.api.fire() }
      return
    }

    const enemy = ctx.api.nearestEnemy()
    if (!enemy) {
      ctx.api.moveTo(partner.position) // 没接敌：跟上搭档保持协同
      return
    }

    // 夹击：站到敌人的"搭档对侧"——敌人被夹在我和搭档之间
    const me = ctx.self.position
    const target = {
      x: enemy.position.x * 2 - partner.position.x,
      y: enemy.position.y * 2 - partner.position.y,
    }
    ctx.api.moveTo(target)
    ctx.api.aimAt(enemy)

    if (ctx.game.time - lastSay > 3.5) {
      ctx.api.say('pincing ' + enemy.id) // 自记 3.5s 节流；服务器 CD 内仍会静默丢弃
      lastSay = ctx.game.time
    }
  },
}
export default bot
