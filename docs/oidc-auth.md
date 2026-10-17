# OIDC 登录认证

oh-my-bot 的 OIDC 接入移植自 [BITNP/wordle-competition](https://github.com/BITNP/wordle-competition)
的 `internal/auth` 设计：**无状态 HMAC token**——没有服务端会话、没有会话表、
不存 refresh token。登录换来一张自签 token（`b64(payload).b64(HMAC)`，载荷
`sub/name/exp`），过期后重走一次登录即可。

## 总览

```
浏览器                     omb 服务器                      IdP（Keycloak 等）
  │  GET /auth/login          │                              │
  │ ─────────────────────────>│  302 → IdP 授权页             │
  │  <────────────────────────│  （state=签名(nonce+room)）   │
  │  GET <授权页> ────────────────────────────────────────── >│ 用户登录
  │  302 /auth/callback?code&state <────────────────────────│
  │ ─────────────────────────>│  验 state → code 换 id_token  │
  │                           │  校验签名/nonce → sub/name    │
  │  302 /?token=<HMAC>&room= <│  签发自签 token               │
  │                           │                              │
  │  GET /ws?token=<HMAC>     │  升级后验 token，无效即终态    │
  │ ─────────────────────────>│  join-failed 通知并优雅关闭    │
  │                           │  join 昵称强制取认证名         │
```

- token 只在重定向 query 出现一次：前端落入 `localStorage` 后立即清洗地址栏，
  服务端在回调响应设 `Referrer-Policy: no-referrer`，且不留访问日志。
- CSRF 防护的 state 同样无状态：`nonce.room` 拼接后带 HMAC 签名，重启不失效。
- HTTP 只读 API（`/api/replay`、`/api/matches`、`/api/manual`）保持公开，
  认证只管进房（join/spectate）这一条 WebSocket 通道。

## 服务端配置

config.yaml：

```yaml
auth:
  # enabled 默认 true：下面三项配齐即启用；显式 false 可整体关闭
  issuer: https://sso.example/realms/omb   # discovery 基地址
  client_id: omb                           # confidential client
  redirect_url: https://omb.example/auth/callback  # 可省略，见下
  display_name_claim: preferred_username   # 可省略
  token_ttl: 168h                          # 可省略，默认 7 天
```

.env（或进程环境变量）：

```
OIDC_CLIENT_SECRET=…
OMB_AUTH_SECRET=<32 字节以上随机串>   # openssl rand -hex 32
```

要点：

- **默认开启**：`auth.enabled` 缺省为 true——issuer/client_id/client_secret
  三项配齐即生效；配置残缺时自动降级不装配（日志 `auth disabled: …`，行为
  与未接入认证一致）；要整体关闭设 `auth.enabled: false`（或 `.env` 的
  `AUTH_ENABLED=false`，与 AI 段同款优先级：进程环境 > .env > config.yaml）。
- **redirect_url** 缺省时按请求推导（`scheme://Host/auth/callback`，反代场景
  取 `X-Forwarded-Proto`）。unix socket + nginx 部署时 nginx 必须透传该头；
  多入口/内网外网同服时建议显式配置。
- **代理环境**：Go 默认走 `HTTP(S)_PROXY` 环境变量。若部署机的代理到 IdP
  不可达（登录报 EOF/超时而浏览器正常——浏览器通常走规则分流），设
  `auth.bypass_proxy: true`（或环境变量 `AUTH_BYPASS_PROXY=true`）让 OIDC
  出站请求（discovery/token/JWKS）强制直连；只影响认证出站，其余不动。
- **OMB_AUTH_SECRET** 未设置时进程内随机生成：功能可用，但每次重启全员掉
  登录（启动日志会提醒）。生产显式设置。
- IdP 侧注册 **confidential client**（需要 client secret），回调地址填
  `<对外地址>/auth/callback`，scope 需要 `openid profile email`。
- 所有键都有对应环境变量（`AUTH_ENABLED`/`AUTH_ISSUER`/…），优先级与 AI 段
  一致：进程环境 > .env > config.yaml。

## 进房语义变化

认证开启后：

1. `/ws` 连接必须带合法 `?token=`（浏览器 WebSocket 无法自定义请求头）。token
   无效时不回 401——浏览器 WS API 读不到 HTTP 状态码，升级前拒绝只会让客户端
   无限退避重连（表象即"认证后无法进房"）；改为完成升级后立即下发终态
   join-failed 双形态通知并优雅关闭，客户端停止重试、清除失效登录态并提示
   重新登录（文案前缀两侧互钉，见 `authRejectedReason` / `isAuthRejection`）。
2. join 的昵称**强制取认证名**（`display_name_claim` → `preferred_username`
   → `name` → `email` → `sub` 回退链），客户端自报昵称被忽略——杜绝冒名，
   且与"同身份接管"（同一昵称重进踢掉旧连接）自然衔接。
3. 客户端表单自动预填并锁定昵称；未登录时进房按钮给出登录提示。

## 客户端

`client/src/auth.ts` 管理 token 存取/解码与 `/auth/status` 探测；`net.ts` 拨号
自动附 `?token=`；大厅表单渲染登录徽章。

开发模式（vite）要点：

- `/auth` 代理**不改写 Host**（无 changeOrigin）：服务端从请求 Host 推导
  回调地址，改写会让登录回跳落到 omb 源而非 5173——token 进错 localStorage
  （按源隔离），应用侧永远读不到登录态（昵称框绑不上认证名就是这个）。
- `pnpm dev:server` 以 `OMB_WEB_DIR=../client/dist` 启动：即使直接访问 omb
  端口也是当前前端，避免 embed 快照过期造成"两个源行为不一致"。
- Keycloak 的 Valid redirect URIs 记得同时登记开发源
  （`http://127.0.0.1:5173/auth/callback`）。

## 与 Keycloak 的对接示例

1. 建realm（或复用现有），建 client：
   - Client ID：`omb`；Client authentication：**On**（confidential）；
   - Valid redirect URIs：`https://你的域名/auth/callback`；
   - Web origins 留空（同源跳转，不涉及 CORS）。
2. `config.yaml` 的 `issuer` 填 `https://<keycloak>/realms/<realm>`。
3. 从 Credentials 页取 secret 放 `.env` 的 `OIDC_CLIENT_SECRET`。
4. `systemd` 重启后用浏览器访问站点，点"OIDC 登录"验证往返。

## 测试

- `server/internal/auth`：token 签发/验签/过期/防篡改、state 签名、以及
  httptest 假 IdP（手签 RS256 id_token + JWKS）覆盖 discovery → 授权 URL →
  code 交换 → nonce 校验 → 昵称回退链全流程。
- `server/cmd/omb`：/auth/* 路由行为（502/400/401）、/ws 门禁（无 token/过期
  token 401）、合法 token 放行且昵称接管、认证关闭时行为与历史版本一致。
- `client/src/auth.test.ts`：token 解码与 URL 提取纯函数。
- `client/scripts/oidc-check.mjs`：真实 Keycloak 授权码登录 → 房间身份 →
  开局失败后重试 → 200 席位对局地图与玩家快照 → 刷新和 WS 重连后恢复同一
  Robot。脚本使用临时配置与数据目录，监听 `127.0.0.1:18430`，不读取本地
  生产配置，也不修改现有开发服务。

在仓库根目录先启动测试 Keycloak（Windows 可在 Debian WSL 中执行）：

```bash
podman run --rm -d --name omb-oidc-test \
  -p 127.0.0.1:18080:8080 \
  -v "$(pwd)/client/scripts/fixtures/oidc:/opt/keycloak/data/import:ro" \
  quay.io/keycloak/keycloak:26.5.2 start-dev --import-realm
```

构建后执行测试，完成后停止测试容器：

```bash
bash build.sh
pnpm --filter client test:oidc
podman stop omb-oidc-test
```

`OMB_BINARY` 可指定已有服务端二进制（绝对路径）；Linux 下设置为
`<仓库绝对路径>/server/omb`。测试也可通过 `OMB_TEST_OIDC_ISSUER`、
`OMB_TEST_OIDC_USERNAME`、`OMB_TEST_OIDC_PASSWORD` 与
`OMB_TEST_OIDC_CLIENT_SECRET` 接入另一个测试 realm，其 confidential client
ID 仍为 `omb`，回调需登记 `http://127.0.0.1:18430/auth/callback`。
`OMB_TEST_AUTH_ENABLED=false` 可运行关闭认证的对照组。

### 已定位：登录后房间在线，但游戏不出现

若房间显示“对局中”、WS 心跳正常，却没有地图与快照，先检查开局组装是否失败。
200 席位房间自动补充 199 个 Bot 时，每个 Bot 的 tick 配额为 4ms；此前脚本
初始化也复用了这个配额，机器繁忙时可能出现
`match launch failed: test bot …: evaluate: script: tick quota exceeded`。
这发生在认证成功之后，不是 token 交换或 WS 门禁拒绝。

内置 Bot 现在在异步开局期间使用独立的 1s 初始化预算，运行中的 tick
配额不变。任何开局组装失败都会让当前房间回到可重试的结束状态、保留成员与
房主，并在房间页显示原因。服务端日志同时记录房码、seed、人数与错误；
修复原因后可直接重试开始对局或热身场。

## 已知边界

- token 过期（或服务端密钥轮换后失效）发生在对局中时：重连会被门禁以终态
  join-failed 通知拒绝——客户端停止退避重连、清除登录态并回大厅提示重新
  登录（重新登录即恢复，默认 TTL 7 天，属低频事件）。
- 公共 client（PKCE、无 client secret）暂不支持，需要时再扩展。
- `/auth/login` 走的 IdP 不可用时返回 502，重试即可；不影响已登录用户。
