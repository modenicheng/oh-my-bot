package main

import (
	"encoding/json"
	"io/fs"
	"os"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
)

func floatPtr(v float64) *float64 { return &v }

func requireTitle(t *testing.T, raw, want string) {
	t.Helper()
	if got := manualFrontmatter(raw).Title; got != want {
		t.Fatalf("title = %q, want %q", got, want)
	}
}

func requireTags(t *testing.T, raw string, want ...string) {
	t.Helper()
	got := manualFrontmatter(raw).Tags
	if len(got) != len(want) {
		t.Fatalf("tags = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("tags = %v, want %v", got, want)
		}
	}
}

func requireOrder(t *testing.T, raw string, want *float64) {
	t.Helper()
	got := manualFrontmatter(raw).Order
	if want == nil {
		if got != nil {
			t.Fatalf("order = %v, want nil", *got)
		}
		return
	}
	if got == nil {
		t.Fatalf("order = nil, want %v", *want)
	}
	if *got != *want {
		t.Fatalf("order = %v, want %v", *got, *want)
	}
}

func TestManualFrontmatterTitle(t *testing.T) {
	// Plain, quoted (may contain commas/colons), and escaped Chinese titles.
	requireTitle(t, "---\ntitle: 写第一个 Bot\n---\n正文", "写第一个 Bot")
	requireTitle(t, "---\ntitle: \"入门：准备, 环境\"\n---\n", "入门：准备, 环境")
	requireTitle(t, "---\ntitle: '规则：''核心'''\n---\n", "规则：'核心'")
	requireTitle(t, "---\ntitle: \"称号 \\\"苟王\\\"\"\n---\n", "称号 \"苟王\"")
	// Last title line wins, matching document order.
	requireTitle(t, "---\ntitle: 甲\ntitle: 乙\n---\n", "乙")
	// Unknown keys (audience included) survive without breaking parsing.
	requireTitle(t, "---\naudience: both\ntitle: 规则\nrandom: x\n---\n", "规则")
}

func TestManualFrontmatterHeaderEdges(t *testing.T) {
	// No header, empty doc, and body-only documents never yield metadata.
	requireTitle(t, "# 写第一个 Bot\n正文", "")
	requireTitle(t, "", "")
	// Unterminated header is never treated as metadata.
	requireTitle(t, "---\ntitle: 未闭合\n正文仍在继续", "")
	// BOM plus CRLF still parse.
	requireTitle(t, "\xef\xbb\xbf---\r\ntitle: 跨平台\r\n---\r\n正文", "跨平台")
	// Frontmatter must start on the first line.
	requireTitle(t, "\n---\ntitle: 偏移\n---\n", "")
}

func TestManualFrontmatterTags(t *testing.T) {
	// Scalar tag.
	requireTags(t, "---\ntag: 入门\n---\n", "入门")
	// Inline array with Chinese values containing commas inside quotes.
	requireTags(t, "---\ntags: [\"新手, 必读\", 入门]\n---\n", "新手, 必读", "入门")
	// Dash list under bare `tags:`.
	requireTags(t, "---\ntags:\n  - 新手\n  - \"含, 逗号\"\n  - '带''引号'\n---\n", "新手", "含, 逗号", "带'引号")
	// Duplicate tags collapse; empty items and nulls are dropped.
	requireTags(t, "---\ntag: 新手\ntags: [新手, \"\", null]\n---\n", "新手")
	// Single-quoted scalar with a comma stays one tag.
	requireTags(t, "---\ntag: 'a, b'\n---\n", "a, b")
	// Escaped double quotes inside a double-quoted tag list item.
	requireTags(t, "---\ntags: [\"杀\\\"毒\\\"\"]\n---\n", "杀\"毒\"")
	// Unknown list keys are ignored entirely.
	requireTags(t, "---\nweapons:\n  - 棒子\n---\n")
}

func TestManualFrontmatterOrder(t *testing.T) {
	// Integer, zero, negative and float orders are all valid.
	requireOrder(t, "---\norder: 2\n---\n", floatPtr(2))
	requireOrder(t, "---\norder: 0\n---\n", floatPtr(0))
	requireOrder(t, "---\norder: -3\n---\n", floatPtr(-3))
	requireOrder(t, "---\norder: 1.5\n---\n", floatPtr(1.5))
	requireOrder(t, "---\norder: \"10\"\n---\n", floatPtr(10))
	// Invalid, missing, NaN/Inf, and overflow values leave order unset.
	requireOrder(t, "---\norder: 三\n---\n", nil)
	requireOrder(t, "---\ntitle: 无序\n---\n", nil)
	requireOrder(t, "---\norder: .nan\n---\n", nil)
	requireOrder(t, "---\norder: .inf\n---\n", nil)
	requireOrder(t, "---\norder: 1e999\n---\n", nil)
	// Later valid value replaces an earlier invalid one.
	requireOrder(t, "---\norder: bad\norder: 4\n---\n", floatPtr(4))
}

