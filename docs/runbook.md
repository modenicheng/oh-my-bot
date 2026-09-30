# 运行与本地调试指南

> 适用 v0.1.0+。三分钟跑起完整可玩环境（双浏览器对局）。

## 前置依赖

| 工具 | 最低版本 | 用途 |
| --- | --- | --- |
| Go | 1.24 | 服务器编译 |
| Node | 22 | 前端工具链 |
| pnpm | 10 | workspace 管理 |

可选：Python 3（分析对局日志）、Playwright（自动化冒烟）。

## 一键构建与运行

```bash
bash build.sh          # typecheck → client build → embed → server/omb.exe
cd server
./omb.exe -addr :8080  # 默认端口 8080；浏览器打开 http://localhost:8080/
```

`build.sh` 做了什么（顺序即依赖序）：

1. `pnpm -r typecheck` —— 全 workspace 类型检查
2. `pnpm --filter client build` —— vite 产出 `client/dist/`
3. 拷贝 `client/dist/*` → `server/cmd/omb/web/`（前端 embed）
4. 拷贝 `docs/manual/*` → `server/cmd/omb/manual/`（手册 embed）
5. `go build -o omb.exe ./cmd/omb` —— 单二进制（web/manual 均内嵌）

> 改了前端或手册后，重新嵌入二进制需要重跑 build.sh（embed 是编译期快照）。
> 日常开发不需要——见下文「本地开发循环」，前端/后端/手册均有热重载路径。

## 快速验证

```bash
curl http://localhost:8080/healthz      # 200 = 活着
curl http://localhost:8080/api/manual   # 手册树 JSON
curl http://localhost:8080/api/matches  # 历史对局列表
```

开两个浏览器窗口（或普通+隐私）：使用不同昵称加入同一房间 → 房主「开始对局」→ WASD 移动、鼠标开火。大厅和游戏右上角均有「手册 M」按钮，也可按 `M` 打开手册、再次按 `M` 返回；输入框内不触发游戏快捷键。

页面地址记录房间与当前视图，例如 `?room=ABCD&view=game`；手册与回放还记录 `doc` / `replay`。同一标签页刷新会从 `sessionStorage` 恢复昵称和颜色，自动加入原房间。服务器在进程内按房间码与精确昵称恢复机器人身份、位置和房主权；同名新连接会替换旧连接。服务器重启后不保留进行中的房间，新标签页仍需要填写昵称。

## 本地开发循环（热重载）

日常开发完全不需要 build.sh：前端走 vite HMR，后端用 air 自动重编译重启，手册直读磁盘。

前置：安装 air（一次性）：

```bash
go install github.com/air-verse/air@latest   # 确保 $(go env GOPATH)/bin 在 PATH
```

### 一键启动（推荐）

```bash
pnpm install
pnpm dev    # 同时起 omb(:8080, air 热重载) 与 vite(:5173)
```

浏览器打开 `http://127.0.0.1:5173`。也可分两个终端：`pnpm dev:server` / `pnpm dev:client`。

- **前端改动** → vite HMR 秒级生效，无需任何构建
- **Go 改动** → air 自动重编译并重启服务器（进行中的 WS 会断开，刷新页面重进即可）
- **手册改动**（`docs/manual/*.md`）→ 保存后刷新页面即生效（dev:server 经 `OMB_MANUAL_DIR` 直读磁盘，不占用 embed）

代理拓扑：浏览器只连 5173；`/api` 与 `/ws` 由 vite 代理到 `127.0.0.1:8080`（环境变量 `OMB_DEV_UPSTREAM` 可覆盖；`/ws` 代理启用 `rewriteWsOrigin` 重写 Origin 以通过服务器校验，见 `client/vite.config.ts`）。

直接访问 `http://127.0.0.1:8080/` 时，若二进制内未嵌前端（仅占位文件），会显示「前端尚未构建」引导页，API/WS 不受影响；设置 `OMB_WEB_DIR` 指向 `client/dist` 可免重建预览已构建前端。

### build.sh 还需要吗？

日常开发不需要。以下场景仍需先跑 `bash build.sh`（embed 是编译期快照）：

- 浏览器回归 e2e（round2-check 启动的是构建产物）
- 发布 / 交叉编译单二进制
- 验证嵌入产物本身

### 测试

```bash
go test ./internal/... -count=1          # 全量（sim 较慢 ~95s）
go test ./internal/... -race -count=1    # 竞态检测（提交前必跑）
go test ./internal/glue/ -run TestFrameBudget -v   # 性能门（64 脚本 <12ms）
```

