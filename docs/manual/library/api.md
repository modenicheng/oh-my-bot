---
title: API 参考
audience: coder
---

# API 参考

来源 `@omb/bot-api`（`packages/bot-api/src/index.ts` + `runtime.ts`），运行时行为对齐 `server/internal/script/`（context.go / collector.go）与 `server/internal/sim/`（control.go / combat.go / objectives.go / snapshot.go）。**所有「服务端强制」行为由服务器执行，脚本侧重试、绕过、抢跑均无效。**

通用规则：

- API 调用只**记录意图**，物理结算归服务器；同一轴重复调用后者覆盖；
- 人类输入永远优先（ADR-0009）：脚本轴与手操冲突时手操赢；
- 脚本超时/异常 → 该 tick 脚本轴清空，人类轴保留。

## L0 原语（7 个）

### move(vx: number, vy: number): void

期望速度向量（非位移）。幅值 >1 归一；实际运动受加速度 24 m/s²、限速 8 m/s 约束（先到先得，无瞬移）。

```ts
ctx.api.move(1, 0)          // 持续向 +x
const d = target.position  // 追点：单位向量
ctx.api.move(d.x - ctx.self.position.x, d.y - ctx.self.position.y)
```

**服务端强制**：向量非有限（NaN/Inf）→ 该 tick 脚本轴整体清空（ApplyScriptCommands 拒收）。
**常见错误**：传坐标差当方向（未归一也行，但幅值>1 被归一后损失意图精度）；期待立即转向——有加速度斜坡。

### aimAt(angle: number): void / aimAt(target: RobotRef): void

L0：绝对角度（弧度，世界系）。L1 同名重载：传 RobotRef 按实体方位角。同一 API 名，运行时按参数类型分派。

```ts
ctx.api.aimAt(Math.PI / 2)            // 炮口朝 +y
const e = ctx.api.nearestEnemy()
if (e) ctx.api.aimAt(e)               // L1 重载
```

**服务端强制**：角度 NaN/Inf → 脚本轴清空。L1 传**不可见实体**抛 JS 异常 `aimAt: entity not visible`（tick 内未捕获 → 该 tick 轴清空）。
**常见错误**：度弧度混用（API 全弧度）；对 partner 外的墙后实体调 L1 重载。

### fire(): void

发射一发弹丸。伤害 12、弹速 30 m/s、有效射程 16m（最大 20m，超出段散布最大 ±0.12 rad）。

**服务端强制**（任一不满足即静默不发射，无错误反馈）：
- 250ms 节流（FireInterval=15 tick）；
- 能量 ≥5（发射时扣 5）；
- 护盾开启期间禁射；死亡禁射。

**轴锁存**：`fire()` 无参，调用即置 true 并锁存 = 全自动射击直到死亡/异常清轴/关辅助。**没有 `fire(false)`，v1 无法点射**；且锁存后与 hack 永久互斥（canHack 要求 !Fire）。
**常见错误**：连点无效还耗心智——节流窗口内多调只算一次；期待点射（v1 做不到）；黑桩型 bot 误触 fire 永久断 hack。

### dash(): void

冲刺位移。耗 20 能量、CD 2.5s、持续 0.3s、速度 16 m/s（≈4.8m 位移）、无无敌帧。方向取本 tick move 向量（零向量退化用炮口朝向）。

```ts
ctx.api.move(-1, 0); ctx.api.dash()   // 向后撤的同时冲刺
```

**服务端强制**：CD 未到或能量不足静默忽略。
**轴锁存**：`dash()` 无参电平触发——锁存后每逢 CD 到期自动再冲并耗 20 能量。不想要连冲就别把它放进每帧路径。
**常见错误**：只调 dash 不调 move，朝炮口方向冲（可能正冲向敌人）；能量 <20 时反复调用无效。

### shield(on: boolean): void

护盾开关。开启期间受伤 ×0.35、耗能 18/s、移速 ×0.8、禁射。每 tick 依「输入 + 能量」重算——能量见底即灭。

**服务端强制**：能量不足维持时盾自动熄火；死亡强制熄盾；复活重置。
**常见错误**：期待「开盾 + 开火」——互斥；shield(false) 忘调导致能量慢性流失。

### interact(): void

与 Uplink 交互（按住引导）。距桩 ≤2.5m（主桩 3m）持续 8s 完成黑入（+15，主桩 +25）。引导期间要求：存活、interact 按住、**未 fire**、未出圈。中断则进度清零（不进 CD）。

**服务端强制**：黑入成功后**个人 CD 30s**（该桩对该机器人）；CD/距离/开火条件不满足时引导静默失败。个人桩 CD 跨死亡保留。
**轴锁存**：`interact()` 无参，调用即置 true 并锁存 = 持续按住（引导正需要）；死亡/异常清轴/关辅助才解除。出圈/开火断引导但不清锁存，回圈自动续引导。
**常见错误**：引导中顺手 fire() 直接打断自己 8s 进度，且锁存后永久无法续引导；CD 信息不下发，自己用 `game.time` 记。

### say(text: string): void

全房可见文本（互信群体）。冷却 3s。

**服务端强制**：CD 内静默丢弃（无错误、无事件）；运行时纯透传，长度不截断。
**常见错误**：tick 循环里每帧 say——前 180 帧全被吞，还占用脚本意图提交。

