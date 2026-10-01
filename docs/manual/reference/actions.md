---
title: 动作参考（L0 原语）
audience: coder
order: 41
tags: [脚本, L0]
---

# 动作参考（L0 原语）

L0 是 7 个最基础的动作指令：`move`、`aimAt`、`fire`、`dash`、`shield`、`interact`、`say`。每个指令告诉机器人"这一帧我想做某个动作"。常用的组合动作（追踪敌人、找资源、找搭档）在 [helpers.md](helpers.md)——那层是 L0 的糖，最终也落到这些原语上。

所有动作共享两条规则：

1. **调用只表达意图，结果由游戏裁定。** 脚本说"我要开火"，游戏会检查冷却、能量、护盾状态，全部满足才真正发射。条件不满足时通常是**安静地不执行**——不报错、不提示。判定在服务器上统一进行，脚本里任何"重试""绕过""抢跑"的写法都改变不了结果。
2. **一帧可以同时表达多个动作。** 移动、瞄准、开火可以组合；开盾会阻止射击，开火意图会阻止黑入。同一个动作在一帧内多次调用，以最后一次为准。

## 先懂一个概念：锁存

`fire`、`dash`、`interact` 这三个动作没有"关"的参数——**调用一次等于一直按住**，这个机制叫锁存（latch）：

| 动作 | 锁存后的效果 |
|---|---|
| `fire()` | 全自动射击：游戏每 250ms 替你打一发，持续到锁存被解除 |
| `dash()` | 每当冷却（2.5s）转好就自动再冲一次，每次自动扣 20 能量 |
| `interact()` | 一直按住交互键——黑入引导正需要"按住"，这是刻意设计 |

解除锁存只有三条路：**机器人死亡**（复活时清空所有锁存）、**脚本该帧异常或超时**（该帧全部脚本动作作废）、**玩家关掉驾驶辅助总开关**（Space）。没有 `fire(false)` 这种反向调用。

`move`、`aimAt`、`shield` 同样保留最后一次的值，但你每帧重新调用就会覆盖，正常写法感觉不到锁存的存在。`shield(on)` 是唯一能主动传 `false` 关闭的动作。

## move(vx, vy)

**做什么**：告诉机器人往哪个方向走、使多大劲。它表达的是**方向和期望速度**，不是"走到某个点"。

| 参数 | 类型 | 含义 |
|---|---|---|
| `vx` | number | 世界坐标 x 方向的力度，正数朝右、负数朝左 |
| `vy` | number | 世界坐标 y 方向的力度 |

两个数合起来就是任意方向：`(1, 0)` 满速向右，`(0, 1)` 满速向另一个轴，`(0.7, 0.7)` 斜 45 度。两个数合起来超过 1 时游戏会自动归一成"满速朝这个方向"。

实际移动受两个物理约束：加速度 24 m/s²（转向和起步有惯性，不能瞬间调头）、最大速度 8 m/s。

```ts|py|java
朝一个方向满速移动，以及追踪一个目标点的写法。
```
```ts
const bot = {
  tick(ctx) {
    ctx.api.move(1, 0) // 每帧都喊"向右满速"
  },
}
export default bot
```
```py
def tick(ctx):
    ctx.api.move(1, 0)  # 每帧都喊"向右满速"
```
```java
void tick(Context ctx) {
    ctx.api.move(1, 0); // 每帧都喊"向右满速"
}
```

追踪目标点：把"我到目标的连线"当作方向：

```ts
const dx = target.position.x - ctx.self.position.x
const dy = target.position.y - ctx.self.position.y
ctx.api.move(dx, dy) // 向量长度 >1 时归一为满速，否则按比例减速
```

**游戏规则**：`vx` 或 `vy` 不是正常数字（NaN、Infinity）时，这一帧你的脚本发出的**所有**动作全部作废——这是防作弊阀门，人类的手操不受影响。

**常见坑**：

- 想要"快一点"而传了很大的数：超过 1 就会被归一成满速，"想走快点"的意图丢失。想满速就传归一后的方向，想减速就整体乘个小于 1 的系数。
- 期待立即转向或急停：机器人有加速度惯性，提前几个身位开始反向推杆。

## aimAt(angle | target)

**做什么**：把炮塔转向指定方向。一个 API 名，两种用法，游戏按你传的东西自动区分：

