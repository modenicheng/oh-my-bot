# Bot Script API 升级面（v2 设计）

设计已与用户对齐并完成实现（2026-10-15）。补齐升级玩法 v1（`upgrade-system.md`）缺失的最后一块：脚本可读取点数与五轨等级、购买升级、感知赏金晶片，solo bots 自动加点。已撤销 `upgrade-system.md` 中「bot-api 不暴露升级」排除项，并销 TODO.md 对应条目；部署机长局压测与难度平衡观察仍待复验。

## 设计原则（沿既有约定，不引入新机制）

1. **与人类信息对称**：脚本与玩家的动态实体、资源状态均使用局部感知。`SelfState.upgrade` 私密 → 进 `self`；可见 `RobotState.max_hp_x10/max_energy_x10` 公开分母 → 进 `RobotRef`；当前可见 `PointDropView` → 进 `Observation`。机器人、弹丸、Core、Uplink、血包和晶片都按当前半径（普通 20m / 脉冲帧 32m）与视线遮挡裁剪，不发明隐藏资源透视。
2. **快照为真相，无 nack**：与人类购买通道一致（客户端以随后快照为准），`buyUpgrade` 不返回成功与否，以下一 tick `self.upgrade` 为准。
3. **意图全部走 `ScriptCommands` 单通道**：购买是新增命令字段而非 glue 旁路——否则配额超时清轴、Snippet 组合、`ControlRecord` 回放一致性全部破功。
4. **L0 + L1 到此为止**（game_design §11）：一个 L0 动作、一个 L1 便利函数、三个只读数据面。

2026-10-16 修订：普通/Mega Core 的直接收入为 2/5 SP；每颗新增普通/Mega Core 同波在所属环带附带最多 1/2 只各 1 SP 的环境晶片，还受全场环境晶片存量上限 `ceil(参赛机器人席位数 / 4)` 约束。参赛者含 bot、死亡者仍计席位，4/64/200/256 人分别最多 1/16/50/64 只。只使用剩余额度，满额时只生 Core；拾取或 30 秒过期释放额度，后续新增 Core 才补充。赏金晶片不占环境额度、不受该上限约束，赏金规则不变。不保证固定总收益，也不再守恒旧 5/10 SP 预算。

存活 Core 不搬家、不重复发晶片，每次重生重新随机选合法位置；血包位置与冷却保持固定。checkpoint 的 `PointDrop.Ambient` 区分环境与赏金来源，以恢复供给额度；该字段不暴露给 Bot API。

完整静态地形仅通过浏览器可靠引导包供稳定绘制墙、地板、竞技场边界与相机范围，半透明雾保留地形参照；客户端实体、HUD、反馈仍消费局部观察。脚本、导航和 AI 感知不因此获得完整隐藏几何或生成元数据；`game.mapSeed` 已弃用且恒为 `0`。`obs.walls` 是可见墙面片段（可为零厚度 AABB，id 仅当帧有效），`obs.boundaries` 是可见 `arena` / `lock` 表面线段，不是完整地图轮廓。观战与离线回放使用独立全知数据流。

## IDL 增量（权威源 `packages/bot-api/src/index.ts`）

```ts
/** 五条升级轨（与 UpgradeRequest track 1–5 对应：hp/speed/shield/attack/energy）。 */
export type UpgradeTrack = 'hp' | 'speed' | 'shield' | 'attack' | 'energy';

export interface UpgradeLevels {
  readonly hp: number;      // 每轨 0–10
  readonly speed: number;
  readonly shield: number;
  readonly attack: number;
  readonly energy: number;
}

export interface UpgradeSelf {
  /** 自由点数（未花费）。普通 Core +2 / Mega +5；新增普通/Mega Core 附带最多 1/2 只各 +1 环境晶片，受人数存量上限约束；赏金晶片不占环境额度，赏金阵亡散落归零。 */
  readonly points: number;
  readonly levels: UpgradeLevels;
  /** 任一轨 ≥ 赏金门槛＝携带赏金：阵亡散落全部点数、可能连带掉 1 级。 */
  readonly bounty: boolean;
}

export interface Self {
  // …id/hp/energy/position/velocity 不变…
  /** 本机升级状态，仅自己可见（他人只能从 maxHp/maxEnergy 间接推断）。 */
  readonly upgrade: UpgradeSelf;
}

export interface GameInfo {
  // …time/timeLeft/phase 不变；mapSeed 仅为兼容保留，已弃用且恒为 0…
  /** 本局开局冻结的成本曲线（ADR-0016）：costs[L] = L→L+1 级所需点数；长度即满级。 */
  readonly upgradeCosts: readonly number[];   // 当前为 [2,3,5,8,12,18,27,40,60,90]
}

export interface PointDropRef {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly points: number;    // 环境晶片每只 1 点，赏金晶片每只 1–4 点
}

export interface Observation {
  // …现有字段不变，pulseScan 同享…
  /** 当前半径与视线内的技能点晶片（环境补货或赏金阵亡），生成 30s 后过期，谁碰归谁。 */
  readonly pointDrops: readonly PointDropRef[];
}

export interface RobotRef {
  // …id/position/hp/velocity 不变…
  /** 升级后血量上限（公开分母，同头顶条；可反推 hp 轨等级）。 */
  readonly maxHp: number;
  /** 升级后能量上限。 */
  readonly maxEnergy: number;
}

export interface L0 {
  // …现有动作不变…
  /**
   * 购买一级指定轨，下一 tick 生效。点数不足/已满级/热身期静默无效；
   * 同 tick 多次调用累积（与人类共享 8 次/tick 上限，超出丢弃）；
   * 非法 track 抛 TypeError。死亡期间可买（复活按新上限）。
   */
  buyUpgrade(track: UpgradeTrack): void;
}

export interface L1 {
  // …现有便利函数不变…
  /** 当前观察里最近的存活晶片；无则 null，不探测隐藏或锁区内不可见的晶片。 */
  nearestPointDrop(): PointDropRef | null;
}
```

