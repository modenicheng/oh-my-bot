# 玩家手册重写：工作稿

目标：把 `docs/manual/` 全量重写成**双受众教程**——新手照做能上手，代码玩家读得够深。同一份 Markdown 仍是 AI Agent 的语料（ADR 0011），所以事实、签名和数值必须与源码一致。

状态：**已完成**（17 页 + 6 个示例 + README 小节 + 7 张示意图 + 16 枚图标）。本页保留为风格基线，后续改手册照这份执行。

## 范围

| 动了 | 没动 |
|---|---|
| `docs/manual/**`（17 页、6 个 `.ts` 示例、新增 `reference/images/{diagrams,icons}/`） | `docs/adr/`、`docs/design/`、`docs/plans/` |
| `README.md` 简介与玩家文档小节 | `docs/deploy.md`、`docs/runbook.md` |
| 阅读器与素材流水线：`client/src/manual/render.ts`、`client/src/manual/render.test.ts`、`client/src/app.css`、`client/capture.html`、`client/src/game/capture.ts`、`client/scripts/capture-manual-assets.mjs` | 服务器行为、协议、任何数值 |

## 写作规则

### 1. 说人话（中文）

- 主谓宾为主。删掉不必要的介词结构、被动句、把字句、抽象名词。
- 少用破折号、省略号、冒号。一句能说完就一句话。
- 长短句交替；四字词语、俗语该用就用，别硬凑。
- 直接对读者说"你"。"玩家应……"这种公文腔一律改成"你要……"。

改前 → 改后示例：

| 改前 | 改后 |
|---|---|
| 配置草稿按房间码和昵称保存在当前浏览器，服务器回执才代表已经生效。 | 草稿存在浏览器里，按房间码和昵称分开记。服务器回你"已加载"，才算真生效。 |
| 开关只影响下一次装配的对局，不会在正在进行的场内增删机器人。 | 开关只管下一场。正在打的对局不受影响。 |
| 参数非法或组合失败时，现役配置和脚本保持不变。 | 参数写错、组合失败，服务器不改动正在跑的配置。 |

### 2. 不造概念

- 引入新概念前，先用一句话解释它是什么、为什么存在，再给正式名称。
- 术语以 `CONTEXT.md` 为唯一事实源；同页只留一个主名，括号补另一个。
- 每页只解释本页要用的概念，别的概念给链接。

### 3. 双受众

每页骨架：开头 2–4 行说清这页解决什么 → 先结论/最快路径 → 再机制细节 → 每节一句收束 → 页末速查表或常见坑。

### 4. 事实纪律

- 数值、签名、行为以 `server/`、`packages/bot-api/` 源码为准；不确定就不写。
- 未接入的功能标"尚未接入"；已接入的不许再标未接入。
- 中文与英文/数字之间留一个空格。

本轮按源码订正的存量错误：

| 项 | 订正 |
|---|---|
| 中央核心区半径 | 30m → 28m，且 4:00 前挡视线与人（`sim/view.go`、`mapgen/generator.go`） |
| `RobotRef` / `Self` | 补上 `velocity` 与 `Self.id`（此前写"不提供速度"） |
| Core 节奏 | 开局 1 颗，之后每 20 秒补 1 颗；2 颗 Mega 都在核心区 |
| 热身结束语义 | 模拟跑满 8 分钟停住，房间不自动开新局 |
| Pulse Scan | 只有生效那一帧 32m，不是"几帧" |
| 称号「弹幕大师」 | 按命中次数，不是射击次数 |
| 称号「人工智障」 | 依赖当前链路没有的脚本错误事件，暂时拿不到 |
| 取物判定 | 圆接触即拾取（扫掠路径也算），不是"走到 0.6m 内" |

### 5. 图文并茂

- 每页至少一张图或一张表。
- 图是真实渲染或按 `client/STYLE.md` 色板画的示意图：暗底、直角、克制荧光。
- 图后跟一句"看什么"；alt 写清内容。
- 示意图放 `reference/images/diagrams/`，图标放 `reference/images/icons/`，跨章节用 `../reference/images/...`。

### 6. 图标

用项目自绘 16×16 像素图标（`client/src/icons.ts`），不用 emoji。行内写法固定：

```html
<img class="inline-icon" src="../reference/images/icons/fire.png" alt="">
```

每页最多 2–3 处，标在概念首次出现的位置。

### 7. 代码示例

- 默认 TS；JS 差异明显时用 `ts|js` tab 组，不出现 py/java 面板。
- 一个示例只教一件事，≤ 20 行；代码前一句"干什么"，代码后一句"坑在哪"。

## 页面清单（全部完成）

| 页 | 要点 |
|---|---|
| `index.md` | 上手四步、四种玩法、十个词、三条铁律 + 阅读路线图 |
| `start/index.md`→`start/ai-agent.md` | 进房、界面、热身、第一局、Snippet 八模块、AI Agent 配额与安全 |
| `rules/index.md`→`rules/controls.md` | 判定与地图、四轴仲裁、焦点、观战、音效、断线 |
| `code/index.md`、`code/bot-scripting.md` | tick 心智模型 → 五行起步 → 感知/动作 → 提交契约 → 热更 → 递进路线 |
| `reference/index.md`→`reference/visual.md` | 13 个动作、数据结构、语义陷阱、图鉴 |
| `examples/*.ts`（6 个） | 只改注释，代码逐字未动（已用 Goja 验证） |
| `README.md` | 简介与手册入口更新 |

## 素材（已生成）

示意图 7 张，由 `pnpm --dir client capture:manual` 生成为 2x PNG：

1. `timeline`：一局时间轴与 4:00 转段三件事
2. `map-rings`：三环八扇区、6+1 Uplink、4 血包、核心区
3. `tick-loop`：一帧流水线（10ms 预算、一拍延迟）
4. `control-axes`：四根控制轴与人工抢占
5. `vision`：20m 视野 + 遮挡 + 全量公开
6. `uplink-loop`：引导/冷却循环与中断支线
7. `reading-paths`：新手线与代码线

图标 16 枚（透明底 64×64 PNG）：fire、shield、dash、uplink、heart、energy、skull、trophy、target、book、code、spectator、replay、play、pause、chevron。同时修掉了 `sheet-icons.png` 因 `drawIcon` 用了底色 fillStyle 而整张空白的旧 bug。

## 验收（本轮结果）

1. `pnpm exec vitest run`：24 文件 243 用例全过（含 `render.test.ts` 的跨章图片与行内图标用例）。
2. `pnpm typecheck`、`pnpm --filter client build`、`pnpm --filter client test:manual`、`test:manual-live`（真二进制 embed 资源）全部通过。
3. 全仓 Markdown 链接与图片解析：84 处全部命中，0 缺失。
4. 6 个示例经 TS 编译后在 Goja 中各 tick 5 帧，覆盖高血量/低血量/无敌人/低能量/倒计时分支，无异常。
5. 事实核对：逐条对照源码（见上表订正项）。

## 后续注意

- `bash build.sh` 会 `rm -rf server/cmd/omb/{web,manual}`；本地 dev 循环（air + server/tmp/omb.exe）在跑时这两个目录可能被占用而报 `Device or resource busy`，停掉 dev 循环再构建即可。
- `docs/manual` 是唯一真相；`server/cmd/omb/manual` 只是构建期复制品，不要单独编辑。
- 阅读器没有标题锚点，跨页引用只用页面链接，别写 `#fragment`。
