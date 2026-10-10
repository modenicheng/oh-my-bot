# oh-my-bot

**64 人实时机器人大乱斗**：每人一台机器人，在圆形竞技场抢资源、互射、黑入得分设备，一局 8 分钟。手操就能玩；不想手操，可以挂官方 Snippet 驾驶辅助，可以用中文让游戏内 AI 改码，也可以自己写 JS/TS 脚本，服务器负责运行和局内热更。定位是小组织内部破冰活动：私有部署，无公开服务。

## 三分钟跑起来

前置：Go ≥ 1.25、Node ≥ 22、pnpm ≥ 10，以及 Bash（Windows 可用 Git Bash）。Go 编译服务器，Node/pnpm 构建前端。

```bash
pnpm install          # 首次构建先安装依赖
bash build.sh          # 一键构建：类型检查 → 前端打包 → 内嵌 → 编译出 server/omb.exe
cd server
./omb.exe              # 启动（默认监听 127.0.0.1:27182）；浏览器打开 http://127.0.0.1:27182/ 即玩
```

详细说明（本地调试、开发循环、常见问题）：[docs/runbook.md](docs/runbook.md)。内网部署与常驻运行：[docs/deploy.md](docs/deploy.md)。发版与预编译下载见 [GitHub Releases](https://github.com/modenicheng/oh-my-bot/releases)（流程见 [docs/deploy.md](docs/deploy.md) CI/CD 章节）。

## 玩家文档

游戏内置手册（按 `M` 或点手册按钮）来自 [`docs/manual/`](docs/manual/index.md)：

- [玩家手册首页](docs/manual/index.md) — 上手四步、四种玩法、核心概念速查
- [你的第一局](docs/manual/start/first-match.md) — 手操走位、抢 Core、抢桩
- [游戏规则](docs/manual/rules/game-rules.md) / [操作与仲裁](docs/manual/rules/controls.md)
- [写第一个 Bot](docs/manual/code/bot-scripting.md) — 从 tick 模型到提交契约，零基础也能读
- [API 总览](docs/manual/reference/index.md) — 13 个动作 + 数据结构 + 语义陷阱，示例统一 JS/TS

## 仓库布局

| 路径 | 内容 |
|---|---|
| `server/` | Go 权威服务器：60Hz 模拟、房间管理、脚本沙箱、AI 改码代理 |
| `client/` | TS + Canvas2D 网页客户端：房间页 / 游戏页 / 回放页 / 内置手册阅读器 |
| `packages/bot-api/` | 玩家脚本 API 的 TS 类型定义（双受众：人写代码 + AI 语料） |
| `bots/` | 官方 Bot 脚本（TS，经 goja 运行时执行；含 oracle 与其测试） |
| `packages/protocol/` | 客户端与服务器的通信消息定义（protobuf 源 + 生成物 + 传输层） |
| `protocol/` | protobuf schema 源与代码生成配置 |
| `docs/` | 玩家手册（manual）、运行与部署指南（runbook / deploy）、设计文档与决策记录 |
| `CONTEXT.md` | 项目术语表（唯一事实源） |

## 开发

```bash
# 日常开发：前端 HMR + Go 自动重启 + 手册磁盘直读（需先安装 air，见 runbook）
pnpm dev

# 发布或验证单二进制时重新构建，更新编译期内嵌的前端和手册
bash build.sh

# 设计文档工作流：本地 git 为权威源，astral 为镜像（每轮结束推送）
astral document push CONTEXT.md --file CONTEXT.md
```

协议（`.proto`）变更后双语言重新生成：`cd protocol && npx buf generate`。
