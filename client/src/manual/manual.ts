import { writeRoute, readRoute } from '../route'
import { icon } from '../icons'
// 手册阅读器视图：目录侧栏（两级）+ 面包屑 + markdown 正文。
//
// 数据源：GET /api/manual（目录树）+ GET /api/manual/<path>（原始 markdown）。
// 目录请求失败时回退内置离线示例，并在状态行标明数据来源。
// frontmatter：docs/manual 下的 Markdown 带 YAML frontmatter（title/audience/
// tag/tags/order），渲染前剥离；title 覆盖文件名为页标题，audience/tag 显示为
// 页标题旁的小标签，order 仅供服务端目录排序（客户端信服务端顺序）。

import { renderMarkdown, bindTabInteractions } from './render'
import { normalizeManualTree } from './manual-order'

// ---- API 契约（与主线服务器侧对齐） -----------------------------------------

export interface ManualNode {
  /** 相对 docs/manual/ 的路径，如 "index.md"、"reference/actions.md"。 */
  path: string
  /** 目录显示名；优先来自 frontmatter title，否则文件名。 */
  title: string
  /** frontmatter tags（含标量 tag），仅服务端排序/展示用，可缺省。 */
  tags?: string[]
  /** frontmatter order，缺省时排在有序章节之后。 */
  order?: number
  children: ManualNode[]
}

const MANUAL_API = '/api/manual'

async function fetchTree(): Promise<ManualNode[]> {
  const res = await fetch(`${MANUAL_API}`)
  if (!res.ok) throw new Error(`manual tree ${res.status}`)
  return (await res.json()) as ManualNode[]
}

async function fetchDoc(path: string): Promise<string> {
  const res = await fetch(`${MANUAL_API}/${path}`)
  if (!res.ok) throw new Error(`manual doc ${res.status}`)
  return res.text()
}

// ---- 离线示例回退 -----------------------------------------------------------

const MOCK_TREE: ManualNode[] = [
  { path: 'index.md', title: 'oh-my-bot 玩家手册', order: 0, children: [] },
  {
    path: 'start',
    title: '快速上手',
    order: 1,
    children: [
      { path: 'start/index.md', title: '快速上手', order: 1, children: [] },
      { path: 'start/prepare.md', title: '进房前准备', order: 11, children: [] },
      { path: 'start/first-match.md', title: '你的第一局', order: 12, children: [] },
      { path: 'start/snippet.md', title: 'Snippet 驾驶辅助', order: 13, children: [] },
      { path: 'start/ai-agent.md', title: 'AI Agent', order: 14, children: [] },
    ],
  },
  {
    path: 'rules',
    title: '游戏规则',
    order: 2,
    children: [
      { path: 'rules/index.md', title: '游戏规则', order: 2, children: [] },
      { path: 'rules/game-rules.md', title: '游戏规则', order: 21, children: [] },
      { path: 'rules/controls.md', title: '操作与控制仲裁', order: 22, children: [] },
    ],
  },
  {
    path: 'code',
    title: '写自己的 Bot',
    order: 3,
    children: [
      { path: 'code/index.md', title: '写自己的 Bot', order: 3, children: [] },
      { path: 'code/bot-scripting.md', title: '写第一个 Bot', order: 31, children: [] },
    ],
  },
  {
    path: 'reference',
    title: 'API 参考',
    order: 4,
    children: [
      { path: 'reference/index.md', title: 'API 总览', order: 4, children: [] },
      { path: 'reference/actions.md', title: '动作参考（L0 原语）', order: 41, children: [] },
      { path: 'reference/helpers.md', title: '便利层参考（L1）', order: 42, children: [] },
      { path: 'reference/data.md', title: '数据结构参考', order: 43, children: [] },
      { path: 'reference/modules.md', title: '模块语义与陷阱', order: 44, children: [] },
    ],
  },
]

export const MOCK_DOCS: Record<string, string> = {
  'reference/actions.md': [
    '---\ntitle: 动作参考（L0 原语）\naudience: coder\n---\n\n# 动作参考（L0 原语）\n\nmock 回退示例页：多语言 tab 组渲染。\n\n```ts|py|java\n三个语言实现如下。\n```\n\n```ts\nconst bot = {\n  tick(bot) {\n    const enemy = bot.scan().robots[0]\n    if (enemy) bot.aimAt(enemy)\n    const core = bot.nearestCore()\n    if (core) bot.navigateTo(core)\n    console.log(bot.self.position)\n  },\n}\nexport default bot\n```\n\n```py\ndef tick(bot):\n    robots = bot.scan().robots\n    if robots:\n        bot.aimAt(robots[0])\n    print(bot.self.position)\n```\n\n```java\nvoid tick(BotContext bot) {\n    RobotRef enemy = bot.scan().robots().stream().findFirst().orElse(null);\n    if (enemy != null) bot.aimAt(enemy);\n    System.out.println(bot.self.position);\n}\n```\n\n普通代码块（无 tab）：\n\n```ts\nconst x: number = 1\n```\n',
  ].join(''),
}

