# AI Agent 平台代理与双轨配额

平台内嵌 AI Agent（自然语言→改本玩家 Bot Script→热更生效），外部 LLM 一律经平台侧 AIProvider 抽象代理接入，玩家不自带 key。首个实现指向 DeepSeek 官方 API（deepseek-chat），token 计量读响应 usage 字段累加。配额双轨：每玩家每局 20 轮提示（Agent 自身工具调用不计轮次）+ 300k token；两者均写入 Match Event Log，供「AI 常客／烧 token 大户」类称号投影。放弃了玩家自带 key 方案（破坏计量与配额）；AI Agent 只能访问本玩家代码与感知数据。

## 修订（2026-09-29，复审 D7）：并发与全局护栏

- **热身场同池计费**：Warmup 内 AI 调用同样消耗该局配额，规则一致不留歧义。
- **全局并发 20**（对齐 DeepSeek 官方并发限制，可配置）：信号量控制；单玩家串行（同一玩家同时只有 1 个 AI 请求在途）。
- **单局全局护栏 2M token**：全局累计触顶后全员禁 AI（提示“本局 AI 额度已尽”），防止 64 人全用满的 1,920 万 token 理论峰值。

依据：docs/design/reviews/2026-09-29-gpt6-astra-audit.md 发现 #10。