func TestBuildManualTreeOrdering(t *testing.T) {
	fsys := fstest.MapFS{
		// Chapter label/order come from the directory index.md.
		"guide/index.md":      {Data: []byte("---\ntitle: 新手指南\norder: 1\n---\n")},
		"guide/prepare.md":    {Data: []byte("---\ntitle: 准备环境\norder: 2\n---\n")},
		"guide/first.md":      {Data: []byte("---\ntitle: 第一场对局\norder: 1\n---\n")},
		"guide/no-order.md":   {Data: []byte("---\ntitle: 无序页\n---\n")},
		"rules/index.md":      {Data: []byte("---\ntitle: 游戏规则\norder: 2\n---\n")},
		"rules/r-rules.md":    {Data: []byte("---\norder: 5\n---\n")},
		"rules/a-page.md":     {Data: []byte("---\norder: 5\n---\n")},
		"zeta.md":             {Data: []byte("---\norder: -1\n---\n")},
		"alpha.md":            {Data: []byte("---\norder: 3\n---\n")},
		"later.md":            {Data: []byte("---\norder: 10\n---\n")},
		"default-no-order.md": {Data: []byte("# 无序\n")},
	}
	tree := buildManualTreeFS(fsys, ".")
	if len(tree) != 6 {
		t.Fatalf("root children = %d (%v), want 6", len(tree), pathsOf(tree))
	}
	wantPaths := []string{"zeta", "guide", "rules", "alpha", "later", "default-no-order"}
	for i, want := range wantPaths {
		if tree[i].Path != want {
			t.Fatalf("root child %d = %q, want %q", i, tree[i].Path, want)
		}
	}
	if tree[1].Title != "新手指南" {
		t.Fatalf("guide title = %q, want 新手指南", tree[1].Title)
	}
	guide := tree[1].Children
	// The chapter landing page (directory index.md, no explicit order) also
	// appears as a child and sorts after its ordered siblings.
	if len(guide) != 4 {
		t.Fatalf("guide children = %d, want 4", len(guide))
	}
	// Ordered pages first (ascending), default-order pages last.
	wantGuide := []string{"guide/first", "guide/index", "guide/prepare", "guide/no-order"}
	for i, want := range wantGuide {
		if guide[i].Path != want {
			t.Fatalf("guide child %d = %q, want %q", i, guide[i].Path, want)
		}
	}
	// The landing page keeps its own frontmatter order as a child (2 here), so
	// it sorts before the order-5 pages; equal orders keep stable path order.
	rules := tree[2].Children
	if len(rules) != 3 || rules[0].Path != "rules/index" || rules[1].Path != "rules/a-page" || rules[2].Path != "rules/r-rules" {
		t.Fatalf("rules order = %v, want [rules/index rules/a-page rules/r-rules]", pathsOf(rules))
	}
	// Ordered nodes come before default-order ones regardless of filename.
	if tree[5].Path != "default-no-order" {
		t.Fatalf("last root child = %q, want default-no-order", tree[5].Path)
	}
}

func TestBuildManualTreeSkipsAndDefaults(t *testing.T) {
	fsys := fstest.MapFS{
		".hidden.md":       {Data: []byte("---\ntitle: 隐藏\n---\n")},
		"notes.txt":        {Data: []byte("not markdown")},
		"only-txt/n.txt":   {Data: []byte("not markdown")},
		"plain.md":         {Data: []byte("# 只有正文\n")},
		"reference/api.md": {Data: []byte("---\ntags: [脚本, L0]\n---\n")},
	}
	tree := buildManualTreeFS(fsys, ".")
	// Hidden files, non-markdown, and childless directories are skipped.
	if len(tree) != 2 {
		t.Fatalf("root children = %d (%v), want 2", len(tree), pathsOf(tree))
	}
	if tree[0].Path != "plain" || tree[0].Title != "plain" {
		t.Fatalf("plain node = %+v, want filename fallback title", tree[0])
	}
	ref := tree[1]
	if ref.Path != "reference" || ref.Title != "reference" {
		t.Fatalf("reference node = %+v", ref)
	}
	// Directory tags come from its index.md; reference/ has none here, so its
	// child keeps its own tags.
	api := ref.Children[0]
	if api.Path != "reference/api" {
		t.Fatalf("reference child = %q, want reference/api", api.Path)
	}
	if len(api.Tags) != 2 || api.Tags[0] != "脚本" || api.Tags[1] != "L0" {
		t.Fatalf("api tags = %v, want [脚本 L0]", api.Tags)
	}
}

