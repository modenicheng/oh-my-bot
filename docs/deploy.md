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

## AI Agent 接入状态

当前房间链路仍返回 `not configured` 占位提示，网页也没有 AI 对话入口；仅设置 `DEEPSEEK_API_KEY` 不会启用改码。仓库的 DeepSeek Provider 和配额组件已有实现，尚需完成房间及客户端接入。默认配额与限制见 [AI Agent 接入状态](manual/start/ai-agent.md)。

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