// ---- frontmatter -----------------------------------------------------------

export interface Frontmatter {
  title?: string
  audience?: string
  /** 标签（tag 标量与 tags 数组合并去重后的结果）。 */
  tags?: string[]
  /** 目录排序权重；仅有限数值有效，非法值不产生该键。 */
  order?: number
}

/** 剥离 YAML frontmatter，返回正文与元数据（仅顶层平铺 key: value）。 */
export function splitFrontmatter(src: string): { body: string; fm: Frontmatter } {
  if (!src.startsWith('---')) return { body: src, fm: {} }
  const end = src.indexOf('\n---', 3)
  if (end < 0) return { body: src, fm: {} }
  const block = src.slice(3, end)
  // 结束符必须独占一行（避免误吞正文里的 --- 分隔线）
  const rest = src.slice(end + 4)
  if (rest.startsWith('\n') || rest.startsWith('\r\n') || rest === '') {
    const fm = parseFrontmatterBlock(block)
    return { body: rest.replace(/^\r?\n/, ''), fm }
  }
  return { body: src, fm: {} }
}

/**
 * 解析 frontmatter 块（不含首尾 `---`）为平铺键值。
 *
 * 与服务端 manual_index.go 保持同一套语义：
 * - 仅顶层 `key: value`；未知键忽略；重复键后者覆盖前者。
 * - 值支持单/双引号（含中文、逗号、冒号），双引号内 `\\"` 转义，单引号内 `''` 转义。
 * - `tags` 支持行内数组与破折号列表两式；标量 `tag` 是单标签。
 * - `order` 仅接受有限十进制数（含 0/负数）；非法值忽略。
 */
export function parseFrontmatterBlock(block: string): Frontmatter {
  const fm: Frontmatter = {}
  const lines = block.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i]!)
    if (!m) continue
    const key = m[1]!
    const inline = m[2]!.trim()
    if (inline === '') {
      // 破折号列表（仅 tags）：后续缩进的 `- 项` 行。每项是一个完整标量，
      // 不再做逗号拆分（含逗号的引号值保持为一个标签）。
      const items: string[] = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const lm = /^[ \t]+-[ \t]*(.*)$/.exec(lines[j]!)
        if (!lm) break
        items.push(unquoteScalar(lm[1]!.trim()))
      }
      if (items.length > 0) i = j - 1
      if (key === 'tags') fm.tags = mergeTags(fm.tags, items.filter((t) => t !== ''))
      continue
    }
    if (inline === '|' || inline === '>') continue // 块标量不用于导航元数据
    const value = unquoteScalar(inline)
    if (key === 'title') fm.title = value
    else if (key === 'audience') fm.audience = value
    else if (key === 'order') {
      const n = Number(value)
      if (value !== '' && Number.isFinite(n)) fm.order = n
    } else if (key === 'tag' || key === 'tags') {
      fm.tags = mergeTags(fm.tags, splitTagList(inline))
    }
  }
  return fm
}

/** 去除引号并还原转义；无引号时去掉行内 ` #` 之后的内容。 */
function unquoteScalar(s: string): string {
  if (s.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"(?:[ \t]+#.*)?$/.exec(s)
    if (!m) return s
    return m[1]!.replace(/\\(.)/g, '$1')
  }
  if (s.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'(?:[ \t]+#.*)?$/.exec(s)
    if (!m) return s
    return m[1]!.replace(/''/g, "'")
  }
  const hash = s.indexOf(' #')
  return (hash >= 0 ? s.slice(0, hash) : s).trim()
}

/**
 * 逗号分隔 → 标签数组；引号包裹的含逗号值保持为一个标签。
 * 入参是原始行内值（未去引号），先按引号感知切分再去引号。
 */
function splitTagList(s: string): string[] {
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ',') {
      if (cur) out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
    .map((t) => unquoteScalar(t.trim()))
    .filter((t) => t !== '' && t !== 'null' && t !== '~')
}