- 传**数字**：世界角度，单位弧度（别用度数——半圈是 π ≈ 3.14，不是 180）。
- 传**机器人**（RobotRef）：直接瞄向它，不用自己算角度。这是 L1 便利层提供的重载。

```ts|py|java
两种用法：按角度瞄准，和按敌人实体瞄准。
```
```ts
const bot = {
  tick(ctx) {
    ctx.api.aimAt(Math.PI / 2) // 炮口转到 π/2 方向
    const enemy = ctx.api.nearestEnemy()
    if (enemy) ctx.api.aimAt(enemy) // 传实体：直接瞄它
  },
}
export default bot
```
```py
def tick(ctx):
    ctx.api.aim_at(math.pi / 2)   # 炮口转到 π/2 方向
    enemy = ctx.api.nearest_enemy()
    if enemy:
        ctx.api.aim_at(enemy)     # 传实体：直接瞄它
```
```java
void tick(Context ctx) {
    ctx.api.aimAt(Math.PI / 2);   // 炮口转到 π/2 方向
    RobotRef enemy = ctx.api.nearestEnemy();
    if (enemy != null) ctx.api.aimAt(enemy); // 传实体：直接瞄它
}
```

**游戏规则**：

- 角度是 NaN 或 Infinity 时，该帧全部脚本动作作废（同 `move`）。
- 实体用法只接受**你看得见**的机器人。瞄一个被墙挡住或超出视野的目标（搭档除外，搭档永远可见），脚本会当场抛出异常 `aimAt: entity not visible`；这个异常你没接住的话，该帧全部脚本动作作废。

**常见坑**：

- 度数弧度混用：想转 90° 结果转了 90 弧度。全部用弧度。
- 对墙后的敌人用实体瞄准：先确认它在 `ctx.scan().robots` 里（搭档不用确认）。

## fire()

**做什么**：开炮。伤害 12 点，弹速 30 m/s，有效射程 16m——弹丸最远能飞 20m，但 16m 外精度开始下降，远距离是碰运气。

无参数。**调用即锁存**（见篇首）：调一次 = 全自动射击，直到锁存被解除。

**游戏规则**（以下任一条件不满足，这一炮就安静地不发射，不报错）：

| 条件 | 数值 |
|---|---|
| 距上次发射 | ≥ 250ms（游戏替你节流，连点无效） |
| 能量 | ≥ 5（发射时扣除 5） |
| 护盾 | 关闭（开盾期间不能开火） |
| 状态 | 存活（死亡不能开火） |

**开火意图与黑入互斥**：只要最终开火意图仍为 `true`，就不能黑入 Uplink，即使护盾、能量或冷却让这一帧没有实际射击。无人接管开火轴时，脚本锁存会一直维持该意图，直到锁存解除。抢桩脚本应避免调用 `fire()`。

```ts|py|java
最简单的输出循环：看到敌人就转炮塔并保持全自动射击。
```
```ts
const bot = {
  tick(ctx) {
    const enemy = ctx.api.nearestEnemy()
    if (enemy) {
      ctx.api.aimAt(enemy)
      ctx.api.fire() // 调一次即可，之后每 250ms 自动一发
    }
  },
}
export default bot
```
```py
def tick(ctx):
    enemy = ctx.api.nearest_enemy()
    if enemy:
        ctx.api.aim_at(enemy)
        ctx.api.fire()  # 调一次即可，之后每 250ms 自动一发
```
```java
void tick(Context ctx) {
    RobotRef enemy = ctx.api.nearestEnemy();
    if (enemy != null) {
        ctx.api.aimAt(enemy);
        ctx.api.fire(); // 调一次即可，之后每 250ms 自动一发
    }
}
```

**常见坑**：

- 在 tick 里反复调 `fire()` 想打快点：250ms 一发是硬上限，多调无效。
- 想做"点两发停一停"：v1 做不到点射，锁存只有全开和全关。
- 抢桩型机器人调用了 `fire()`：后续不再调用也不会停止；需解除锁存，或由玩家接管开火轴并停止开火。

## dash()

**做什么**：朝当前移动方向猛冲约 4.8 米。用途是赶路和拉开身位，**不是无敌闪避**——冲刺期间没有无敌帧，照样挨打。

数值：耗能 20、冷却 2.5s、持续 0.3s、冲刺速度 16 m/s。

**方向规则**：冲刺方向取**当前仲裁后的移动向量**（可能沿用先前锁存值，也可能由玩家接管）；只有该向量为零时，才朝炮塔指向冲。脚本同时调用 `move` 和 `dash` 可表达方向，同一帧内先后顺序不影响结果。

