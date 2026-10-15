---
title: 写第一个 Bot
audience: both
order: 31
tags: [脚本, 入门]
---

# 写第一个 Bot

Bot Script 是你给机器人写的控制程序，用 JavaScript 或 TypeScript，在网页编辑器里提交，服务器负责运行和热更。

这一页从零讲起：先建立心智模型，再写五行代码跑起来，最后过一遍感知、动作和提交规则。

## 心智模型：程序每秒被念 60 遍

游戏世界每秒推进 60 帧。你的程序不是"跑一次就完"的脚本，而是**一份每秒被念 60 遍的指令清单**：

- 第 1 帧念一遍，机器人照做；
- 第 2 帧再念一遍，再照做一遍；
- 一局默认 8 分钟（28,800 帧；房主建房可另配时长，脚本按 `game.time` 自适应即可）。

所以你写的不是"先走三秒再开枪"这种流程表，而是"每一帧该怎么办"的决策规则：看到敌人就瞄，附近有 Core 就过去捡。游戏每帧问一次"这一帧干嘛"，你答一次。这个每帧被调用的函数叫 `tick`。

![一帧的流水线：你的 tick 在第 T 帧读世界，指令第 T+1 帧生效](../reference/images/diagrams/tick-loop.png)

## 五行代码起步

```ts|js
两种写法等价：TS 版直接写类型，JS 版用 JSDoc 注释拿类型提示。游戏只运行 JS，TS 提交前会在浏览器里编译成 JS。
```
```ts
import type { BotContext } from '@omb/bot-api'

function tick(bot: BotContext) {
  const core = bot.nearestCore()
  if (core) bot.navigateTo(core)
}
```
```js
/** @param {import('@omb/bot-api').BotContext} bot */
function tick(bot) {
  const core = bot.nearestCore()
  if (core) bot.navigateTo(core)
}
```

逐行拆开看：

| 代码 | 人话 |
|---|---|
| `import type { BotContext } ...` | 只给编辑器看类型。服务器跑的是编译后的 JS，这行会被剥掉 |
| `function tick(bot: BotContext) {` | 每帧游戏调用这个函数，`bot` 是当帧的控制对象 |
| `bot.nearestCore()` | 问一句"当前观察里最近的存活 Core 在哪"，没有就返回 `null`，不代表全图没有 Core |
| `if (core) ...` | 找到了才走 |
| `bot.navigateTo(core)` | 沿服务器算好的路线走过去。碰到 Core 自动拾取 |

## 在网页编辑器里提交

1. **打开编辑器**。对局顶部点 **编辑器**，或按 `C`。文档（`M`）和编辑器可以上下分栏同开。
2. **选语言**。右上角 **JS / TS** 开关，按房间码加昵称记住。两种语言的草稿分开存，互不覆盖。
3. **写代码**。Monaco 编辑器给你语法检查、类型检查和 API 补全。检查只是参考，不代表服务器会接受，更不代表打得好。
4. **提交**。点 **提交到机器人**，或按 `Ctrl+Enter`（macOS 是 `Cmd+Enter`）。TS 模式先在浏览器里编译，编译失败不发任何内容，旧脚本继续跑。
5. **等回执**。成功时显示"服务器已加载 rN"，新脚本从下一帧起执行。失败会给出原因，旧脚本照常跑。断线或超时表示结果未知，别当成失败。
6. **开辅助**。提交成功不会自动开辅助。旁边的 **辅助 ON/OFF** 是独立开关，打开后脚本动作才生效。
7. **看日志**。`console.log` 显示在编辑器下方，带脚本版本和帧号。超长或刷屏的日志会提示截断。

草稿按"房间码 + 昵称 + 语言"存在浏览器本地，刷新不丢。刷新页面和开新局都不会自动提交。

## `bot` 是每帧递给你的东西

```js
bot.self   // 你自己：id、血量、能量、位置、速度、upgrade（当帧快照）
bot.game   // 对局：已进行时间、剩余时间、当前阶段、upgradeCosts；mapSeed 已弃用且恒为 0
bot.scan() // 感知快照，免费，每帧随便读
bot.move() // 动作和便利方法都挂在同一个 bot 上
```

三条规则要背下来：

- **模块级变量就是你的记忆。** 写在 `tick` 外面的变量跨帧存活，"上一个目标是谁""巡逻到第几个点"都靠它记。热更成功程序重建，记忆从零开始。
- **每帧最多算 10 毫秒。** 超时这一帧的动作全部作废，人的手操不受影响，下一帧恢复。这是防死循环的保护，正常写碰不到。每帧都超时，就等于每帧都没有动作。
- **一拍延迟。** 你在第 T 帧看到的世界是 T 时刻的，指令到 T+1 帧才生效。所有"到位"判断都要留余量：写"距离小于 2m 就算到了"，别写"距离等于 0"。