## 语义细则（实施后进手册，成为行为基准）

**购买管线**：`buyUpgrade('hp')` → goja 绑定校验 track 字符串（非法抛 `TypeError`，对齐 `aimAt(RobotRef)` 不可见即抛的先例）→ 追加进本 tick collector 购买队列 → `ScriptCommands.Upgrades []uint8`（wire 1–5）→ `ApplyScriptCommands` 随整包克隆进 `PendingScript` → `consumeInputs` 在死亡分支前把脚本队列**追加**到 `c.PendingUpgrades`（排在人类 hub 直投之后，共享 `MaxUpgradeBuysPerTick=8` 上限）→ `applyUpgrade` 逐条消费、静默拒绝 → 记入同一条 `ControlRecord.Upgrades`（回放链路零改动，`log.go` 轨号校验已就位；`SimulationVersion>=5` 门已有）。

**与轴语义的三个不同点**（像 `say`，不像 `move`）：

- 不参与 ADR-0009 分轴仲裁——人类 `UpgradeRequest` 与脚本购买是同队列合并，不存在抢占。
- 不算「操作」，不破除复活无敌。
- 配额超时/异常 tick 的 `ClearScriptAxes` 连购买队列一起清——被打断的 tick 一分钱不花。

**热身期**：glue 在 `m.warmup` 时剥离脚本购买轴（镜像 `buyUpgradeLocked` 对人类的拦截；warmup 是 glue 概念，门放 glue）。脚本无感知，静默无效。

**信息推理表**（进手册，不做成 API）：`maxHp` 100→L0、120→L1 … 250→L10；`maxEnergy` 100→L0 … 300→L10；映射唯一可反推。≥180 血或 ≥200 能量即对手该轨 ≥L4＝赏金猎物。shield/attack/speed 无公开通道，不可推断——这正是人类能得到的信息边界。**不提供 `inferLevel()` 帮手**，推理乐趣留给脚本。

**`bounty` 做成派生字段的理由**：TODO 挂着「赏金门槛 L4 是否升 L5」观察项，脚本硬编码 4 会在调参时坏；派生布尔让服务端改门槛时脚本零感知。

**`upgradeCosts` 放 `game` 不放 `self`**：曲线是局级开局冻结常量（ADR-0016），不随个人购买变化；`mapSeed` 现仅是恒为 `0` 的兼容字段，不再传递地图种子。将来若开放每局调参（`UpgradeTuning` 协议位已留），脚本自动跟随。

## 服务端落点（实施触点，升级系统本体零改动）

| 触点 | 改动 |
|---|---|
| `sim/contract.go` | `ScriptCommands` + `Upgrades []uint8`；`ScriptFrame` + 自带 `Upg UpgradeState`（`RobotView` 是快照共享结构，不动） |
| `sim/control.go` | `ApplyScriptCommands`/`cloneCommands`/`ClearScriptAxes` 覆盖新字段；`consumeInputs` 追加脚本队列进 `PendingUpgrades` |
| `glue/match.go` | `runScripts` 填 `ScriptFrame.Upg`（selfInputOf 同源）；`m.warmup` 时剥离购买轴（ApplyScriptCommands 调用点） |
| `script/context.go` | `vmToFns` + `buyUpgrade`；`buildTickContext` 组 `self.upgrade`（`game.upgradeCosts` 装载期缓存冻结数组）；`observation.go` 透出 `pointDrops`（数据已到 `ScriptFrame.Obs.PointDrops`，现被刻意拦下）；`RobotRef` 加 `maxHp/maxEnergy`（`MaxHpX10/MaxEnergyX10` 已在 `RobotView`） |

性能：购买是有界入队操作；`pointDrops` 现包含环境补货与赏金散落，并按局部感知裁剪，不能继续假设常态 <20 项或增量开销可忽略，需用新经济与感知规则复验。solo bots 4Hz replan 节奏不变。

## 同步面（「五处平行定义」完整清单）