### 协议变更（改 .proto 后）

```bash
cd protocol && npx buf generate   # 重新生成 TS + Go 双语言绑定
pnpm -r typecheck                 # 两侧类型即时校验
```

黄金契约测试（TS/Go 同 hex 断言）在：

- `packages/protocol/test/golden.test.ts`（vitest）
- `server/internal/protocol/protocol_test.go`（go test）

## 浏览器回归

先运行 `bash build.sh`，再执行：

```bash
pnpm --filter client exec playwright install chromium  # 首次使用时安装浏览器
pnpm --filter client test:e2e
```

脚本自动在 `127.0.0.1:18420` 启动构建产物，使用临时对局目录并在退出时关闭服务。覆盖热身转正式局的倒计时、刷新保留身份与位置、M 手册及按钮入口、输入释放、动态 resize / DPR 2、手册语言标签页、回放播放/暂停/拖动与重复进入。截图写入 `.artifacts/round2/`（不纳入 Git）。`OMB_BINARY` 可指定二进制路径，`OMB_SHOTS` 可指定截图目录；相对路径以 `client/` 为基准。

地图生成与越界行为另由服务端验证：

```bash
# 在仓库根执行
go test ./server/internal/mapgen -count=1
go test ./server/internal/sim -run 'TestArena|TestGen1' -count=1
go test -race ./server/internal/glue ./server/internal/room ./server/internal/netws -count=1
```

## 调试工具箱

### 对局日志（事件溯源）

每局落盘 `server/data/matches/<房间码>-<种子>.jsonl`：

```bash
head -3 server/data/matches/XXX.jsonl     # schema_version → match_start(初始态) → 事件流
python -c "
import json,sys
for line in open(sys.argv[1],encoding='utf-8'):
    d=json.loads(line)
    if d.get('type')=='event': print(d['tick'], list((d.get('event') or {}).keys()))
" server/data/matches/XXX.jsonl | head -20
```

客户端「回放库」直接加载同目录（embed 之外的运行时目录，服务器直接读盘）。

### WS 帧级调试

帧协议：`0x00 ping / 0x01 pong / 0x02 上行 ClientMsg / 0x03 下行 ServerMsg`（protobuf）。
现成探针脚本模式（client/ 目录下 `npx tsx` 跑，`@omb/protocol` 直接编码）：

```ts
import { toBinary, fromBinary, create } from '@bufbuild/protobuf'
import { ClientMsgSchema, JoinRoomSchema, ServerMsgSchema } from '@omb/protocol'
import WebSocket from 'ws'
const ws = new WebSocket('ws://127.0.0.1:8080/ws')
const send = (m: any) => ws.send(Buffer.concat([Buffer.from([0x02]), Buffer.from(toBinary(ClientMsgSchema, m))]))
ws.onopen = () => send(create(ClientMsgSchema, { payload: { case: 'join', value: create(JoinRoomSchema, { roomCode: 'DBG', nick: 'x', color: '#22d3ee' }) } }))
ws.onmessage = (ev) => {
  const b = new Uint8Array(ev.data)
  if (b[0] === 0x03) console.log(fromBinary(ServerMsgSchema, b.subarray(1)).payload.case)
}
```

### 性能剖析

```bash
# 帧预算（ADR-0007：模拟+脚本+感知 <12ms）
cd server && go test ./internal/glue/ -run TestFrameBudget -v

# 感知裁剪基准（多观察者 AOI）
go test ./internal/snapshot/ -bench . -benchtime 100x
```

已知热点：64 观察者可见性 ~260μs/人（T3 优化项，见 round-2.md §5）。

## 常见问题

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| 直接访问 8080 显示「前端尚未构建」 | 开发二进制未嵌前端（仅占位文件） | 预期行为：走 5173，或设 `OMB_WEB_DIR`，或跑 `bash build.sh` |
| 进房后"等待房主"且无按钮 | 非房主视角 | 首位进房者即房主 |
| 对局中对方消失 | AOI 裁剪（>20m 出视野） | 设计行为；搭档除外 |
| WS 连不上（dev 模式） | upstream 端口不符或后端未启动 | 核对 `OMB_DEV_UPSTREAM`（默认 `127.0.0.1:8080`）与后端进程 |
| 手册 tab 不显示 | md 围栏语法错 | 首块语言标注须为 `ts\|py\|java` 形式 |
| AI 提示 "not configured" | 未配 key | `export DEEPSEEK_API_KEY=...` 后重启 |
| 日志目录无新对局 | 热身场不落盘 | 设计行为；正式局才有 |
