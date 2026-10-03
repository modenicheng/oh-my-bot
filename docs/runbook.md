# 运行与本地调试指南

> 适用 v0.1.0+。目标：三分钟跑起完整可玩环境（双浏览器对局）。每一步都写明"在做什么"，不假设你熟悉命令行——但命令本身可原样复制。

## 前置依赖

装好这三样（版本不够会编译失败）：

| 工具 | 最低版本 | 它是干什么的 |
| --- | --- | --- |
| Go | 1.25 | 编译服务器（server/ 目录是 Go 代码） |
| Node | 22 | 运行前端构建工具 |
| pnpm | 10 | 管理前端多个包的依赖 |

以下命令在仓库根目录用 Bash 执行（Windows 可用 Git Bash）；需要切换目录的地方会明确写出。

可选：Python 3（自己写脚本分析对局日志）、Playwright（自动化浏览器测试，见下文）。

## 一键构建与运行

```bash
pnpm install           # 首次构建先安装依赖
bash build.sh          # 构建出单文件程序 server/omb.exe
cd server
./omb.exe              # 启动服务器；默认监听 127.0.0.1:27182（仅本机可访问）
```

浏览器打开 `http://127.0.0.1:27182/` 就能进房。

未设置 `-addr` 或 `OMB_ADDR` 时只绑定本机回环地址（见 ADR-0014），默认不暴露给局域网；是否出现防火墙提示取决于系统策略。监听地址由 `-addr` 控制（环境变量 `OMB_ADDR` 可兜底，显式 flag 优先）：`-addr :27182` 监听所有网卡供局域网访问，`-addr unix:/path/to/omb.sock` 绑 unix socket 供反向代理连接——完整说明见 [deploy.md](deploy.md)。

`build.sh` 按依赖顺序做了五件事：

1. `pnpm -r typecheck` —— 全部前端包做类型检查，先抓低级错误
2. `pnpm --filter client build` —— 把客户端源码打包成浏览器可用的静态文件（产出 `client/dist/`）
3. 拷贝 `client/dist/*` → `server/cmd/omb/web/` —— 前端产物放进服务器要内嵌的位置
4. 拷贝 `docs/manual/*` → `server/cmd/omb/manual/` —— 手册放进要内嵌的位置
5. `go build -o omb.exe ./cmd/omb` —— 编译出**单二进制**：一个 exe 文件里同时装着服务器程序、前端页面和手册

> **embed 是编译期快照**：网页和手册在编译那一刻被"拍进去"了。更新单文件程序需重跑 `build.sh`；日常开发使用下文的 `pnpm dev`，前端、后端和手册均无需手动重建。

## 快速验证

三条命令确认服务器活着（`curl` 是命令行的 HTTP 请求工具，相当于用命令访问网址）：

```bash
curl http://127.0.0.1:27182/healthz      # 返回 200 = 服务器活着
curl http://127.0.0.1:27182/api/manual   # 返回手册目录树 JSON
curl http://127.0.0.1:27182/api/matches  # 返回历史对局列表；首局正式对局前目录不存在时返回 404
```

双人对局冒烟：开两个浏览器窗口（一个用普通模式、一个用隐私模式），分别用不同昵称加入同一房间 → 房主点"开始对局" → 两边都能 WASD 移动、鼠标开火即通过。

大厅通过「手册 M」进入独立阅读页；对局通过「文档 M」和「编辑器 C」展开右侧上下双窗，可独立收起，单窗占满侧栏，宽度与分栏可拖拽。`M` 开关文档、`C` 开关编辑器；手操跟随战场画布焦点，焦点入面板则释放，战场与脚本继续运行。输入文字不触发游戏快捷键。

**页面地址会记录房间与视图**（如 `?room=ABCD&view=game`；手册与回放还记 `doc` / `replay`）：同一标签页刷新会从 `sessionStorage` 恢复昵称颜色并自动回到原房间。服务器在进程内按房间码 + 精确昵称恢复机器人身份、位置和房主权；同名新连接会顶掉旧连接。注意：服务器进程重启后不保留进行中的房间；换新标签页仍需填昵称。

## 本地开发循环（热重载）

日常开发完全不需要 build.sh：前端走 vite HMR，后端用 air 自动重编译重启，手册直读磁盘。

前置：安装 air（一次性）：

```bash
go install github.com/air-verse/air@latest   # 确保 $(go env GOPATH)/bin 在 PATH
```

### 一键启动（推荐）

```bash
pnpm install
pnpm dev    # 同时起 omb(:27182, air 热重载) 与 vite(:5173)
```

浏览器打开 `http://127.0.0.1:5173`。也可分两个终端：`pnpm dev:server` / `pnpm dev:client`。