1. `packages/bot-api/src/index.ts` 手写 → `pnpm --filter @omb/bot-api gen`。
2. `server/internal/botapi/bot_api.gen.ts`（go:embed，AI system prompt 自动更新）。
3. `client/src/workbench/bot-completions.gen.ts`（Monaco 补全）。
4. `script/context.go` vmToFns——由 `bot_api_drift_test.go` 三测试自动钉死（`TestBotContextReadonlySurfaces` 需扩到嵌套字段 `self.upgrade`/`obs.pointDrops`）。
5. 文档：`docs/manual/code/bot-scripting.md`（行为基准）+ `reference/{data,actions,helpers}.md` + game_design §11/§19 + `upgrade-system.md` 撤销「v1 明确不做」+ TODO.md 销项 + `bots/README.md` 机制适配表（成本曲线/赏金门槛/晶片 30s TTL/锁区不拾取）。

## Solo bots 自动加点（API 之后的下游）

`soloBotSource` 在 4Hz replan tick 加花钱步骤：`points ≥ game.upgradeCosts[levels[t]]` 即按固定优先级购买，建议 **hp → attack → speed → shield → energy**（与生存/击杀相关性排序）。v1 不做「攒点避战」等赏金规避策略——有钱就花本身就是对赏金机制的正确响应（钱在钱包里才是靶子）。注意 solo bots 会明显变强，200 人压测复验时顺带观察难度漂移。

## 已否决备选

- **glue 旁路直调 `sim.BuyUpgrade`**：绕过 `ScriptCommands` 不变量——配额超时不清（超时的 tick 还在花钱）、Snippet 无法组合、归因缺失。否。
- **`buyUpgrade` 返回 bool**：购买本就下一 tick 生效，同步返回值制造「乐观成功」假象，违背「快照为真相」。void。
- **PointDrops 全图公开（旧决策，已撤销）**：现与其他资源一样按当前感知半径和视线遮挡裁剪。`scan()` / `pulseScan()` 返回同一时刻的当前观察，`nearestPointDrop()` 也只搜索该观察；离开视野不等于被拾取，未开放锁区内不可见的晶片不进入候选。
- **暴露他人五维等级**：shield/attack/speed 对人类不可见，开了就是脚本特权。只给 `maxHp/maxEnergy`。
- **`PointDropRef.ttlS`**：需给 `PointDropView` 加 `GoneAt` 派生，等脚本侧真实需求再议（脚本可自跟踪首次见到的 tick + 30s 近似）。

## 实施清单

- [x] 批1 sim：`ScriptCommands.Upgrades` + `ScriptFrame.Upg`；ApplyScriptCommands/cloneCommands/ClearScriptAxes/consumeInputs 覆盖；单测（排队上限/死亡可买/warmup 剥离/回放含脚本购买）。
- [x] 批2 script 绑定：`buyUpgrade`（TypeError 语义）+ `self.upgrade` + `game.upgradeCosts` + `obs.pointDrops` + `RobotRef.maxHp/maxEnergy`；collector 追加语义。
- [x] 批3 单源扇出：index.ts → gen → bot_api.gen.ts / bot-completions.gen.ts；drift 测试扩嵌套字段。
- [x] 批4 solo bots：soloBotSource 自动加点（4Hz replan，hp→attack→speed→shield→energy）；solo_bots_test 覆盖。
- [x] 批5 文档：手册 + reference 三件 + game_design §11/§19 + upgrade-system.md 撤销 + TODO 销项 + bots/README 适配表。
- [x] 本地收尾：`go test -p 1 -timeout 10m ./...`、`go test -race -short -p 1 -timeout 10m ./...`、`pnpm test`（56 文件 / 605 用例）、`pnpm typecheck`、gofmt/build/vet；补回放嵌套队列拒绝、checkpoint 队列校验与旧版本 no-op，最终改动后重跑 sim/script/glue race 测试。未提交或推送，因此不执行远端 CI。
- [x] 200 人进程内 API 冒烟：199 个 solo bot、240 tick、每机预置 100 点，验证升级与赏金路径；运行入口见下。
- [ ] 部署机长局/真实 WS 压测复验，并观察 solo bots 难度漂移、自然点数分布与赏金门槛 L4/L5；本地冒烟不替代此项。

### 本地 200 人冒烟记录（2026-10-15）

PowerShell 运行：`$env:OMB_UPGRADE_LOAD_TEST='1'; $env:GOGC='400'; go test ./server/internal/glue -run '^TestScriptUpgradesFullRosterSmoke$' -count=1 -v -timeout 120s`。测试在临时目录运行进程内 Match，没有启动服务或建立 WS 连接；100 点是明确预置的测试钱包，不代表自然局经济。

本次结果：199/199 bot 已加点，总等级 2875、单轨最高 L7、199 机处于赏金状态、场上晶片 506。tick 平均 10.818ms、p95 19.615ms、脚本顺延 1051（占 199×240 次调度约 2.2%）。功能冒烟通过，但 p95 高于 12ms 帧预算，不能宣称性能门通过；真实长局难度与性能仍按 TODO 观察项复验。