`bot` 参数每帧都是新建的，别把自己的状态挂上去；要记东西就放模块级变量。

## 感知：`scan()` 不要钱

服务器每帧替你算好一张局部快照：机器人、炮弹、Core、Uplink、血包和技能点晶片，都按当前感知半径与视线遮挡裁剪。普通视野为 20m，成功执行脉冲的帧为 32m；墙体和未开放锁区会遮挡视线。

![感知示意：当前半径与视线遮挡共同限制观察](../reference/images/diagrams/vision.png)

图中如仍标有 Core / Uplink 全图公开，那是旧规则；以本节的局部感知规则为准，图片尚未重绘。浏览器可靠引导包仍携带完整静态地形，供稳定绘制墙、地板、竞技场边界与相机范围，并用半透明雾保留地形参照；这不表示动态实体或资源状态全图可见，也不会让脚本得到隐藏几何、生成参数或种子。观战与离线回放使用独立的全知数据流。

```js
const obs = bot.scan()
obs.robots       // 看得见的机器人：{ id, position, hp, velocity, maxHp, maxEnergy }
obs.cores        // 当前可见的存活 Core：{ id, x, y, value? }
obs.uplinks      // 当前可见的 Uplink：{ id, x, y, ready, holder? }
obs.projectiles  // 看得见的炮弹：{ id, x, y }
obs.healthPacks  // 当前可见的固定血包点及状态：{ id, x, y, available, respawnInS }
obs.pointDrops   // 当前可见的存活技能点晶片：{ id, x, y, points }
obs.walls        // 可见墙面片段：{ id, min, max }，可为零厚度 AABB，不含隐藏墙背面
obs.boundaries   // 可见边界线段：{ kind: 'arena' | 'lock', start, end }
obs.tick         // 快照对应的帧号
```

- `scan()` 零能量、零动作成本，每帧读多少次都行。
- 看不见的实体和资源不在这张表里。离开当前半径或被遮挡后消失，**不等于被拾取、死亡或全图不存在**。
- 你自己不在 `robots` 里，用 `bot.self`；已阵亡的会被过滤。
- `bot.pulseScan()` 花 12 能量、冷却 2 秒，成功执行的那一帧视野扩到 32m。它返回的仍是调用前的快照，别拿返回值判断成功。
- `pointDrops` 与其他资源一样受当前距离和视线遮挡裁剪，`scan()` / `pulseScan()` 同享当前观察；环境晶片每只 1 点，赏金晶片每只 1–4 点，生成 30 秒后过期，接触拾取谁碰归谁，只给技能点不给计分。未开放锁区不会因扫描而变成可见、可通行或可拾取区域。
- `walls` 只给可见墙面，片段 id 只在该快照内有效；`boundaries` 只给可见竞技场或锁区表面，不是完整地图轮廓。`game.mapSeed` 已弃用，恒为 `0`，不能用来重建隐藏地图。

逐字段说明在[数据结构参考](../reference/data.md)。

## 动作速查

原语八个，自己组合策略：

| 方法 | 一句话 |
|---|---|
| `move(vx, vy)` | 表达移动方向和力度，满速 8 m/s |
| `aimAt(angle)` | 炮塔转向，单位弧度 |
| `fire()` | 开火，250ms 一发，耗能 5 |
| `dash()` | 按住式冲刺：15 m/s（加速度 60 m/s² 渐变），耗能 20/秒 |
| `shield(on)` | 开关护盾：减伤 65%，不能开火，耗能 18/秒 |
| `interact()` | 按住引导，黑入 Uplink |
| `say(text)` | 全场喊话，3 秒冷却 |
| `buyUpgrade(track)` | 排队购买一级升级，返回 `void`，下一帧快照确认结果 |

便利层八个，省掉重复代码：

| 方法 | 一句话 |
|---|---|
| `moveTo(pos)` | 直线走向目标点，不绕障碍 |
| `navigateTo(pos)` | 基于当前局部观察寻路，不使用隐藏地图，不能代替探索 |
| `aimAt(target)` | 直接瞄一个看得见的机器人 |
| `nearestEnemy()` | 视野内最近的敌人，没有返回 `null` |
| `nearestCore()` | 当前观察里最近的存活 Core，没有返回 `null` |
| `nearestPointDrop()` | 当前观察里最近的存活晶片，含 `id` / `points`；没有返回 `null` |
| `nearestUplink()` | 当前观察里最近的激活 Uplink，没有返回 `null` |
| `pulseScan()` | 花能量的增强感知 |

