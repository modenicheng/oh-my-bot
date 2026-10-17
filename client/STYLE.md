# client UI 设计令牌

科技感来自对齐、密度与克制的荧光，不靠渐变与圆角。

## 页面代码归属

- `index.html` 保留页面结构；`src/app.css` 维护页面基础样式与设计令牌，组件样式仍由各组件维护。
- `src/main.ts` 协调玩家连接、对局、工作台与路由，不直接维护表单或辅助页面实例。
- `src/app/lobby.ts` 负责进房校验、颜色选择、大厅状态与房主操作的呈现；网络发送交回入口。
- `src/app/auxiliary-views.ts` 管理手册、回放与观战页面的创建、复用、返回和销毁；不持有玩家会话。
- `src/startup.ts` / `src/startup.css` 负责首屏加载、动效与可信手势音频解锁，避免混入大厅逻辑。
- `src/game/scoreboard.ts` / `scoreboard.css` 统一管理积分状态、榜单行和结算称号；实战、观战、回放复用展示，不在 HUD 中复制计分规则。
- `src/music/bgm.ts` 管理三段背景音乐与当前视图的对应关系；`audio.ts` 持有共享 AudioContext 并统一控制静音、音量和后台暂停。
- `src/debug/` 负责 F3 左上角调试浮层：单张 Canvas 以 4Hz 绘制读数与曲线，固定 TypedArray 环形缓冲保留最近 30 秒；隐藏时只采样，后台暂停，恢复时丢弃过期数据。WS 有效载荷、消息数、活跃连接与 RTT 由 `packages/protocol/src/ws-metrics.ts` 汇总，关闭连接即移除。
- `src/game/input/touch-state.ts` 负责无 DOM 的双摇杆状态机；`mobile-controls.ts` / `.css` 负责指针捕获、触控 HUD 与右手技能区。`app/landscape.ts` / `mobile-shell.css` 统一横屏页面、竖屏旋转回退和逻辑坐标，`orientation.ts` 监听战场几何失效。所有画布、指针与浮层通过共享坐标转换，避免旋转后方向和点击偏移。输入沿用 `input.ts` 的序号与分轴接管，单发走独立请求而非 held fire 脉冲。触控战斗按钮与画布共用焦点域，文本面板仍释放手操。

调整这些边界后，在仓库根目录运行 `pnpm typecheck`、`pnpm exec vitest run`、`pnpm build`，再运行 `pnpm --filter client test:startup` 验证启动、进房、房主操作、页面往返、观战/回放积分、结算以及三段音乐切换。此浏览器检查使用确定性协议测试桩，不替代真实服务器的对局测试。

调试浮层另运行 `pnpm --filter client test:debug`：填满 30 秒历史后检查绘制频率、持续 DOM 写入与布局读取，并覆盖 WS 心跳、F3、输入焦点、内存读数缺失和小屏尺寸；截图写入 `.artifacts/debug-panel/`。内存曲线仅为浏览器可选的 JS 堆估计，网络带宽仅为应用 WS 载荷（含心跳），RTT 为活跃 WS 最近心跳测量的最大值。

移动操作另运行 `pnpm --filter client test:mobile`，需先构建 `client/dist` 和 `server/omb.exe`（可用 `OMB_BINARY` 指定服务器）。测试连接真实服务器，以 CDP 多点触摸验证单发、连发、技能转移、旋转与面板取消，并保存四档横屏截图至 `.artifacts/mobile-controls/`。浏览器仿真不代替 Android Chrome / iPhone Safari 的真机方向锁定、边缘手势和操作手感验收。

## 色板

| 令牌 | 值 | 用途 |
|---|---|---|
| `bg-0` | `#0a0e14` | 页面底 |
| `bg-1` | `#10141a` | 面板底 |
| `bg-2` | `#161b24` | 次级面板/输入底 |
| `line` | `#1f2733` | 1px 分隔线与容器描边 |
| `text` | `#d8dee9` | 正文 |
| `dim` | `#8b98a9` | 次级文字 |
| `neon-cyan` | `#22d3ee` | 主强调：链接、选中态、自机指示 |
| `neon-lime` | `#a3e635` | 成功 / 上行 |
| `health` | `#b9d985` | 常态生命条 / 搭档指示（低饱和） |
| `neon-red` | `#ff5c5c` | 危险 / 受击 |
| `neon-amber` | `#fbbf24` | 警告；技能点/成长（菱形语义形状，ADR-0016）；能量条统一使用 cyan |

## 形状

- **默认 radius 0**：按钮、面板、输入框、代码块一律直角。
- 圆只留给语义圆形元素：雷达环、进度环、机器人本体渲染。

## 荧光纪律

- 荧光只用于**状态与数据高亮**：指示灯、选中态、图表数据线、关键数值。
- 局内正文不发光；线条/指示器可用 `box-shadow: 0 0 8px <color>40%` 级微光。首屏按产品要求例外：ASCII 像素标题与细小的 PRESS TO START 提示可使用渐变、周期微光和轻浮动；减少动效模式下停止动画。局内升级的可购买条目可使用低对比琥珀扫光提示，文字不发光；点数不足或满级时不播放，减少动效模式下仅保留静态描边与下一级刻度提示。
- 同屏荧光色不超过 2 种主色，其余退回 `text`/`dim`。

## 字体

- UI：`Inter, system-ui, sans-serif`
- 数据/代码/时序：`ui-monospace, "JetBrains Mono", monospace`（计分板、日志、编辑器）；HUD 数字与标题用 `Fusion Pixel` 像素字体，含击杀/上链/转段横幅及机器人头顶发言气泡，其余文本不用像素字体
- 计数器（Console 条数、重复折叠徽标等随运行增长的数字）：用 `--mono` 并设 `font-variant-numeric: tabular-nums`，按位数预留 `min-width`（至少 3ch）且右对齐，位数增长时不推挤相邻控件

## 图形与入口

- UI 图标使用 `src/icons.ts` 的自绘 16×16 像素 SVG，同一几何路径可由 Canvas 绘制；不用 emoji、箭头字符或平台字体充当图标。仅图标按钮必须有中文 `aria-label`。
- `src/assets/` 的机器人、炮塔、核心和上传桩 SVG 供实战/回放共用；金属材质用中性色明暗，状态圈提供阵营色。
- `src/game/art.ts` 共用竞技场、掩体与实体绘制。画布采用偏蓝的深色层次（底 `#070d14`、地面 `#101b25`、掩体 `#293e4c`），低对比地面衬托实体；危险线条用 `#ff756d`。80m 围栏必须清楚，出生平台不代表可碰撞障碍。
- 对局保留“文档 M”和“编辑器 C”入口；右侧文档在上、编辑器在下，可独立收起，单窗占满整列，侧栏宽度与上下分栏可拖拽（分隔柄支持方向键与 Home/End，尺寸存本地浏览器）。`M` 开关文档，`Tab` 保留原生焦点导航。手操跟随战场画布焦点：画布聚焦即手操（面板开着也一样），焦点进入文档/编辑器/聊天则释放，战场持续刷新；输入文字或使用输入法时不触发游戏快捷键。大厅手册仍为独立阅读页。
- 动效随模拟 tick 推进并尊重 `prefers-reduced-motion`。全景相机需留出标题和时间轴的空间。

## 背景纹理

- 细网格（1px `line` @ 4% alpha，24px 网距）可作全局背景；大面积扫描线动画仅用于加载/转段时刻，升级扫光只裁剪在可购买条目内部。