- **前端改动** → vite HMR 秒级生效，无需任何构建
- **Go 改动** → air 自动重编译并重启服务器（客户端会自动重连；服务器重启会清空进行中的对局，恢复后返回大厅）
- **手册改动**（`docs/manual/` 下的 Markdown）→ 保存后刷新页面即生效（dev:server 经 `OMB_MANUAL_DIR` 直读磁盘，不占用 embed）

代理拓扑：浏览器只连 5173；`/api` 与 `/ws` 由 vite 代理到 `127.0.0.1:27182`（环境变量 `OMB_DEV_UPSTREAM` 可覆盖，Linux/macOS 上还支持 `unix:/path/to/omb.sock` 形式指向 unix socket 的后端——Windows 的 Node 连不了 AF_UNIX；`/ws` 代理启用 `rewriteWsOrigin` 重写 Origin 以通过服务器校验，见 `client/vite.config.ts`）。

直接访问 `http://127.0.0.1:27182/` 时，若二进制内未嵌前端（仅占位文件），会显示「前端尚未构建」引导页，API/WS 不受影响；从 `server/` 启动时设置 `OMB_WEB_DIR=../client/dist`，可免重建预览已构建前端。该路径相对服务器进程的工作目录，也可以使用绝对路径。

### build.sh 还需要吗？

日常开发不需要。以下场景仍需先跑 `bash build.sh`（embed 是编译期快照）：

- 浏览器回归 e2e（round2-check 启动的是构建产物）
- 发布 / 交叉编译单二进制
- 验证嵌入产物本身

### 测试

```bash
go test ./server/... -count=1                       # 全量
# 竞态检测单独跳过墙钟性能门；性能门由普通模式验证
go test -race ./server/... -skip '^TestFrameBudget' -count=1
go test ./server/internal/glue/ -run TestFrameBudget -count=1 -v  # 64 脚本 <12ms
```

### 改协议（.proto）后

```bash
(cd protocol && npx buf generate) # 重新生成 TS + Go 双语言的协议代码
pnpm -r typecheck                 # 两侧类型立即校验
```

新增表现信息一律用**向后兼容字段**：`SelfState` 携带辅助开关与开火/冲刺的绝对冷却 tick；`shot`、`projectile_impact` 记录已发生的攻击和接触点。客户端不从弹丸离开视野推断命中。原地炮塔旋转和技能结束也参与快照差异检测。

**黄金契约测试**：TS 和 Go 两侧断言同一份十六进制字节，保证双语言编解码完全一致。改协议后必跑：

- `packages/protocol/test/golden.test.ts`（vitest）
- `server/internal/protocol/protocol_test.go`（go test）

## 浏览器回归

先跑一次 `bash build.sh`（e2e 测的是构建产物），然后：

```bash
pnpm --filter client exec playwright install chromium  # 首次使用先装浏览器
pnpm --filter client test:e2e
```

脚本自动在 `127.0.0.1:18420` 启动构建产物，用临时对局目录并在退出时清理。覆盖：热身转正式局的倒计时、刷新保留身份与位置、侧栏双窗与单窗布局、输入释放及恢复、Bot API 补全、脚本提交与失败回执、草稿和布局恢复、断线期间禁止提交、32 KiB 消息限制、窄屏、动态 resize / DPR 2、手册语言标签页、回放播放/暂停/拖动与重复进入。截图写入 `.artifacts/round2/`（不进 Git）。`OMB_BINARY` 可指定二进制路径，`OMB_SHOTS` 可指定截图目录；相对路径以 `client/` 为基准。

游戏手感专项：

```bash
pnpm --filter client test:feel
pnpm --filter client test:reconnect
```

用受控 WebSocket 协议场景检查持续交互、瞄准、权威冷却、Uplink 状态、音效控制和特效，含 2048×1152 / DPR 1.25 桌面缩放及窄屏截图。真实服务器的房间行为由 `test:e2e` 覆盖，断线停控、重连恢复、服务器重启和取消重试由 `test:reconnect` 覆盖。

地图生成与越界行为由服务端验证（在仓库根执行）：

```bash
go test ./server/internal/mapgen -count=1
go test ./server/internal/sim -run 'TestArena|TestGen1' -count=1
go test -race ./server/internal/glue ./server/internal/room ./server/internal/netws -skip '^TestFrameBudget' -count=1
```

## 调试工具箱

### 对局日志（事件溯源）

每局落盘 `server/data/matches/<房间码>-<种子>.jsonl`（热身场不落盘，正式局才有）。首行是 schema 版本，第二行是 match_start（初始状态），之后是按序追加的事件流：

