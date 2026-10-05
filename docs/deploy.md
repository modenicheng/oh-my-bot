# 部署指南

> v0.1.0+。本项目定位是内部破冰活动：**私有部署**——内网或单机局域网，不暴露公网（这是刻意决定，见 ADR-0008）。这一页面向"负责把游戏跑起来的人"，不假设运维经验。

## 部署形态：单二进制

最终产物是**一个可执行文件**（`omb` 或 `omb.exe`）：网页前端、玩家手册、服务器程序全部内嵌在里头（编译期打包，技术上是 Go 的 `go:embed`）。运行它只需要：

- 这个文件本身
- 一个可写工作目录（首局正式对局时自动创建 `data/matches/` 保存日志）

没有数据库、没有账号系统、没有外部依赖。任意一台内网机器（包括活动室的笔记本）拷过去就能跑。

## 构建

在开发机（需要 Go ≥ 1.25、Node ≥ 22、pnpm ≥ 10 和 Bash）上构建：

```bash
git clone https://github.com/modenicheng/oh-my-bot && cd oh-my-bot
pnpm install
bash build.sh                      # 产出 server/omb.exe（运行平台由当前 Go 环境决定）
```

目标机器是 Linux（活动室常见）时，做**交叉编译**——在一台机器上编出另一系统用的可执行文件：

```bash
cd server && GOOS=linux GOARCH=amd64 go build -o omb ./cmd/omb
```

> **先跑完整 `build.sh` 再交叉编译**：内嵌内容（网页、手册）是编译期快照，`build.sh` 负责把前端产物和手册放到内嵌位置。直接交叉编译会打进一个空壳。

## 运行

```bash
./omb                 # 默认监听 127.0.0.1:27182，仅本机可访问
```

未设置 `-addr` 或 `OMB_ADDR` 时只绑定本机回环地址（原因见 ADR-0014）：本机浏览器打开 `http://127.0.0.1:27182/` 即玩，同一局域网的其它机器**访问不到**。这可减少本地调试时不必要的对外监听；防火墙提示仍取决于系统和安全软件策略。要让别的机器进来，需显式改监听地址（`-addr` 优先于环境变量 `OMB_ADDR`）：

| 写法 | 含义 |
|---|---|
| （默认）`127.0.0.1:27182` | 仅本机 |
| `:27182` | 所有网卡——同一局域网可访问 `http://<这台机器IP>:27182/` |
| `unix:/run/omb/omb.sock` | unix socket，给反向代理连（见下文「反向代理」） |
| `unix:@omb` | Linux 抽象套接字（不落盘，重启无残留） |

### 防火墙（仅对外监听时需要）

防火墙可能拦截外部连接。使用 `-addr :27182`、`OMB_ADDR=:27182` 或具体局域网地址对外监听时，按系统策略放行对应端口：

- Windows：`netsh advfirewall firewall add rule name="omb" dir=in action=allow protocol=tcp localport=27182`
- Linux：视发行版（`ufw allow 27182` 或 `firewall-cmd --add-port=27182/tcp`）

验证：

```bash
curl http://127.0.0.1:27182/healthz     # 返回 200 = 活着（远程机器换 http://<host>:27182/healthz）
# 浏览器打开 http://<host>:27182/ → 进房即玩
```

## systemd 常驻（Linux）

活动室机器一般希望"开机自动跑、崩了自动拉起"——Linux 上标准做法是 systemd 服务（系统自带的进程管家）。局域网直连版：

```ini
# 文件放在 /etc/systemd/system/omb.service
[Unit]
Description=oh-my-bot server
After=network.target

[Service]
# 日志写到 /opt/omb/data/matches
WorkingDirectory=/opt/omb
# 对外服务必须显式 -addr（默认 127.0.0.1 只有本机可达）
ExecStart=/opt/omb/omb -addr :27182
Restart=on-failure
# GC 调优（ADR-0015：64 脚本满载时默认 GOGC=100 会耗掉 ~40% 帧预算）
# 也可写进 /opt/omb/config.yaml 的 gc: 段，二选一
Environment=OMB_GC_PERCENT=400
# Environment=OMB_GC_MEMORY_LIMIT=1GiB   # 软上限兑底，内存紧张时再加

[Install]
WantedBy=multi-user.target
```

