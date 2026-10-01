---
title: 便利层参考（L1）
audience: coder
order: 42
tags: [脚本, L1]
---

# 便利层参考（L1）

L1 是 7 个常用组合动作，帮你省掉重复样板代码。它们最终都落到 [L0 原语](actions.md)上——比如 `moveTo` 内部就是归一化的 `move`。

## moveTo(pos)

**做什么**：朝目标点移动。内部把"我到目标点的连线"归一成方向，调用 `move(dx/L, dy/L)`。

| 参数 | 类型 | 含义 |
|---|---|---|
| `pos` | `{ x, y }` | 目标点世界坐标 |

距离小于一亿分之一米（数学意义上的原地）时不发 move，机器人不动。

```ts|py|java
朝最近的 Core 移动。
```
```ts
const bot = {
  tick(ctx) {
    const core = ctx.api.nearestCore()
    if (core) ctx.api.moveTo(core)
  },
}
export default bot
```
```py
def tick(ctx):
    core = ctx.api.nearest_core()
    if core:
        ctx.api.move_to(core)
```
```java
void tick(Context ctx) {
    Vec2 core = ctx.api.nearestCore();
    if (core != null) ctx.api.moveTo(core);
}
```

**游戏规则**：继承 `move` 的全部约束（加速度、限速、非法值拒绝）。参数不是 `{ x, y }` 形状时抛异常 `moveTo: expected { x, y }`。

**常见坑**：

- 期待"贴点停靠"：`moveTo` 只表达"朝这走"，不会自动刹车，也不保证到达。到点判定自己写——留个阈值（比如距离 < 2m 就算到了），再留一拍延迟的余量。示例库 `patrol.ts` 是标准写法。

## aimAt(target)

**做什么**：直接瞄一个看得见的机器人，不用自己算角度。这是 `aimAt` 的实体重载——传数字按角度、传机器人按实体，同一个名字，游戏按参数类型自动区分。

| 参数 | 类型 | 含义 |
|---|---|---|
| `target` | RobotRef | 要瞄准的机器人（必须是可见实体） |

完整语义（弧度约定、非法值处理）见[动作参考 aimAt](actions.md)。

**游戏规则**：传**不可见**的机器人（被墙挡住、超出视野，搭档除外）会当场抛异常 `aimAt: entity not visible`；当帧没接住的话，该帧全部脚本动作作废。

**常见坑**：先确认目标在 `ctx.scan().robots` 里再传，搭档不用确认。

## nearestEnemy()

**做什么**：找视野内最近的敌人。**只搜 20m 视野内**——不含搭档、不含自己、不含死者。一个都看不见时返回 `null`。

```ts|py|java
看到敌人才转向开火。
```
```ts
const bot = {
  tick(ctx) {
    const enemy = ctx.api.nearestEnemy()
    if (enemy) {
      ctx.api.aimAt(enemy)
      ctx.api.fire()
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
        ctx.api.fire()
```
```java
void tick(Context ctx) {
    RobotRef enemy = ctx.api.nearestEnemy();
    if (enemy != null) {
        ctx.api.aimAt(enemy);
        ctx.api.fire();
    }
}
```

**常见坑**：

- 把它当全图索敌：它只搜 20m 视野。20m 外没有敌人 ≠ 全图安全。
- 返回值是**调用那一刻的快照**：目标下一帧走出视野，你缓存的对象就失效了（再读会得到过时位置，游戏不保证内容更新）。每帧重取，别缓存着长用。

## nearestCore()

**做什么**：找全图最近的**存活** Core 的坐标。Core 不受视野限制（恒全量可见），所以这是全局导航用的。

返回值是**纯坐标 `{ x, y }`**——没有 id。需要区分是哪颗 Core（比如记住"我在追第 3 颗"）时，用 `ctx.scan().cores`，那里每颗都带 id。找不到（全被捡完了）返回 `null`。

```ts|py|java
全图 Core 都可见：直接朝最近的去。
```
```ts
const bot = {
  tick(ctx) {
    const core = ctx.api.nearestCore()
    if (core) ctx.api.moveTo(core)
    else ctx.api.move(0, 0) // 暂无 Core，原地待刷
  },
}
export default bot
```
```py
def tick(ctx):
    core = ctx.api.nearest_core()
    if core:
        ctx.api.move_to(core)
    else:
        ctx.api.move(0, 0)  # 暂无 Core，原地待刷
```
```java
void tick(Context ctx) {
    Vec2 core = ctx.api.nearestCore();
    if (core != null) ctx.api.moveTo(core);
    else ctx.api.move(0, 0); // 暂无 Core，原地待刷
}
```

**常见坑**：把"最近的 Core"当"下一个必得"——别人也在抢，你到达时它可能刚被捡走。每帧重取就行，别规划太远。

