# AI Agent 平台代理与双轨配额

平台内嵌 AI Agent（自然语言→改本玩家 Bot Script→热更生效），外部 LLM 一律经平台侧 AIProvider 抽象代理接入，玩家不自带 key。首个实现指向 DeepSeek 官方 API（deepseek-chat），token 计量读响应 usage 字段累加。配额双轨：每玩家每局 20 轮提示（Agent 自身工具调用不计轮次）+ 300k token；两者均写入 Match Event Log，供「AI 常客／烧 token 大户」类称号投影。放弃了玩家自带 key 方案（破坏计量与配额）；AI Agent 只能访问本玩家代码与感知数据。