**游戏规则**：冷却没到或能量不足 20 时，当帧不冲刺，但已锁存的意图保留。

**锁存是电平触发**：`dash()` 调一次后，之后每逢冷却和能量允许就**自动再冲**并扣 20 能量。脚本没有单次冲刺后主动关闭的参数；只调用一帧也不能保证只冲一次。

```ts|py|java
向后撤的同时触发冲刺：先给 move 方向，再调 dash。
```
```ts
const bot = {
  tick(ctx) {
    ctx.api.move(-1, 0) // 这帧的移动方向 = 冲刺方向
    if (ctx.self.hp < 30) ctx.api.dash() // 首次残血时锁存，后续仍可能自动连冲
  },
}
export default bot
```
```py
def tick(ctx):
    ctx.api.move(-1, 0)  # 这帧的移动方向 = 冲刺方向
    if ctx.self.hp < 30:
        ctx.api.dash()   # 首次残血时锁存，后续仍可能自动连冲
```
```java
void tick(Context ctx) {
    ctx.api.move(-1, 0);              // 这帧的移动方向 = 冲刺方向
    if (ctx.self.hp < 30) ctx.api.dash(); // 首次残血时锁存，后续仍可能自动连冲
}
```

**常见坑**：

- 只调 `dash()` 不更新 `move()`：可能沿旧移动方向冲；只有移动向量为零才取炮口方向。
- 能量不足 20 时反复调用：不会提前冲刺，锁存会等能量和冷却允许后再触发。
- 把 `dash()` 写进每帧路径又不想要连冲：它会每个冷却周期自动扣你 20 能量。

## shield(on)

**做什么**：护盾开关。开着时受到的伤害打 65% 折扣（只剩 35%），代价：每秒耗能 18、移动速度打八折、**完全不能开火**。

| 参数 | 类型 | 含义 |
|---|---|---|
| `on` | boolean | `true` 开盾，`false` 关盾 |

**游戏规则**：护盾每帧按"当前开关 + 剩余能量"重新结算——能量见底的那一帧盾自动熄灭；死亡强制熄盾；复活时重置。

**建议写法**：每帧显式给值，比如 `ctx.api.shield(ctx.self.hp < 30)`——状态一目了然，也不会残留。它是唯一能传 `false` 主动关闭的动作。

```ts|py|java
条件开盾：血量低于 30 就举盾，否则省着能量。
```
```ts
const bot = {
  tick(ctx) {
    ctx.api.shield(ctx.self.hp < 30)
  },
}
export default bot
```
```py
def tick(ctx):
    ctx.api.shield(ctx.self.hp < 30)
```
```java
void tick(Context ctx) {
    ctx.api.shield(ctx.self.hp < 30);
}
```

**常见坑**：

- 开盾还想开火：互斥，两样只能选一样。近战缠斗时想清楚什么时候要输出、什么时候要保命。
- 只开不关：`shield(false)` 忘了调，18 能量/秒的慢性放血会把你耗干。用上面的条件写法就不会忘。

## interact()

**做什么**：按住交互键，对 Uplink（得分设备）进行引导黑入。这是唯一的得分动作接口，配合锁存语义——"按住"正是引导需要的状态。

**黑入流程**：站到 Uplink 周围 2.5m 内（中央主桩 3m），持续引导 **8 秒**完成，+15 分（主桩 +25）。

引导期间每一帧都要满足：存活、interact 按住、**没有在开火**、没出圈。

**中断规则**：松开、移出范围、开火、死亡都会让引导进度**清零重来**（不进冷却）。**挨打不打断**——开盾硬顶着引导是合法战术，对面打不断你，只能等你先开火或先撤。

**成功之后**：你个人对**这根桩**进入 30 秒冷却，期间你不能再来黑它；别人（包括你的搭档）不受影响，可以立刻来抢。这个冷却跨死亡保留。

**锁存**：调一次 = 按住。出圈或开火会打断引导，但"按住"状态还留着——回到圈内自动继续引导。

