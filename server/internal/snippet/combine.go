package snippet

import (
	"fmt"
	"strings"
)

// Combine 把玩家源码与已启用的官方 Snippet 模块组合成一份可装载 JS。
//
// 结构（单一 goja VM 全局作用域）：
//
//	// —— 官方 Snippet 注册表（装载时由 Go 定义为不可写绑定）——
//	(function(){ // 官方 Snippet：自动瞄准
//	  <模块源码：定义 snippetTick(bot)>
//	  __ombSnips.push(snippetTick);
//	})();
//	…
//	// —— 玩家源码（顶层作用域，tick/bot 入口由 Runtime 照常解析）——
//	<playerSource>
//
// 执行模型：每 tick 由 GojaRuntime 驱动（同一 VM、同一配额）——
// 先调玩家入口（玩家归因），再按注册顺序调各 snippetTick(bot)
// （snippet 归因；玩家已操作的轴在 Go 侧丢弃——见 script 包归因收集器）。
// 组合优先级（稳定规则）：玩家源码 > 官方 Snippet（catalog 顺序内
// 后者覆盖前者）；人类输入仍在 sim 仲裁层最高优先（ADR-0009）。
//
// playerSource 可为空（snippet-only 运行）。
func Combine(playerSource string, cfg []Setting) (string, error) {
	var b strings.Builder
	b.WriteString("// ==== oh-my-bot：官方 Snippet + 玩家源码组合 ====\n")
	b.WriteString("// 注册表 __ombSnips 由运行时在装载期定义为不可写绑定。\n")
	for _, s := range cfg {
		mod := ModuleOf(s.Kind)
		if mod == nil {
			return "", fmt.Errorf("snippet: unknown kind %d", s.Kind)
		}
		b.WriteString("(function(){ // 官方 Snippet：")
		b.WriteString(mod.Title)
		b.WriteString("\n")
		b.WriteString(mod.Source(s))
		b.WriteString("\n__ombSnips.push(snippetTick);\n})();\n")
	}
	// 玩家源码位于其后：先冻结数组，配合运行时的只读全局绑定，
	// 防止玩家顶层代码删除、替换或注入所谓“官方”模块。
	b.WriteString("Object.freeze(__ombSnips);\n")
	if playerSource != "" {
		b.WriteString("// ==== 玩家源码 ====\n")
		b.WriteString(playerSource)
		b.WriteString("\n")
	}
	return b.String(), nil
}