/** 合并去重（保序）。 */
function mergeTags(existing: string[] | undefined, add: string[]): string[] {
  const seen = new Set(existing ?? [])
  const out = [...(existing ?? [])]
  for (const t of add) {
    if (!seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

// ---- 阅读器 ---------------------------------------------------------------

/** audience 值 → 中文受众标签。 */
const AUDIENCE_LABEL: Record<string, string> = {
  human: '手操玩家', coder: '写码玩家', both: '所有人', agent: 'AI Agent',
}

export interface ManualViewOpts {
  /** 手册根容器（侧栏 + 正文已存在于 HTML）。 */
  root: HTMLElement
  /** 面包屑容器。 */
  breadcrumb: HTMLElement
  /** 目录侧栏容器。 */
  sidebar: HTMLElement
  /** 正文容器。 */
  content: HTMLElement
  /** 状态行（加载/错误）。 */
  status: HTMLElement
  /** 返回大厅回调。 */
  onExit: () => void
  /** 嵌入对局侧栏时由宿主管理路由。 */
  onNavigate?: (path: string) => void
}

export class ManualView {
  private readonly opts: ManualViewOpts
  private tree: ManualNode[] = []
  private currentPath = ''
  private navigationVersion = 0
  /** 目录树查找：path → 节点（含父链，用于侧栏高亮与面包屑）。 */
  private nodeIndex = new Map<string, { node: ManualNode; parent: ManualNode | null }>()
  private usingMock = false

  constructor(opts: ManualViewOpts) {
    this.opts = opts
    bindTabInteractions(opts.content)
    opts.root.querySelector('#btn-manual-back')?.addEventListener('click', () => opts.onExit())
  }

  /** 进入手册视图：拉目录树并打开首页（或指定页）。 */
  async open(path = 'index.md'): Promise<void> {
    const version = ++this.navigationVersion
    await this.loadTree()
    if (version === this.navigationVersion && !this.opts.root.hidden) await this.navigate(path)
  }

  close(): void {
    this.navigationVersion++
    this.currentPath = ''
  }

  private async loadTree(): Promise<void> {
    this.opts.status.textContent = '加载目录…'
    try {
      const root = await fetchTree()
      // 契约：根可能是 {path,title,children} 单节点，也可能是数组——两种都收。
      // 服务端已按 order 排序；normalizeManualTree 仅作兑底（补 children + 同规则排序）。
      const list = Array.isArray(root) ? root : [root]
      this.tree = normalizeManualTree(list)
      this.usingMock = false
    } catch {
      // 目录不可用时显示离线示例，并明确标注，避免误认为服务端内容。
      this.tree = normalizeManualTree(MOCK_TREE)
      this.usingMock = true
    }
    this.indexTree()
    this.renderSidebar()
    this.opts.status.textContent = this.usingMock ? '离线示例数据（服务器手册 API 未就绪）' : ''
  }

  /** 拉取并渲染一篇文档。 */
  async navigate(path: string): Promise<void> {
    const base = path.replace(/\.md$/, '')
    const entry = this.nodeIndex.get(base) ?? this.nodeIndex.get(`${base}.md`)
    if (entry?.node.children.length) {
      const indexPath = `${base}/index`
      const first = this.nodeIndex.get(indexPath) ?? this.nodeIndex.get(`${indexPath}.md`)
      return this.navigate(first?.node.path ?? entry.node.children[0]!.path)
    }
    if (!entry && this.tree.length > 0) {
      this.opts.status.textContent = `未找到文档：${path}`
      return
    }
    if (this.opts.root.hidden) return
    const version = ++this.navigationVersion
    path = `${base}.md`
    this.currentPath = path
    this.highlightSidebar(path)
    this.renderBreadcrumb(entry?.node.path ?? path)
    if (this.opts.onNavigate) this.opts.onNavigate(path)
    else writeRoute('manual', readRoute().roomCode, { doc: path })

    this.opts.content.innerHTML = ''
    this.opts.status.textContent = '加载中…'
    let raw: string
    try {
      raw = this.usingMock ? (MOCK_DOCS[path] ?? '') : await fetchDoc(path)
    } catch (err) {
      if (version !== this.navigationVersion) return
      this.opts.status.textContent = `文档加载失败：${err instanceof Error ? err.message : path}`
      return
    }
    if (version !== this.navigationVersion || this.opts.root.hidden) return // 已切走

    const { body, fm } = splitFrontmatter(raw)
    const bodyEl = document.createElement('div')
    bodyEl.className = 'manual-body'
    bodyEl.innerHTML = renderMarkdown(body, path)
    const leadingHeading = bodyEl.firstElementChild?.tagName === 'H1' ? bodyEl.firstElementChild : null
    const title = fm.title ?? leadingHeading?.textContent ?? entry?.node.title ?? path
    leadingHeading?.remove()
    const audience = fm.audience ? AUDIENCE_LABEL[fm.audience] ?? fm.audience : null
    // 页内 frontmatter 标签（tag/tags）优先；否则退回目录树节点的 tags。
    const tags = fm.tags?.length ? fm.tags : entry?.node.tags

    const doc = document.createElement('article')
    doc.className = 'manual-doc'
    const h = document.createElement('h1')
    h.textContent = title
    doc.appendChild(h)
    const chips = document.createElement('span')
    chips.className = 'manual-chips'
    if (audience) {
      const tag = document.createElement('span')
      tag.className = 'manual-audience'
      tag.textContent = audience
      chips.appendChild(tag)
    }
    for (const t of tags ?? []) {
      const tag = document.createElement('span')
      tag.className = 'manual-tag'
      tag.textContent = t
      chips.appendChild(tag)
    }
    if (chips.childElementCount > 0) {
      h.appendChild(document.createTextNode(' '))
      h.appendChild(chips)
    }
    doc.appendChild(bodyEl)

    // 手册内相对链接 → 阅读器内导航
    bodyEl.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
      const href = a.getAttribute('href') ?? ''
      if (/^https?:|^#|^mailto:/.test(href)) return
      a.addEventListener('click', (e) => {
        e.preventDefault()
        const target = new URL(href, `https://manual.local/${path}`)
        void this.navigate(target.pathname.slice(1))
      })
    })

    this.opts.content.replaceChildren(doc)
    this.opts.content.scrollTop = 0
    this.opts.status.textContent = ''
  }

  // ---- 目录树索引与侧栏 ---------------------------------------------------

  private indexTree(): void {
    this.nodeIndex.clear()
    const walk = (nodes: ManualNode[], parent: ManualNode | null): void => {
      for (const n of nodes) {
        this.nodeIndex.set(n.path, { node: n, parent })
        if (n.children.length > 0) walk(n.children, n)
      }
    }
    walk(this.tree, null)
  }

  /** 侧栏两级：顶层章节；带 children 的章节下列子页。 */
  private renderSidebar(): void {
    const el = this.opts.sidebar
    el.innerHTML = ''
    for (const node of this.tree) {
      const item = document.createElement('div')
      item.className = 'toc-section'
      const a = this.tocLink(node.path, node.title)
      item.appendChild(a)
      if (node.children.length > 0) {
        const sub = document.createElement('div')
        sub.className = 'toc-children'
        for (const c of node.children) sub.appendChild(this.tocLink(c.path, c.title))
        item.appendChild(sub)
      }
      el.appendChild(item)
    }
  }

  private tocLink(path: string, title: string): HTMLAnchorElement {
    const a = document.createElement('a')
    a.href = '#'
    a.textContent = title
    a.dataset.path = path
    a.addEventListener('click', (e) => {
      e.preventDefault()
      void this.navigate(path)
    })
    return a
  }

  private highlightSidebar(path: string): void {
    this.opts.sidebar.querySelectorAll<HTMLAnchorElement>('a[data-path]').forEach((a) => {
      a.classList.toggle('active', a.dataset.path?.replace(/\.md$/, '') === path.replace(/\.md$/, ''))
    })
  }

  // ---- 面包屑 -----------------------------------------------------------

  private renderBreadcrumb(path: string): void {
    // 从 nodeIndex 的 parent 链回溯：当前页 → 父章节 → …
    const chain: ManualNode[] = []
    let cur = this.nodeIndex.get(path) ?? null
    while (cur) {
      chain.unshift(cur.node)
      cur = cur.parent ? (this.nodeIndex.get(cur.parent.path) ?? null) : null
    }
    const el = this.opts.breadcrumb
    el.innerHTML = ''
    const sep = () => {
      const s = document.createElement('span')
      s.className = 'crumb-sep'
      s.append(icon('chevron'))
      el.appendChild(s)
    }
    chain.forEach((n, i) => {
      if (i > 0) sep()
      const last = i === chain.length - 1
      if (last) {
        const s = document.createElement('span')
        s.className = 'crumb-current'
        s.textContent = n.title
        el.appendChild(s)
      } else {
        const a = document.createElement('a')
        a.href = '#'
        a.textContent = n.title
        a.addEventListener('click', (e) => {
          e.preventDefault()
          void this.navigate(n.path)
        })
        el.appendChild(a)
      }
    })
  }
}
