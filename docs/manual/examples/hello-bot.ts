// 教学点：最小闭环——scan 感知 → nearestEnemy 索敌 → aimAt 实体重载转向 → fire 开火。
// 注意：fire() 一经调用即锁存（全自动射击直到死亡），五行示例不处理战术，只跑通 API 链路。
// 提交契约：import type / export default 行会被服务器剥除；正文不得出现任何类型注解。
import type { BotModule } from '@omb/bot-api'

const bot = {
  tick(bot) {
    const enemy = bot.nearestEnemy() // 只搜 20m 视野内（不含自己/死者），不可见返回 null
    if (enemy) {
      bot.aimAt(enemy) // L1 重载：按实体方位角转向（目标可见才不抛错）
      bot.fire() // 服务器强制 250ms 节流 + 能量>=5；护盾开启时静默不射
    }
  },
}
export default bot