## L1 便利层（7 个）

### moveTo(pos: Vec2): void

朝目标点的单位向量 move（内部 `move(dx/L, dy/L)`）。距离 <1e-9 时不发 move（原地不动）。

**服务端强制**：继承 move 全部约束（加速度/限速/非有限拒绝）。参数非 `{x,y}` 形状抛 `moveTo: expected { x, y }`。
**常见错误**：期待贴点停靠——moveTo 只表达方向，到点判定自己写（留阈值，一拍延迟）。

### nearestEnemy(): RobotRef | null

可见范围内（不含 partner、不含自己、不含死者）最近敌人。全不可见 → `null`。

**常见错误**：当全图索敌——只搜 20m 视野内；返回的 RobotRef 是**调用时刻快照**，目标出视野后下一帧就 null，别缓存长用。

### nearestCore(): Vec2 | null

全图最近存活 Core 位置（cores 恒全量可见）。无 → `null`。返回**纯 `{x, y}`**，无 id——需要区分多个 Core 时用 `scan().cores`。

**常见错误**：把它当「下一个必得」——别人也在抢，到达时可能已被拾取（每帧重取即可）。

### nearestUplink(): Vec2 | null

全图最近**激活** Uplink 位置（uplinks 恒全量可见；未激活的桩不在候选内，主桩 CORE_OPEN 才进候选）。无 → `null`。

返回**纯 `{x, y}`**，无 id/ready/holder/你的个人 CD——桩的详细状态在 `scan().uplinks` 里查，个人 CD 自己记（见 [examples/uplink-rusher.ts](examples/uplink-rusher.ts)）。

### partner(): RobotRef | null

本局搭档（恒可见、弹丸互免）。奇数局末位玩家 → `null`。

**常见错误**：不判空直接 `.position` → 运行时异常 → 该 tick 轴清空。

### pulseScan(): Observation | null

请求主动脉冲，返回本帧感知快照（与 scan() 同源同刻）。耗 12 能量、CD 2s、设计半径 32m 不穿墙。

**v1 当前实现**：脚本观测管线（snapshot.BuildObservation）视野硬编码 20m，**脉冲扩视野尚未接入脚本侧**——当前调用只扣能量与 CD，返回 20m 快照。服务器视图层（WorldView.Observe/ScanRadius）已支持 32m，接入前勿依赖扩视野战术。

**服务端强制**：能量不足/CD 未到静默忽略（能量照扣与否以 sim 结算为准：不足时不清 PulseRequested 但不扣能——净效果是不生效）。

## 数据结构

### Observation（scan() / pulseScan() 返回）

```ts
interface Observation {
  tick: number        // 帧号（60Hz）
  robots: (RobotRef & { isPartner: boolean })[]
  cores: (Vec2 & { id: number })[]
  uplinks: (Vec2 & { id: number; ready: boolean; holder?: number })[]
  projectiles: (Vec2 & { id: number })[]
}
```

| 字段 | 裁剪规则 |
|---|---|
| `robots` | 其他机器人：中心距 ≤20m 且无墙遮挡；**partner 恒在**（isPartner: true）；不含自己；死者过滤 |
| `cores` | **恒全量**，仅存活项 |
| `uplinks` | **恒全量**；`ready = 激活 && 无人持有进度`；`holder` = 当前引导者机器人 id（有进度才有） |
| `projectiles` | 同 robots 视野规则（无 partner 豁免） |

### RobotRef

```ts
interface RobotRef { id: number; position: Vec2; hp: number }
```

scan()/nearestEnemy()/partner() 返回的都是此形状（附 isPartner）。**不含速度/朝向**——预判弹道要自己差分 position。

### Self（ctx.self）

```ts
interface Self { hp: number; energy: number; position: Vec2; velocity: Vec2 }
```

每帧快照，未裁剪（自己恒可见）。控制轴归属（human/script）**不暴露**——脚本无法感知手操状态（ADR-0009）。

### GameInfo（ctx.game）

```ts
interface GameInfo {
  time: number      // 已进行秒数 = tick/60
  timeLeft: number  // 剩余秒数
  phase: 'OUTER_RING' | 'CORE_OPEN'
  mapSeed: number
}
```

阶段切换（4:00）只影响地图规则（中央区解锁、主桩激活、Core 刷新权重），不改 API 语义。

## TickContext / BotModule 生命周期

```ts
interface TickContext {
  self: Self          // 本帧快照
  game: GameInfo
  scan(): Observation // 每调每新对象，零成本
  api: L0 & L1
}
type BotModule = { tick(ctx: TickContext): void }
```

- **每帧重建 ctx，模块状态（bot 对象外/内的变量）跨帧存活**；Hot Swap 成功 → VM 重建 → 状态清零；
- **配额 10ms/tick**（可配置）：超时该 tick 脚本轴清空，下 tick 恢复；
- **失败安全**：Load 失败（语法/TS/缺入口）→ 旧脚本继续跑、状态保持、Rev 不变；tick 内异常 → 该 tick 轴清空，不影响后续 tick；
- **死亡期间脚本照常执行**（动作被 sim 门控忽略），复活后无需重初始化——但死亡期间你看到的是尸体视角的感知（robots 过滤死者，你自己不在列表）。
