# 部署指南

> v0.1.0+。内部破冰活动定位（ADR-0008）：私有部署、内网或单机 LAN，无公网暴露。

## 部署形态

**单二进制**：`omb(.exe)` 内嵌前端与手册（`go:embed`），运行时只需：
- 二进制本身
- 可写目录 `data/matches/`（对局日志，自动创建）
- 环境变量（可选）：`DEEPSEEK_API_KEY`

无数据库、无外部依赖。任意内网机器（含活动室笔记本）即起即用。

## 构建

在开发机（需 Go 1.24 + Node 22 + pnpm 10）：

```bash
git clone https://github.com/modenicheng/oh-my-bot && cd oh-my-bot
bash build.sh                      # 产出 server/omb.exe（Windows）
# Linux 目标（活动室常为 Linux 盒子）：
cd server && GOOS=linux GOARCH=amd64 go build -o omb ./cmd/omb
```

> embed 是编译期快照：`build.sh` 内已含"dist→web/、manual→manual/ 拷贝"步骤，
> 交叉编译前必须先跑一次 build.sh 的前端部分（或完整跑一遍再单独交叉编译）。

## 运行

```bash
./omb -addr :8080     # 默认 :8080；监听 0.0.0.0 可被 LAN 访问
```

防火墙放行端口（Windows：`netsh advfirewall firewall add rule name="omb" dir=in action=allow protocol=tcp localport=8080`；Linux 视发行版）。

验证：

```bash
curl http://<host>:8080/healthz         # 200
# 浏览器打开 http://<host>:8080/ → 进房即玩
```

## systemd 常驻（Linux）

```ini
# /etc/systemd/system/omb.service
[Unit]
Description=oh-my-bot server
After=network.target

[Service]
WorkingDirectory=/opt/omb          # 日志写到 <WorkingDirectory>/data/matches
ExecStart=/opt/omb/omb -addr :8080
Restart=on-failure
# Environment=DEEPSEEK_API_KEY=sk-xxx   # 启用 AI 时取消注释

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now omb
journalctl -u omb -f                # 跟日志
```

## docker（备选）

项目无 Dockerfile（v1 未做镜像化，ADR 延期清单）；需要时：

```dockerfile
FROM golang:1.24 AS build        # 需先在 CI 里产出 web/ manual/ embed 目录
COPY server/ /src/server/
WORKDIR /src/server
RUN CGO_ENABLED=0 go build -o /omb ./cmd/omb
FROM gcr.io/distroless/static
COPY --from=build /omb /omb
WORKDIR /app                     # 日志落 /app/data/matches（挂卷持久化）
ENTRYPOINT ["/omb", "-addr", ":8080"]
```

```bash
docker run -d -p 8080:8080 -v omb-data:/app/data omb:latest
```

## AI Agent 启用（可选）

```bash
export DEEPSEEK_API_KEY=sk-xxx    # DeepSeek 平台申请
./omb -addr :8080
```

配额自动生效（ADR-0010 r2）：每人每局 20 轮 + 300k token、全局并发 20、
单局全员 2M token 护栏、热身场同池。计量读 DeepSeek 响应 usage 字段。

未配 key 时 AI 入口返回"not configured"提示，其余功能不受影响。

## 数据与备份

| 路径 | 内容 | 策略 |
|---|---|---|
| `data/matches/*.jsonl` | 对局事件日志（回放/统计唯一事实源） | tar 归档即可迁移；含 PII（昵称）内网留存 |
| 无 | 无数据库、无账号、无上传 | — |

回放跨机迁移：拷贝整个 `data/matches/` 到新机同路径。

## 运维检查单

- [ ] `curl :8080/healthz` → 200
- [ ] 双浏览器进房 → 开局可玩
- [ ] 磁盘余量（日志每局约 0.5–2MB，64 人 8 分钟满事件约 10MB）
- [ ] 活动后归档 `data/matches/` 并清理
- [ ] （若启用）DeepSeek 余额与用量监控

## 安全边界（内网模型）

本设计**不含**公网硬化（ADR-0008 明确放弃项）：
- 无 TLS 终止（内网 HTTP/WS 明文）
- 无鉴权/限流/防滥用（互信群体）
- 房间码即访问凭据（4–8 位，可枚举——仅内网可接受）

若需临时公网联机：置于反向代理（TLS + IP 白名单）之后，风险自担；完整公网化需补账号与审核体系（不在 v1 范围）。