走反向代理时改绑 unix socket（先创建专用系统用户和同名组 `omb`，确保它可写 `/opt/omb/data`；`RuntimeDirectory` 让 systemd 自动创建并清理 `/run/omb`）：

```ini
[Service]
User=omb
Group=omb
WorkingDirectory=/opt/omb
RuntimeDirectory=omb
RuntimeDirectoryMode=0755
ExecStart=/opt/omb/omb -addr unix:/run/omb/omb.sock
Restart=on-failure
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now omb
journalctl -u omb -f                # 跟踪日志
```

## 反向代理（推荐的生产接入方式）

监听 `127.0.0.1` 或 unix socket 后，通过反向代理统一处理跨网段入口、TLS 终结和访问控制。socket 文件权限默认 `0666`（反代进程通常以别的用户运行）；要收紧就按上例设置服务的 `User=omb` / `Group=omb`，把反代用户加入 `omb` 组，再设 `RuntimeDirectoryMode=0750`，重启两个服务使组权限生效。目录进不去则 socket 不可达。

nginx（`/etc/nginx/sites-available/omb`）：

```nginx
server {
    listen 80;
    server_name omb.example.internal;

    location / {
        proxy_pass http://unix:/run/omb/omb.sock:/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;            # WS Origin 校验要求 Host 与浏览器 Origin 一致
        proxy_set_header Upgrade $http_upgrade; # WebSocket 升级
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;                  # 对局 WS 长连接
    }
}
```

Caddy（自动 HTTPS，内网可用内部证书或改 `http://` 站点块）：

```caddy
omb.example.internal {
    reverse_proxy unix//run/omb/omb.sock
}
```

验证：`curl --unix-socket /run/omb/omb.sock http://localhost/healthz` → 200，再经代理域名进房。

## Docker（备选）

项目暂无官方镜像；需要时可将以下 Dockerfile 保存到仓库根目录。先运行 `pnpm install` 和 `bash build.sh`，准备好 `server/cmd/omb/web/`、`server/cmd/omb/manual/` 内嵌目录，再以仓库根目录作为构建上下文：

```dockerfile
FROM golang:1.25 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY server/ ./server/
RUN CGO_ENABLED=0 go build -o /omb ./server/cmd/omb
FROM gcr.io/distroless/static
COPY --from=build /omb /omb
# 日志落 /app/data/matches（挂卷持久化）
WORKDIR /app
# 容器内必须显式绑定所有网卡：默认 127.0.0.1 是容器自己的回环，-p 发布不进去
ENTRYPOINT ["/omb", "-addr", ":27182"]
```

```bash
docker build -t omb:latest .
docker run -d -p 127.0.0.1:27182:27182 -v omb-data:/app/data omb:latest   # 仅宿主机本机可访问
docker run -d -p 27182:27182 -v omb-data:/app/data omb:latest             # 发布到所有网卡，局域网可访问
```

容器里的 unix socket 也能用：`-addr unix:/run/omb/omb.sock` 并把 `/run/omb` 挂成共享卷，宿主机 nginx 或 sidecar 反代容器直接连卷里的 socket。

## CI/CD 与版本发布

工作流位于 `.github/workflows/`；运行状态与历史记录以仓库 Actions 页面为准。

### 工作流一览