每个动作的参数、判定和坑，见[动作参考](../reference/actions.md)与[便利层参考](../reference/helpers.md)。

## 技能点：脚本也能买升级

拾取普通 Core 得 2 技能点，Mega 得 5；每颗新增普通/Mega Core 在同环带附带最多 1/2 只各 1 点的环境晶片，还受全场环境晶片存量上限 `ceil(参赛机器人席位数 / 4)` 约束。参赛者含 bot，死亡者仍计席位；4/64/200/256 人分别最多 1/16/50/64 只。剩余额度不足时只发可容纳的只数，满额时只生 Core；拾取或 30 秒过期释放额度，后续新增 Core 才补充。赏金晶片不占环境额度、不受该上限约束；不保证固定的每颗总收益，也不再守恒旧 5/10 点预算。

存活 Core 不搬家，也不重复生成晶片。Core 每次重生换位置，不要守着旧刷点；血包仍固定。这是与计分、能量分开的货币。`bot.self.upgrade` 给出仅自己可见的 `points`、五轨 `levels` 和服务端派生的赏金标志 `bounty`。轨名是 `'hp' | 'speed' | 'shield' | 'attack' | 'energy'`，当前每轨 0–10 级。

`bot.game.upgradeCosts[L]` 是从 L 升到 L+1 的成本，数组长度就是满级。当前曲线为 `[2, 3, 5, 8, 12, 18, 27, 40, 60, 90]`，开局冻结，脚本应读取它而不是硬编码价格。只在买得起时排队买一级血量：

```ts
import type { BotContext } from '@omb/bot-api'

function tick(bot: BotContext) {
  const upgrade = bot.self.upgrade
  const cost = bot.game.upgradeCosts[upgrade.levels.hp]
  if (cost !== undefined && upgrade.points >= cost) bot.buyUpgrade('hp')
}
```

**快照是真相，不是购物车。** `self.upgrade`、嵌套 `levels`、`game.upgradeCosts` 与 `obs.pointDrops` 的数组及晶片对象均为只读、冻结数据；不能通过改写它们改世界，旧快照也不会自动更新。成本曲线可跨帧复用，其余每帧重取。`buyUpgrade()` 返回 `void`，不会立刻扣掉你正在读的快照点数或改等级，也不返回成功与否；结果以下一 tick 的 `self.upgrade` 为准。同一帧循环购买时必须自己预扣预算，不能用未更新的快照写 `while`。

购买管线：`buyUpgrade(track)` 校验字符串（非法值抛 `TypeError`）→ 追加本 tick collector 队列 → `ScriptCommands.Upgrades` → `ApplyScriptCommands` 克隆到 `PendingScript` → `consumeInputs` 在死亡分支前追加到 `PendingUpgrades` → 逐条校验、扣点，并记入同一条 `ControlRecord.Upgrades` 供回放。

- **按次累积，不是最后一次覆盖。** 人类购买先入队，脚本购买随后按调用顺序追加；两者共享每 tick 最多 8 次的上限，超出丢弃。每次购买都按前面购买后的余额与等级重新判定。
- **仅正式局可买。** 点数不足、已满级或热身期请求均静默无效，没有 nack。热身期由 glue 剥离购买队列；`game.phase` 只是地图阶段，不是热身标志。
- **死亡期间也能买。** 复活按新上限恢复；购买不参与手操/脚本的分轴仲裁，也不算打破复活无敌的操作。
- **异常和超时不能偷花钱。** 这一 tick 的购买队列与其他脚本意图一并清空；人的购买不受影响。

当前任一轨达到 L4 就进入赏金状态：阵亡散落全部自由点数，余额低时还可能掉 1 级。**自己的赏金状态只读 `self.upgrade.bounty`**，不要硬编码 L4，门槛可能调参。他人的五轨 build 不公开；只能从可见 `RobotRef.maxHp` / `maxEnergy` 反推血量/能量等级，不能推断其余三轨。完整映射见[数据结构参考](../reference/data.md)。

抢晶片可用 `bot.nearestPointDrop()`（没有返回 `null`）或自己筛 `bot.scan().pointDrops`；环境晶片每只 1 点，赏金晶片每只 1–4 点，30 秒未捡消失，无剩余寿命字段。它们只搜索当前半径与视线内的晶片，不探测隐藏或锁区内不可见的晶片；最近不等于可达，离开视野也不等于被拾取。

## 能量：动作的消耗

基础能量上限 100，能量轨升级后最高 300，每秒回复始终 10。以下动作消耗能量；买升级只花技能点：

