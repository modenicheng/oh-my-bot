package script

import "regexp"

// ============ TS 探测（v1 拒绝 TS，编译器引入延后） ============

var (
	// tsTypeAnnot TS 专属类型注解形态。只认 TS 类型名/箭头函数返回注解/
	// 变量声明注解，避免误伤 JS 对象字面量 `key: 'value'` 与三元 `a ? b : c`。
	tsTypeAnnot = regexp.MustCompile(
		`(?:\(\s*[A-Za-z_$][\w$]*\s*:\s*[A-Za-z_$][\w$.]*(?:<[^>()]*>)?\s*\)\s*:\s*[A-Za-z_$][\w$.]*(?:<[^>()]*>)?\s*=>|` + // (a: T): R =>
			`\b(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*(?:!\s*)?:\s*[A-Za-z_$][\w$.]*(?:<[^>]*>)?\s*[=;,]|` + // let x: T = /;
			`^\s*[A-Za-z_$][\w$]*\s*(?:!\s*)?:\s*(?:number|string|boolean|void|any|unknown|never|Vec2|RobotRef|Observation|Self|GameInfo|BotModule)\b)`,
	)
	// tsDecl TS 专属顶层声明（interface/type/enum/declare/abstract/namespace）。
	tsDecl = regexp.MustCompile(`(?m)^\s*(?:export\s+)?(?:type|interface|enum|declare|abstract|namespace)\s+[A-Za-z_$]`)
	// tsKeyword TS 专属语法关键字组合。
	tsKeyword = regexp.MustCompile(`\b(?:as\s+const|keyof\s+typeof|satisfies\s+[A-Za-z_$]|readonly\s+[A-Za-z_$][\w$]*\s*!\s*:)`)
	// tsAngle TS 泛型调用/标注残留（Array<number>、Map<string, number>）。
	tsAngle = regexp.MustCompile(`\b(?:Array|Map|Set|Promise|Record|Partial|Readonly)<`)
)

// detectTypeScript TS 启发式探测。从宽：误报只是拒绝提交（玩家改写源码即可）；
// 漏报由 goja 编译错兜底——同样拒绝、不替换旧版，安全侧一致。
func detectTypeScript(src string) bool {
	return tsTypeAnnot.MatchString(src) ||
		tsDecl.MatchString(src) ||
		tsKeyword.MatchString(src) ||
		tsAngle.MatchString(src)
}