## nearestUplink()

**做什么**：找全图最近的**激活** Uplink 的坐标。Uplink 恒全量可见，但**未激活的桩不进候选**——中央主桩要到 CORE_OPEN（4:00）才算激活。没有激活桩时返回 `null`。

返回值同样是**纯坐标 `{ x, y }`**——没有 id、没有 ready 状态、没有持有者、**没有你的个人冷却**。桩的详细状态在 `ctx.scan().uplinks` 里查（那里有 `id`、`ready`、`holder`）；脚本拿不到你的 30 秒个人冷却和成功事件；可用 `game.time` 估算等待时间，但不能据此确认成功（示例库 `uplink-rusher.ts` 演示这一限制）。

```ts|py|java
接近最近激活桩并刹车引导；成功后真实冷却仍由服务器强制。
```
```ts
const bot = {
  tick(ctx) {
    const uplink = ctx.api.nearestUplink()
    if (!uplink) { ctx.api.move(0, 0); return }
    const me = ctx.self.position
    const dist = Math.hypot(uplink.x - me.x, uplink.y - me.y)
    if (dist > 1) ctx.api.move((uplink.x - me.x) / 3, (uplink.y - me.y) / 3)
    else { ctx.api.move(0, 0); ctx.api.interact() }
  },
}
export default bot
```
```py
def tick(ctx):
    uplink = ctx.api.nearest_uplink()
    if not uplink:
        ctx.api.move(0, 0)
        return
    me = ctx.self.position
    dist = math.hypot(uplink.x - me.x, uplink.y - me.y)
    if dist > 1:
        ctx.api.move((uplink.x - me.x) / 3, (uplink.y - me.y) / 3)
    else:
        ctx.api.move(0, 0)
        ctx.api.interact()
```
```java
void tick(Context ctx) {
    Vec2 uplink = ctx.api.nearestUplink();
    if (uplink == null) { ctx.api.move(0, 0); return; }
    Vec2 me = ctx.self.position;
    double dist = Math.hypot(uplink.x - me.x, uplink.y - me.y);
    if (dist > 1) ctx.api.move((uplink.x - me.x) / 3, (uplink.y - me.y) / 3);
    else { ctx.api.move(0, 0); ctx.api.interact(); }
}
```

**常见坑**：只看 `nearestUplink()` 就冲过去——它不含"这桩现在能不能黑"的信息。`ready`、你的个人冷却都要另查另记。

## partner()

**做什么**：拿本局搭档的引用。搭档恒可见（隔墙、无限距）、弹丸互免，是唯一可靠的"全图信标"——可以拿他的位置当集合点或导航参照。

奇数人数时会有一名玩家没有搭档；未配对时返回 `null`。

```ts|py|java
没接敌就跟上搭档——先判空再使用。
```
```ts
const bot = {
  tick(ctx) {
    const partner = ctx.api.partner()
    if (!partner) return // 没搭档（奇数局末位）：退化为普通策略
    const enemy = ctx.api.nearestEnemy()
    if (!enemy) ctx.api.moveTo(partner.position)
  },
}
export default bot
```
```py
def tick(ctx):
    partner = ctx.api.partner()
    if not partner:
        return  # 没搭档（奇数局末位）：退化为普通策略
    enemy = ctx.api.nearest_enemy()
    if not enemy:
        ctx.api.move_to(partner.position)
```
```java
void tick(Context ctx) {
    RobotRef partner = ctx.api.partner();
    if (partner == null) return; // 没搭档（奇数局末位）：退化为普通策略
    RobotRef enemy = ctx.api.nearestEnemy();
    if (enemy == null) ctx.api.moveTo(partner.position);
}
```

**常见坑**：不判空直接 `.position`——奇数局末位玩家会当场抛异常，该帧全部脚本动作作废。先判 `null`。

## pulseScan()

**做什么**：主动增强感知，返回调用当帧的感知快照（和 `scan()` 同源同刻）。

数值设计：耗 12 能量、冷却 2 秒、设计半径 32m、不穿墙。

**当前对局行为**：服务端构建脚本观察和客户端快照时使用本帧的感知半径，普通扫描为 20m，成功执行脉冲的帧为 32m，均受墙体遮挡。调用 `pulseScan()` 返回的是当次调用时已有的快照，不是执行后的新视野；不要用返回值判断脉冲是否成功。

**游戏规则**：脚本调用始终返回当前快照，同时提交脉冲意图。能量不足或冷却未到时，服务器不执行脉冲、也不扣能量；返回值不能用来判断是否成功。

**常见坑**：把非空返回值当作脉冲成功凭据。当前返回的是调用时已有的快照；冷却中的重复请求不会扩大视野。
