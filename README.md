# oh-my-bot

64 人实时机器人派对大乱斗：任何人手操入场，逐步用 Snippet、AI 或代码接管自己的机器人。
小组织内部破冰活动，私有部署，无公开服务。项目语境与术语见根目录 `CONTEXT.md`；设计基准 `docs/design/game_design_v0.3.md`；决策记录 `docs/adr/`。

## 仓库布局

| 路径 | 内容 |
|---|---|
| `server/` | Go 权威模拟：60Hz 单时钟、事件溯源、房间/Session、goja 脚本沙箱、AI 代理 |
| `client/` | TS + PixiJS：房间页 / 游戏页 / 回放页 + Monaco 编辑器 + MD 阅读器 |
| `bot-api/` | 玩家脚本 API 的 TS 类型定义（双受众：人写代码 + AI 语料） |
| `protocol/` | 客户端⇄服务器 WS 消息契约（schema 源 + 生成物） |
| `docs/` | design / adr / manual |
| `CONTEXT.md` | 唯一术语表 |

## 构建

前置：Go ≥1.24、Node ≥22、pnpm ≥10。

```bash
# 前端与共享包（构建序：bot-api → protocol → client）
pnpm install && pnpm -r build

# 服务器（embed client 产物）
cd server && go build ./cmd/omb
```

## 开发

```bash
# 设计文档工作流：本地 git 为权威源，astral 为镜像（每轮结束推送）
astral document push CONTEXT.md --file CONTEXT.md
```