```bash
head -3 server/data/matches/XXX.jsonl     # 看文件头三行
python -c "
import json,sys
for line in open(sys.argv[1],encoding='utf-8'):
    d=json.loads(line)
    if d.get('type')=='event': print(d['tick'], list((d.get('event') or {}).keys()))
" server/data/matches/XXX.jsonl | head -20
```

客户端「回放库」直接读这个目录（运行时读盘，不走内嵌）。

### WebSocket 帧级调试

游戏的所有实时通信走一条 WebSocket 连接（`/ws`）。每个二进制帧第一个字节是类型：`0x00` ping / `0x01` pong / `0x02` 上行 ClientMsg / `0x03` 下行 ServerMsg（protobuf 编码）。现成探针脚本模式（在 `client/` 下 `npx tsx` 运行，`@omb/protocol` 直接编码解码）：

```ts
import { toBinary, fromBinary, create } from '@bufbuild/protobuf'
import { ClientMsgSchema, JoinRoomSchema, ServerMsgSchema } from '@omb/protocol'
import WebSocket from 'ws'
const ws = new WebSocket('ws://127.0.0.1:27182/ws')
const send = (m: any) => ws.send(Buffer.concat([Buffer.from([0x02]), Buffer.from(toBinary(ClientMsgSchema, m))]))
ws.onopen = () => send(create(ClientMsgSchema, { payload: { case: 'join', value: create(JoinRoomSchema, { roomCode: 'DBG1', nick: 'x', color: '#22d3ee' }) } }))
ws.onmessage = (ev) => {
  const b = new Uint8Array(ev.data)
  if (b[0] === 0x03) console.log(fromBinary(ServerMsgSchema, b.subarray(1)).payload.case)
}
```

### 性能剖析

```bash
# 帧预算（目标：模拟+脚本+感知 < 12ms，见 ADR-0007）
go test ./server/internal/glue/ -run TestFrameBudget -v

# 感知裁剪基准（多观察者 AOI）
go test ./server/internal/snapshot/ -bench . -benchtime 100x

# 64 脚本满载并行（重载脚本；看 ns/op、deferred_pct、allocs/op）
go test ./server/internal/script/ -bench BenchmarkRunPool64Heavy -benchtime 30x -run XXX

# 单 tick 分量拆解（空底座 / scan / navigateTo / 重载脚本）
go test ./server/internal/script/ -bench 'BenchmarkTick(EmptyJS|ScanOnly|NavWalls|HeavyReal)' -benchtime 3s -run XXX
```

已知热点：64 观察者可见性约 260μs/人（T3 优化项，见 `docs/plans/round-2.md` §5）。

**脚本/GC 调优（ADR-0015）**：64 脚本满载时每帧产生 ~9MB 短命 goja 对象，
默认 GOGC=100 会让 GC assist 耗掉 ~40% 帧预算。生产环境设置
`OMB_GC_PERCENT=400`（或 config.yaml `gc: percent: 400`）；验收方法：

```bash
GOGC=400 go test ./server/internal/script/ -bench BenchmarkRunPool64Heavy -benchtime 30x -run XXX
# 对比无 GOGC 的同基准：帧时应降 ~30-45%，deferred_pct 应为 0
```

注意：`-test.memprofilerate=1` 只用于分配归因（会把帧预算拖爆，
deferred 会到 99%），不能当计时基线。perf 归因时先看 GC 系符号
（scanobject/mallocgc）占比，再看 goja 符号；`perf_event_paranoid`
受限时用 Go pprof 代替（符号更准）。

## 常见问题

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| 直接访问 27182 显示「前端尚未构建」 | 开发二进制未嵌前端（仅占位文件） | 访问 5173；从 `server/` 启动时可设 `OMB_WEB_DIR=../client/dist`，或跑 `bash build.sh` |
| 进房后"等待房主"且无按钮 | 你不是房主（正常视角） | 首位进房者即房主 |
| 对局中对方消失 | AOI 裁剪（20m 出视野） | 设计行为；搭档除外 |
| WS 连不上（dev 模式） | upstream 不符或后端未启动 | 核对 `OMB_DEV_UPSTREAM`（默认 `127.0.0.1:27182`）与后端进程 |
| 手册 tab 不显示 | md 围栏语法错 | 首块语言标注须为 `ts\|py\|java` 形式 |
| AI 提示“未启用” | `ai.enabled` 未开启或服务器未读取到 `DEEPSEEK_API_KEY` | 检查可执行文件同目录 / 当前工作目录的 `config.yaml` 与 `.env`，确认服务日志只显示启用状态不显示密钥；配置见 [部署指南](deploy.md#ai-agent-配置) |
| 日志目录无新对局 | 热身场不落盘 | 设计行为；正式局才有 |
