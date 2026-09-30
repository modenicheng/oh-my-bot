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
./omb -addr :8080     # 监听 8080 端口；默认即 :8080
```

监听 `0.0.0.0`（默认行为），同一局域网的机器都能访问 `http://<这台机器的IP>:8080/`。

防火墙放行 8080 端口（不熟悉的话：防火墙是操作系统的门卫，默认拦外面的连接，要给它打个招呼）：

- Windows：`netsh advfirewall firewall add rule name="omb" dir=in action=allow protocol=tcp localport=8080`
- Linux：视发行版（`ufw allow 8080` 或 `firewall-cmd --add-port=8080/tcp`）

验证：

```bash
curl http://<host>:8080/healthz         # 返回 200 = 活着
# 浏览器打开 http://<host>:8080/ → 进房即玩
```

## systemd 常驻（Linux）

活动室机器一般希望"开机自动跑、崩了自动拉起"——Linux 上标准做法是 systemd 服务（系统自带的进程管家）：

```ini
# 文件放在 /etc/systemd/system/omb.service
[Unit]
Description=oh-my-bot server
After=network.target

[Service]
# 日志写到 /opt/omb/data/matches
WorkingDirectory=/opt/omb
ExecStart=/opt/omb/omb -addr :8080
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now omb
journalctl -u omb -f                # 跟踪日志
```

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
ENTRYPOINT ["/omb", "-addr", ":8080"]
```

```bash
docker build -t omb:latest .
docker run -d -p 8080:8080 -v omb-data:/app/data omb:latest
```

## AI Agent 接入状态

当前房间链路仍返回 `not configured` 占位提示，网页也没有 AI 对话入口；仅设置 `DEEPSEEK_API_KEY` 不会启用改码。仓库的 DeepSeek Provider 和配额组件已有实现，尚需完成房间及客户端接入。默认配额与限制见 [AI Agent 接入状态](manual/start/ai-agent.md)。

## 数据与备份

| 路径 | 内容 | 策略 |
|---|---|---|
| `data/matches/*.jsonl` | 对局事件日志（回放与统计的唯一事实源） | tar 归档即可迁移；含昵称（PII），仅内网留存 |
| 无 | 无数据库、无账号、无上传 | — |

回放跨机迁移：把整个 `data/matches/` 目录拷到新机同路径即可。

## 运维检查单

- [ ] `curl http://localhost:8080/healthz` → 200
- [ ] 双浏览器进房 → 开局可玩
- [ ] 磁盘余量（日志每局约 0.5–2MB；64 人 8 分钟满事件约 10MB）
- [ ] 活动后归档 `data/matches/` 并清理

## 安全边界（内网模型）

本部署模型**不含**公网加固（ADR-0008 明确放弃项）：

- 无 TLS 加密（内网 HTTP/WS 明文传输）
- 无鉴权/限流/防滥用（互信群体）
- 房间码即访问凭据（4–8 位，可枚举——仅内网可接受）

若需临时公网联机：放到反向代理（TLS + IP 白名单）后面，风险自担；完整公网化需要账号与审核体系，不在 v1 范围。
