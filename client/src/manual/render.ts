// 手册 markdown 渲染：marked v18 + 自定义 code renderer（多语言 tab 组）。
//
// tab 组语法（v1 设计裁决：特殊 codeblock，非插件指令）——
// 连续的同缩进代码块序列，首个块 info string 含 "|" 即为 tab 组头：
//   ```ts|py|java        ← 组头：声明语言顺序，内容是占位说明
//   后续连续 code block 按各自 info 语言名归组为 tab
// 无 "|" 的常规块照常渲染（向后兼容）。
//
// 实现走 token 级（lexer 输出平铺 token 流）：扫描「组头 + 连续 code」，
// 替换为携带最终 HTML 的 html token（Parser 对 html token 原样透传），
// 其余 token 交 Parser 正常渲染。

import { Marked, type Token, type Tokens } from 'marked'

// ---- 基础设施 ---------------------------------------------------------------

const marked = new Marked({ gfm: true, breaks: false })

function renderInline(text: string): string {
  return marked.parseInline(text, { async: false }) as string
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // 引号在 <pre><code> 文本节点里无危险，不转义以保持源码原样
}

/** 语言标签显示名（大写惯例）：常用别名归一。 */
const LANG_LABEL: Record<string, string> = {
  js: 'JS', javascript: 'JS', ts: 'TS', typescript: 'TS',
  py: 'PY', python: 'PY', java: 'JAVA', go: 'GO', rs: 'RS', rust: 'RS',
  c: 'C', cpp: 'C++', 'c++': 'C++', cs: 'C#', csharp: 'C#',
  sh: 'SH', bash: 'BASH', zsh: 'SH', json: 'JSON',
  yaml: 'YAML', yml: 'YAML', md: 'MD', html: 'HTML', css: 'CSS',
  sql: 'SQL', proto: 'PROTO',
}

function langLabel(raw: string): string {
  const k = raw.trim().toLowerCase()
  return LANG_LABEL[k] ?? raw.trim().toUpperCase()
}

/** 单个普通代码块：等宽字体 + 右上角语言标签，不做语法高亮（v1 取舍）。 */
function renderCodeBlock(text: string, lang: string): string {
  const label = lang ? `<span class="code-lang" data-lang="${langLabel(lang)}"></span>` : ''
  return `<div class="codeblock">${label}<pre><code>${escapeHtml(text)}</code></pre></div>`
}

// ---- tab 组扫描（token 流级） ----------------------------------------------

/** 一个 tab 面板：语言名 + 源码。 */
interface TabPanel {
  lang: string
  text: string
}

/** 携带预渲染 HTML 的伪 html token（Parser 对 html token 原样透传）。 */
interface TabGroupToken extends Tokens.HTML {
  _ombTabGroup: true
}

function htmlToken(text: string): TabGroupToken {
  return { type: 'html', raw: '', pre: false, block: true, text, _ombTabGroup: true }
}

/** 顶层 fence 的缩进列数（v18 token 无 indent 字段，从 raw 首行前导空格推导）。 */
function indentOf(t: Tokens.Code): number {
  return /^[ ]*/.exec(t.raw)?.[0].length ?? 0
}

/**
 * 扫描 token 流，把「info 含 | 的组头 code + 后续连续 code」折叠为 tab 组。
 * 连续性中断条件：非 code token、缩进不同、info 为空或含 |（新组头）。
 */
function foldTabGroups(tokens: Token[]): void {
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (t?.type !== 'code') { i++; continue }
    const head = t as Tokens.Code
    if (!(head.lang ?? '').includes('|')) {
      // 常规顶层代码块：统一改用 renderCodeBlock（包装 + 语言标签）
      tokens[i] = htmlToken(renderCodeBlock(head.text, (head.lang ?? '').trim()))
      i++
      continue
    }

    // 组头成立：吞并后续连续 code block
    let j = i + 1
    const panels: TabPanel[] = []
    const headIndent = indentOf(head)
    while (j < tokens.length) {
      const nt = tokens[j]
      if (!nt || nt.type !== 'code') break
      const nc = nt as Tokens.Code
      const lang = (nc.lang || '').trim()
      if (!lang || indentOf(nc) !== headIndent || lang.includes('|')) break
      panels.push({ lang, text: nc.text })
      j++
    }
    // 孤儿组头（无后续连续块）：按普通块渲染，info 去掉 | 部分
    if (panels.length === 0) {
      tokens[i] = htmlToken(renderCodeBlock(head.text, (head.lang ?? '').split('|', 1)[0]!.trim()))
      i++
      continue
    }

    const group = htmlToken(renderTabGroup(head, panels))
    tokens.splice(i, j - i, group)
    i++
  }
}

// ---- HTML 拼装 ---------------------------------------------------------------

/** tab 组：占位说明 + 暗底描边 tab 条 + 面板；激活 tab 荧光描边（唯一强调）。 */
function renderTabGroup(head: Tokens.Code, panels: TabPanel[]): string {
  const tabs = panels
    .map((p, idx) => {
      const active = idx === 0
      return `<button type="button" class="code-tab${active ? ' active' : ''}" role="tab"`
        + ` aria-selected="${active}" data-tab="${idx}">${escapeHtml(langLabel(p.lang))}</button>`
    })
    .join('')
  const body = panels
    .map((p, idx) => {
      const active = idx === 0 ? ' active' : ''
      return `<div class="code-panel${active}" role="tabpanel" data-panel="${idx}">`
        + `<pre><code>${escapeHtml(p.text)}</code></pre></div>`
    })
    .join('')
  const note = head.text.trim()
    ? `<div class="code-group-note">${renderInline(head.text.trim())}</div>`
    : ''
  return `<div class="code-tab-group">${note}`
    + `<div class="code-tab-bar" role="tablist">${tabs}</div>${body}</div>`
}

// ---- 对外 API ---------------------------------------------------------------

/** 渲染完整 markdown 文档（已剥离 frontmatter）为 HTML 字符串。 */
export function renderMarkdown(src: string): string {
  // v18：静态 lex/parse 在 Marked 类上不可用，走实例携带的 Lexer/Parser
  const tokens = marked.Lexer.lex(src, { gfm: true })
  foldTabGroups(tokens)
  return marked.Parser.parse(tokens, { gfm: true }) as string
}

/** tab 点击切换（容器级事件委托，渲染容器绑定一次）。 */
export function bindTabInteractions(root: HTMLElement): void {
  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.code-tab')
    if (!btn) return
    const group = btn.closest<HTMLElement>('.code-tab-group')
    if (!group) return
    const idx = btn.dataset.tab
    group.querySelectorAll<HTMLElement>('.code-tab').forEach((t) => {
      const on = t.dataset.tab === idx
      t.classList.toggle('active', on)
      t.setAttribute('aria-selected', String(on))
    })
    group.querySelectorAll<HTMLElement>('.code-panel').forEach((p) => {
      p.classList.toggle('active', p.dataset.panel === idx)
    })
  })
}