| 工作流 | 触发 | 作用 |
|---|---|---|
| CI (`.github/workflows/ci.yml`) | push main、所有 PR、手动 | `go` job：golangci-lint（v2 配置 `.golangci.yml`）+ 包级串行的完整 `go test -p 1`（避免严格墙钟门受跨包 CPU 争用干扰）+ `go test -race -short`（排除 race 下无意义的严格墙钟性能门）；`web` job：`pnpm install --frozen-lockfile` + `pnpm typecheck` + `pnpm test`（vitest 单测，不含 e2e） |
| Release Please (`.github/workflows/release-please.yml`) | push main、手动 | 自动维护 `chore: release` PR（由 conventional commits 汇总）；手动可填高于最新 tag 的 `release_as`（如 `v1.0.0-beta.1`）产指定 release PR；merge 后打 tag + 建 GitHub release |
| Release (`.github/workflows/release.yml`) | push `v*` tag、手动（tag 必填，须为已存在的 `vX.Y.Z[-pre]` tag） | resolve 校验 tag 并输出 tag+commit，五平台构建（linux/amd64、linux/arm64、windows/amd64、darwin/amd64、darwin/arm64）精确 checkout 该 commit + linux/amd64 smoke（`-version` 严格等于 tag、`/healthz` 200）+ SHA256SUMS + 幂等上传到 GitHub release；五平台产物缺一不发 |
| Dependabot (`.github/dependabot.yml`) | 每周 | github-actions / gomod（根 go.mod）/ npm（根 pnpm workspace）更新 PR |

### 正式发版

1. push 到 main 后 Release Please 自动开/更新 `chore: release` PR（版本号由 conventional commits 推导：`feat:` 进 minor、`fix:`/`perf:` 进 patch、`feat!:`/`BREAKING CHANGE:` 进 major）。
2. 人工核对 CHANGELOG 后 merge 该 PR → 自动打 `vX.Y.Z` tag 并创建 GitHub release，触发 Release 工作流出五平台产物。

### beta（预发布）发版

Release Please action 本身无 prerelease 输入；beta 走手动 `release_as`：

1. 在 Actions 页从 `main` 运行 Release Please，`release_as` 显式填一个**高于最新 tag** 的版本，例如从 `v1.0.0-alpha.3` 晋级时使用 `v1.0.0-beta.1`；后续可填 `v1.0.0-beta.2`。工作流用严格 SemVer 校验并拒绝不递增版本。
2. merge 产出的 release PR → 对应 tag + 预发布 GitHub release（config `prerelease: true`：0.x 或带预发布后缀的 release 标为 prerelease，1.x 及之后无后缀的版本转正）。自动构建产物需要下文的 PAT 配置；否则手动运行 Release。
3. 从 beta 发布无后缀版本时，用 `release_as` 显式指定目标版本，例如 `v1.0.0`。当前 beta 通道使用 `prerelease-type: beta`；手动 `release_as` 仍是指定目标版本的唯一权威。

### 下载与校验

Releases 页下载对应平台 `omb-<版本>-<os>-<arch>.tar.gz`（Windows 为 `.zip`，内含 `omb.exe`）与 `SHA256SUMS`：

```bash
sha256sum -c SHA256SUMS          # 在产物所在目录
tar xzf omb-0.2.0-linux-amd64.tar.gz && ./omb -version   # 应输出 v0.2.0
```

### 版本查询

二进制是唯一版本源（release 构建经 `-ldflags '-X main.version=<tag>'` 注入）：

- `./omb -version` — 打印版本立即退出，不监听端口
- `curl http://127.0.0.1:27182/api/version` — 例如 `{"version":"v0.2.0"}`（只读 GET，非 GET 405）
- 首页加入页底部页脚 — 启动时异步读取 `/api/version`，读取失败静默显示 `dev`

### 已知限制