| 动作 | 消耗 |
|---|---|
| 开火 | 5 / 发 |
| 冲刺 | 20 / 秒 |
| 护盾 | 18 / 秒 |
| 脉冲扫描 | 12 / 次 |

不算回复，100 能量能打 20 发、冲刺 5 秒或者举盾 5.6 秒。算上每秒回 10，一路猛冲净耗约 10/秒，一直举盾净耗约 8/秒。护盾和冲刺同 tick 只能选一个，护盾优先。脚本要按需调用，别无条件拉满。

## 和手操共存

脚本跑着，玩家照样能随时插手。控制权拆成四根轴：

![四根控制轴：人一碰就抢占，按 Space 交还](../reference/images/diagrams/control-axes.png)

人被抢走的轴，你的指令自动失效，你不需要配合。别想着"检测玩家在开车然后让位"，脚本**看不到**手操状态，游戏也没打算让你看。每帧照常发全部指令就行。

升级购买不属于这四根轴：人类和脚本请求按前述顺序合并，不会互相抢占。

## 提交契约：JS 直提，TS 先编译

服务器只接受能直接加载的 JS，永远收不到 TypeScript。

- **JS 模式**：源码原样提交。想有类型提示，用上面那行 JSDoc 注释。
- **TS 模式**：类型注解、`type`、`interface`、`enum` 都能写，提交时浏览器内编译成 JS 再发。编译错误按 TS 源码的原始行列提示，不会发出任何内容。

两种模式都守这些约束：

- **入口二选一**：顶层 `function tick(bot) {}`，或者 `const bot = { tick(bot) {} }` 对象，后面可以另起一行 `export default bot`。
- **有限的 import / export**：服务器会剥掉单行 `import type ...`、无绑定的 `import '模块名'`、单行 `export default ...`，以及声明前的 `export`。它不加载依赖，也不做完整模块解析。别用普通绑定导入，也别写 `export default { tick(bot) {} }`，那一整行会被删掉。
- **JS 模式不接受 TS 语法**：类型注解、`type` / `interface` / `enum`、`as const`、`Array<number>` 都会整份拒收。要写 TS 就切到 TS 模式。
- **消息大小上限 64 KiB（65536 字节）**。这是编码后的整条消息，包含 UTF-8 源码和协议开销，不只是字符数。TS 模式下编译后的 JS 和 TS 原文同帧发送、都计入。超限会在本地拦下并显示实际字节数。

拒收或加载失败时，旧脚本继续跑。

## 热更

局中随时能提交新版本，成功加载后从后续帧生效。

- 加载失败，比如语法错、缺入口，旧版本继续跑。
- 加载成功但某帧运行超时，只清空那一帧的动作，不回滚旧版本。
- 热更成功后程序重建，模块级记忆清零。这是有意设计，别依赖跨版本状态。

## 调试

- `console.log` / `info` / `warn` / `error` / `debug` 都显示在编辑器下方的 Console 面板，带脚本版本和帧号。
- 面板可以折叠、清空；新日志只在你原本贴着底部时自动跟随滚动。
- 常见故障：动作没反应，先查是不是没调、是不是能量不够、是不是护盾挡了开火；脚本不生效，先看回执是失败还是超时；`aimAt` 传了不可见的机器人会当场抛异常，那一帧的动作全部作废。

## 递进路线

1. **五行捡 Core**：上面第一个例子。
2. **加上开火**：

```ts
function tick(bot) {
  const enemy = bot.nearestEnemy()
  if (enemy) {
    bot.aimAt(enemy)
    bot.fire()
  }
}
```

3. **看阶段**：`bot.game.phase === 'CORE_OPEN'` 之后再往中央走。
4. **写状态机**：巡逻点循环、残血撤退、抢桩计时。
5. **算弹道**：游戏不给提前量，但感知里有目标 `velocity`，自己外推落点。乐趣也在这里。

`docs/manual/examples/` 下有六个完整示例，每个不超过 60 行，带注释讲解：

| 示例 | 教什么 |
|---|---|
| `hello-bot.ts` | 最小闭环：感知 → 索敌 → 转向 → 开火 |
| `patrol.ts` | 模块级状态 + 路标巡逻 |
| `core-farmer.ts` | 捡 Core 得分，路过交火 |
| `uplink-rusher.ts` | 站桩引导与等待估算 |
| `shield-brawler.ts` | 近战护盾、位移与能量管理 |
| `flank-strike.ts` | 侧翼走位与报点 |

游戏内阅读器只显示 Markdown，示例源码请到仓库里看；关键片段也内嵌在[模块语义与陷阱](../reference/modules.md)的各节里。

用中文改码的玩法见 [AI Agent](../start/ai-agent.md)。
