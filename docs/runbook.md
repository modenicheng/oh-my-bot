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

> 改了前端或手册必须重跑 build.sh（embed 是编译期快照）。

## 快速验证

```bash
curl http://localhost:8080/healthz      # 200 = 活着
curl http://localhost:8080/api/manual   # 手册树 JSON
curl http://localhost:8080/api/matches  # 历史对局列表
```

开两个浏览器窗口（或普通+隐私）：使用不同昵称加入同一房间 → 房主「开始对局」→ WASD 移动、鼠标开火。大厅和游戏右上角均有「手册 M」按钮，也可按 `M` 打开手册、再次按 `M` 返回；输入框内不触发游戏快捷键。

页面地址记录房间与当前视图，例如 `?room=ABCD&view=game`；手册与回放还记录 `doc` / `replay`。同一标签页刷新会从 `sessionStorage` 恢复昵称和颜色，自动加入原房间。服务器在进程内按房间码与精确昵称恢复机器人身份、位置和房主权；同名新连接会替换旧连接。服务器重启后不保留进行中的房间，新标签页仍需要填写昵称。

## 本地开发循环

### 前端热重载（改客户端代码）

```bash
# 终端 1：起服务器（任何端口）
cd server && go build -o omb.exe ./cmd/omb && ./omb.exe -addr :8081

# 终端 2：vite dev server（配置了 /ws 与 /api 代理到 8081，见 client/vite.config.ts）
cd client && pnpm dev   # 打开 http://localhost:5173
```

vite HMR 生效；WebSocket/手册/回放 API 经代理转发，无需改代码。

### 服务器热重载（改 Go 代码）

```bash
cd server && go run ./cmd/omb -addr :8080
```

无热重载工具链（重启即生效，秒级编译）。测试：

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
| 页面 200 但白屏 | embed 前端过期 | 重跑 `bash build.sh` |
| 进房后"等待房主"且无按钮 | 非房主视角 | 首位进房者即房主 |
| 对局中对方消失 | AOI 裁剪（>20m 出视野） | 设计行为；搭档除外 |
| WS 连不上（dev 模式） | vite proxy 目标端口不符 | 核对 `client/vite.config.ts` 的 target |
| 手册 tab 不显示 | md 围栏语法错 | 首块语言标注须为 `ts\|py\|java` 形式 |
| AI 提示 "not configured" | 未配 key | `export DEEPSEEK_API_KEY=...` 后重启 |
| 日志目录无新对局 | 热身场不落盘 | 设计行为；正式局才有 |