- **GITHUB_TOKEN 限制（GitHub 官方）**：Release Please 用默认 `github.token` merge 出的 tag **不会**再触发 Release 工作流。两条路径：① 配 fine-grained PAT 为 secret `RELEASE_PLEASE_TOKEN`，需同时勾选 **Contents: Read and write**、**Pull requests: Read and write** 与 **Issues: Read and write**，实现全自动；② 不配 PAT 时 merge 后在 Actions 手动 Run Release 工作流（tag 输入必填，须为已存在的 `vX.Y.Z[-pre]` tag）补产物——release 本体与 tag 已由 Release Please 创建，产物上传幂等（`--clobber`）。
- 仓库已有历史 `v0.1.0` tag，但它早于版本注入与 Release workflow，仅作为源码基线，不支持用新流水线回填二进制；首个自动 release 从其后的提交生成。
- 本地已验证五平台交叉编译、归档、SHA256SUMS 和版本/healthz smoke；Actions 真实运行、release PR 自动晋级与 GitHub Release 上传由推送后的远端演练确认。

## AI Agent 配置

AI 默认关闭。服务器启动时依次查找**可执行文件同目录**和**当前工作目录**中的 `config.yaml` / `.env`；先找到包含配置文件的目录即使用。取值优先级是：进程环境变量 > `.env` > `config.yaml` > 默认值。

从仓库样例复制：

```bash
cp config.example.yaml config.yaml
cp .env.example .env
```

`config.yaml` 只放非秘密配置：

```yaml
ai:
  enabled: true
  model: deepseek-chat
  endpoint: https://api.deepseek.com/chat/completions
  timeout_seconds: 30
quota:
  rounds: 20
  player_tokens: 300000
  global_tokens: 2000000
  max_concurrency: 20
```

`.env` 只在服务器本机保存密钥：

```dotenv
DEEPSEEK_API_KEY=你的密钥
```

请将 `.env` 权限限制为服务用户可读（Linux 可用 `chmod 600 .env`），不要写进 `config.yaml`、systemd unit、镜像层、日志或版本库。仓库已忽略根目录和 `server/` 下的实际配置文件；样例文件可提交。

启用条件是 `ai.enabled: true` 且存在 `DEEPSEEK_API_KEY`。缺任一项时服务器安全禁用 AI，Snippet、手操和玩家脚本不受影响。AI 默认配额为每人 20 轮 / 300k token、单局全场 2M token、全局并发 20；热身与紧接其后的正式局共享额度。可用环境变量 `AI_ENABLED`、`AI_MODEL`、`AI_ENDPOINT`、`AI_TIMEOUT_SECONDS`、`QUOTA_ROUNDS`、`QUOTA_PLAYER_TOKENS`、`QUOTA_GLOBAL_TOKENS`、`QUOTA_MAX_CONCURRENCY` 覆盖文件值。玩家操作见 [AI Agent](manual/start/ai-agent.md)。

## 数据与备份

| 路径 | 内容 | 策略 |
|---|---|---|
| `data/matches/*.jsonl` | 对局事件日志（回放与统计的唯一事实源） | tar 归档即可迁移；含昵称（PII），仅内网留存 |
| 无 | 无数据库、无账号、无上传 | — |

回放跨机迁移：把整个 `data/matches/` 目录拷到新机同路径即可。

## 运维检查单

- [ ] `curl http://127.0.0.1:27182/healthz` → 200
- [ ] 双浏览器进房 → 开局可玩
- [ ] 磁盘余量（日志每局约 0.5–2MB；64 人 8 分钟满事件约 10MB）
- [ ] 活动后归档 `data/matches/` 并清理

## 安全边界（内网模型）

本部署模型**不含**公网加固（ADR-0008 明确放弃项）：

- 未设置 `-addr` / `OMB_ADDR` 时只监听 `127.0.0.1`；设置全网卡或局域网地址会开放对应 TCP 入口（ADR-0014）
- 无 TLS 加密（内网 HTTP/WS 明文传输；公网意图请一律走反向代理）
- 无鉴权/限流/防滥用（互信群体）
- 房间码即访问凭据（4–8 位，可枚举——仅内网可接受）

若需临时公网联机：放到反向代理（TLS + IP 白名单）后面，风险自担；完整公网化需要账号与审核体系，不在 v1 范围。
