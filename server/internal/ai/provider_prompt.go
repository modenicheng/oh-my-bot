package ai

import (
	"strings"

	"github.com/modenicheng/oh-my-bot/server/internal/botapi"
)

// buildSystemPrompt 的静态组成部分（provider_deepseek.go 组装）。
//
// API 类型语料来自 internal/botapi 内嵌的 @omb/bot-api 权威源副本
//（审计 X-1：不再维护手抄镜像）；手册章节由 PromptContext.Manual 在
// 运行时注入（audience=both 章节由 glue 层挑选），不在此硬编码。

// fence 是 markdown 代码围栏（Go 原始字符串无法内嵌反引号，经拼接注入）。
const fence = "```"

// systemInstruction 输出契约与写作纪律（最高优先级段）+ API 摘要。
func systemInstruction() string {
	var b strings.Builder
	b.WriteString("你是 oh-my-bot 游戏的 Bot Script 编程助手。玩家会给你一份当前 Bot Script（JavaScript）和一条自然语言修改指令，你要产出修改后的完整新版脚本。\n\n")

	b.WriteString("## 输出要求（最高优先级）\n\n")
	b.WriteString("只输出完整新版 JavaScript：一个以 " + fence + "js 开头、" + fence + " 结尾的代码块，不要输出任何其他解释、前言或结语。服务器直接加载 JavaScript，不会编译 TypeScript：禁止类型注解、interface、enum、as 类型断言。入口必须是顶层 `function tick(bot) { ... }`，或 `const bot = { tick(bot) { ... } }; export default bot`；不要输出内联 `export default { ... }`。不得输出片段、省略号或‘其余不变’。\n\n")

	b.WriteString("## Bot Script 运行模型\n\n")
	b.WriteString("脚本入口是顶层 `function tick(bot) { ... }`，或先定义 `const bot = { tick(bot) { ... } }` 再单独 `export default bot`。tick 每秒调用 60 次（60Hz，与模拟同频）；模块级顶层变量跨 tick 存活（记忆状态放顶层变量，不要挂全局单例）；单 tick 预算 10ms，超时该 tick 被强制中断且机器人 idle——禁止死循环与长计算。\n\n")

	b.WriteString("## 脚本 API（@omb/bot-api）\n\n")
	b.WriteString(botAPITypes())

	b.WriteString("\nUse the flat API: call `bot.scan()` for observations, read `bot.self.position`, and call `bot.navigateTo()` / `bot.move()` / `bot.aimAt()` / `bot.fire()` directly. Never generate `ctx.api`, `ctx.obs`, `self.pos`, or `api.aim`. Prefer `navigateTo` for movement goals. Health packs are collected by movement contact; there is no `pickup()`.\n")

	b.WriteString("\n动作只对当前 tick 生效；持续动作要每 tick 调用。shield 与 dash 互斥且 shield 优先。各动作的成本/射程/冷却数值见上方各方法注释。\n\n")
	b.WriteString("刻意不提供（不要幻想调用）：寻路、弹道预测、威胁评估、检测玩家是否在手操（脚本感知不到手操状态，分轴仲裁已处理）。API 之外不存在任何全局函数或对象。\n")
	return b.String()
}

// botAPITypes 输出 @omb/bot-api 类型定义（权威源 verbatim 副本）：
// 手册式成员注释（成本/射程/冷却数值）随之进入 prompt，无需手工同步。
// 单行注释头（文件级 // 注释）不属于 API 面，剔除以压缩 token；
// 生成副本与权威源的新鲜度由 internal/botapi 测试对拍保证。
func botAPITypes() string {
	return fence + "ts\n" + stripLineComments(botapi.Source) + "\n" + fence
}

// stripLineComments 删除 TS 源中整行的 // 注释（文件头/行尾注释）。
// interface/JSDoc 声明保留；字符串字面量内不存在 // （本源已核对）。
func stripLineComments(src string) string {
	var b strings.Builder
	for _, line := range strings.Split(src, "\n") {
		trimmed := strings.TrimLeft(line, " \t")
		if strings.HasPrefix(trimmed, "//") {
			continue
		}
		if i := strings.Index(line, " //"); i >= 0 {
			line = line[:i]
		}
		// 行内注释剥离后去除行尾空白，保证输出稳定。
		b.WriteString(strings.TrimRight(line, " \t"))
		b.WriteByte('\n')
	}
	return strings.TrimRight(b.String(), "\n")
}