func TestManualNodeJSONOmitsEmpty(t *testing.T) {
	// Nodes without tags/order must not emit empty JSON keys.
	data, err := json.Marshal(manualNode{Path: "p", Title: "标题"})
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	for _, banned := range []string{`"tags"`, `"order"`, `"children"`} {
		if strings.Contains(got, banned) {
			t.Fatalf("json = %s, should omit %s", got, banned)
		}
	}
}

func TestLoadAIManualCorpusFSOnlyBoth(t *testing.T) {
	fsys := fstest.MapFS{
		"a.md": {Data: []byte("---\naudience: both\ntitle: A\n---\nA 内容")},
		"b.md": {Data: []byte("---\naudience: human\ntitle: B\n---\nB 内容")},
		"c.md": {Data: []byte("# 无 audience")},
		"z.md": {Data: []byte("---\naudience: both\ntitle: Z\n---\nZ 内容")},
	}
	corpus := loadAIManualCorpusFS(fsys, ".")
	if len(corpus) != 2 || !strings.Contains(corpus[0], "A 内容") || !strings.Contains(corpus[1], "Z 内容") {
		t.Fatalf("corpus = %#v", corpus)
	}
	if strings.Contains(strings.Join(corpus, "\n"), "B 内容") {
		t.Fatal("human-only manual leaked into AI corpus")
	}
}

func pathsOf(nodes []manualNode) []string {
	out := make([]string, len(nodes))
	for i, n := range nodes {
		out[i] = n.Path
	}
	return out
}

// TestManualDocsLayoutSnapshot 用真实 docs/manual 锁定目录顺序：
// 首页 → 快速上手 → 游戏规则 → 写自己的 Bot → API 参考；
// 章节内 index 落地页在最前，页面按 order 升序（非字典序）。
func TestManualDocsLayoutSnapshot(t *testing.T) {
	fsys := os.DirFS("../../docs/manual")
	if _, err := fs.Stat(fsys, "index.md"); err != nil {
		t.Skip("docs/manual not present in this checkout")
	}
	tree := buildManualTreeFS(fsys, ".")
	var rootPaths []string
	for _, n := range tree {
		rootPaths = append(rootPaths, n.Path)
	}
	wantRoot := []string{"index.md", "start", "rules", "code", "reference"}
	if !reflect.DeepEqual(rootPaths, wantRoot) {
		t.Fatalf("root order = %v, want %v", rootPaths, wantRoot)
	}
	// 章节中文名来自各自 index.md，而非前后端硬编码。
	if tree[1].Title != "快速上手" || tree[2].Title != "游戏规则" ||
		tree[3].Title != "写自己的 Bot" || tree[4].Title != "API 总览" {
		t.Fatalf("chapter titles = %v", []string{tree[1].Title, tree[2].Title, tree[3].Title, tree[4].Title})
	}
	// start 章节内部：index 落地页在前，页面按 order（11..14）非字典序。
	var startPaths []string
	for _, c := range tree[1].Children {
		startPaths = append(startPaths, c.Path)
	}
	wantStart := []string{"start/index.md", "start/prepare.md", "start/first-match.md", "start/snippet.md", "start/ai-agent.md"}
	if !reflect.DeepEqual(startPaths, wantStart) {
		t.Fatalf("start order = %v, want %v", startPaths, wantStart)
	}
	// reference 章节内部。
	var refPaths []string
	for _, c := range tree[4].Children {
		refPaths = append(refPaths, c.Path)
	}
	wantRef := []string{"reference/index.md", "reference/actions.md", "reference/helpers.md", "reference/data.md", "reference/modules.md"}
	if !reflect.DeepEqual(refPaths, wantRef) {
		t.Fatalf("reference order = %v, want %v", refPaths, wantRef)
	}
}
