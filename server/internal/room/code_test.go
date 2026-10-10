package room

import "testing"

// TestValidCodeAcceptsGeneratedCodes：ValidCode 与 GenerateCode 同一字母表
// （单源：codeCharSet 由 codeAlphabet 派生）——生成器产出必须全数通过。
func TestValidCodeAcceptsGeneratedCodes(t *testing.T) {
	for i := 0; i < 100; i++ {
		code := GenerateCode()
		if !ValidCode(code) {
			t.Fatalf("generated code %q rejected by ValidCode (alphabet drift?)", code)
		}
	}
}

// TestValidCodeRejectsDegenerateInput（审计 S-31）：空房码（共享 "" 房的根源）、
// 小写、易混字符 0/O/1/I、超长、符号与多字节一律拒绝。
// 注意：字母表排除易混字符意味着历史浏览器脚本用的 O/I 形房码（TAKEOVER/
// SOLOBOT/SHOT/…）不再可加入——这是刻意的收紧（见审计台账 S-31 报告注记）。
func TestValidCodeRejectsDegenerateInput(t *testing.T) {
	valid := []string{"A", "SPEC", "HEALTH", "MVPRE2", "FEEL2", "ABCDEFGH"}
	for _, code := range valid {
		if !ValidCode(code) {
			t.Fatalf("ValidCode(%q) = false, want true", code)
		}
	}
	invalid := []string{
		"",          // 空房码：互不相干用户共享 "" 房（S-31 根因）
		" spec",     // 前导空白
		"SPEC ",     // 尾随空白
		"spec",      // 小写
		"Spec",      // 混合大小写
		"AB12",      // '1' 不在字母表（易混字符）
		"NAV1",      // 同上
		"AIMGRD",    // 'I' 不在字母表（历史脚本房码）
		"R0OM",      // '0' 不在字母表
		"OIL",       // 'O' 与 'I'
		"TAKEOVER",  // 含 'O'：字母表收紧后拒绝（历史脚本房码）
		"LIVEBOT",   // 含 'I' 与 'O'
		"ABCDEFGHI", // 超过 maxJoinCodeLen
		"SP-EC",     // 符号
		"码",         // 多字节
	}
	for _, code := range invalid {
		if ValidCode(code) {
			t.Fatalf("ValidCode(%q) = true, want false", code)
		}
	}
}