```ts|py|java
逐步减速到桩旁，显式停止移动后持续引导；此片段不判断成功或冷却。
```
```ts
const bot = {
  tick(ctx) {
    const uplink = ctx.api.nearestUplink()
    if (!uplink) return
    const me = ctx.self.position
    const dist = Math.hypot(uplink.x - me.x, uplink.y - me.y)
    if (dist > 1) {
      ctx.api.move((uplink.x - me.x) / 3, (uplink.y - me.y) / 3)
    } else {
      ctx.api.move(0, 0) // 刹车，避免旧移动意图把自己带出引导圈
      ctx.api.interact() // 按住引导（调一次即锁存）
    }
  },
}
export default bot
```
```py
def tick(ctx):
    uplink = ctx.api.nearest_uplink()
    if not uplink:
        return
    me = ctx.self.position
    dist = math.hypot(uplink.x - me.x, uplink.y - me.y)
    if dist > 1:
        ctx.api.move((uplink.x - me.x) / 3, (uplink.y - me.y) / 3)
    else:
        ctx.api.move(0, 0)       # 刹车，避免沿旧方向冲出圈
        ctx.api.interact()       # 按住引导（调一次即锁存）
```
```java
void tick(Context ctx) {
    Vec2 uplink = ctx.api.nearestUplink();
    if (uplink == null) return;
    Vec2 me = ctx.self.position;
    double dist = Math.hypot(uplink.x - me.x, uplink.y - me.y);
    if (dist > 1) {
        ctx.api.move((uplink.x - me.x) / 3, (uplink.y - me.y) / 3);
    } else {
        ctx.api.move(0, 0);     // 刹车，避免沿旧方向冲出圈
        ctx.api.interact();     // 按住引导（调一次即锁存）
    }
}
```

> 示例库 `uplink-rusher` 演示引导计时和等待策略，在 [modules.md](modules.md) 有讲解。脚本收不到成功事件，计时只是估算；争抢、中断和手操接管都可能使估算失准。

**游戏规则**：冷却中、距离不够、正在开火时，引导安静地不生效。个人冷却（30s）不下发给你——游戏不告诉你"你还有几秒冷却"，要用 `game.time` 自己记。

**常见坑**：

- 引导到一半产生有效 `fire` 意图：8 秒进度清零；只要开火意图保留就无法继续黑入。
- 引导完成的瞬间又站桩硬等：那根桩对你已经进入 30 秒冷却，等是白等，去下一个桩或抢 Core。
- 期待游戏提示"还差几秒完成"：进度圆环是手操 HUD 才有的；脚本侧只能自己计时。

## say(text)

**做什么**：发一条全房间广播的公开喊话，在机器人头顶显示 4 秒的像素气泡，随机器人移动；机器人不在当前视野内时不会强行显示侧边消息。文本不设屏蔽，适合报点、调侃、约定战术暗号。

| 参数 | 类型 | 含义 |
|---|---|---|
| `text` | string | 任意文本 |

**游戏规则**：冷却 3 秒；冷却中的调用被安静地丢掉（无错误、无事件）。文本先做归一化（空白与控制字符统一折算为空格），上限 **160 个 Unicode 字符**，超长文本截断，纯空白内容不发送。这 3 秒冷却与手操公开聊天共享同一个服务器冷却：任一端发过喊话，另一端也要等冷却结束。

```ts|py|java
发现敌人时喊话，自记 3.5 秒间隔，避免每帧广播。
```
```ts
let lastSay = -99 // 上次喊话时间（秒）

const bot = {
  tick(ctx) {
    const enemy = ctx.api.nearestEnemy()
    if (enemy && ctx.game.time - lastSay > 3.5) {
      ctx.api.say('enemies near core ' + enemy.id)
      lastSay = ctx.game.time
    }
  },
}
export default bot
```
```py
last_say = -99  # 上次喊话时间（秒）

def tick(ctx):
    enemy = ctx.api.nearest_enemy()
    if enemy and ctx.game.time - last_say > 3.5:
        ctx.api.say('enemies near core ' + str(enemy.id))
        last_say = ctx.game.time
```
```java
double lastSay = -99; // 上次喊话时间（秒）

void tick(Context ctx) {
    RobotRef enemy = ctx.api.nearestEnemy();
    if (enemy != null && ctx.game.time - lastSay > 3.5) {
        ctx.api.say("enemies near core " + enemy.id);
        lastSay = ctx.game.time;
    }
}
```

**常见坑**：

- 在 tick 里每帧喊：冷却就绪时第一条会发出，此后 3 秒内的调用被丢弃。自己留 3 秒以上的间隔即可节流。
- 把 say 当队内频道：全场都看得到，和搭档的私密约定请用暗号或靠走位默契。
