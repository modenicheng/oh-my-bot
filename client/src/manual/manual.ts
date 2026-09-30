import { writeRoute, readRoute } from '../route'
import { icon } from '../icons'
// 手册阅读器视图：目录侧栏（两级）+ 面包屑 + markdown 正文。
//
// 数据源：GET /api/manual（目录树）+ GET /api/manual/<path>（原始 markdown）。
// 目录请求失败时回退内置离线示例，并在状态行标明数据来源。
// frontmatter：docs/manual 下的 Markdown 带 YAML frontmatter（title/audience），渲染前
// 剥离，title 显示为页标题，audience 显示为面包屑尾部的小标签。

import { renderMarkdown, bindTabInteractions } from './render'

// ---- API 契约（与主线服务器侧对齐） -----------------------------------------

export interface ManualNode {
  /** 相对 docs/manual/ 的路径，如 "index.md"、"reference/actions.md"。 */
  path: string
  /** 目录显示名；服务端使用文件名，页面标题另从 frontmatter 读取。 */
  title: string
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
  { path: 'index.md', title: 'oh-my-bot 玩家手册', children: [] },
  {
    path: 'start',
    title: 'start',
    children: [
      { path: 'start/prepare.md', title: '进房前准备', children: [] },
      { path: 'start/first-match.md', title: '你的第一局', children: [] },
      { path: 'start/snippet.md', title: 'Snippet 驾驶辅助（规划）', children: [] },
      { path: 'start/ai-agent.md', title: 'AI Agent（接入状态与规划）', children: [] },
    ],
  },
  {
    path: 'rules',
    title: 'rules',
    children: [
      { path: 'rules/game-rules.md', title: '游戏规则', children: [] },
      { path: 'rules/controls.md', title: '操作与控制仲裁', children: [] },
    ],
  },
  {
    path: 'code',
    title: 'code',
    children: [{ path: 'code/bot-scripting.md', title: '写第一个 Bot', children: [] }],
  },
  {
    path: 'reference',
    title: 'reference',
    children: [
      { path: 'reference/index.md', title: 'API 总览', children: [] },
      { path: 'reference/actions.md', title: '动作参考（L0 原语）', children: [] },
      { path: 'reference/helpers.md', title: '便利层参考（L1）', children: [] },
      { path: 'reference/data.md', title: '数据结构参考', children: [] },
      { path: 'reference/modules.md', title: '模块语义与陷阱', children: [] },
    ],
  },
]

const MOCK_DOCS: Record<string, string> = {
  'reference/actions.md': [
    '---\ntitle: 动作参考（L0 原语）\naudience: coder\n---\n\n# 动作参考（L0 原语）\n\nmock 回退示例页：多语言 tab 组渲染。\n\n```ts|py|java\n三个语言实现如下。\n```\n\n```ts\nconst bot = {\n  tick(ctx) {\n    const core = ctx.api.nearestCore()\n    if (core) ctx.api.moveTo(core)\n  },\n}\nexport default bot\n```\n\n```py\ndef tick(ctx):\n    core = ctx.api.nearest_core()\n    if core:\n        ctx.api.move_to(core)\n```\n\n```java\nvoid tick(Context ctx) {\n    Vec2 core = ctx.api.nearestCore();\n    if (core != null) ctx.api.moveTo(core);\n}\n```\n\n普通代码块（无 tab）：\n\n```ts\nconst x: number = 1\n```\n',
  ].join(''),
}

// ---- frontmatter -----------------------------------------------------------

export interface Frontmatter {
  title?: string
  audience?: string
}

/** 剥离 YAML frontmatter，返回正文与元数据（仅顶层平铺 key: value）。 */
function splitFrontmatter(src: string): { body: string; fm: Frontmatter } {
  if (!src.startsWith('---')) return { body: src, fm: {} }
  const end = src.indexOf('\n---', 3)
  if (end < 0) return { body: src, fm: {} }
  const block = src.slice(3, end)
  // 结束符必须独占一行（避免误吞正文里的 --- 分隔线）
  const rest = src.slice(end + 4)
  if (rest.startsWith('\n') || rest.startsWith('\r\n') || rest === '') {
    const fm: Frontmatter = {}
    for (const line of block.split(/\r?\n/)) {
      const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
      if (m && m[1] === 'title') fm.title = m[2]!.trim()
      if (m && m[1] === 'audience') fm.audience = m[2]!.trim()
    }
    return { body: rest.replace(/^\r?\n/, ''), fm }
  }
  return { body: src, fm: {} }
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
      // 契约：根可能是 {path,title,children} 单节点，也可能是数组——两种都收
      this.tree = Array.isArray(root) ? root : [root]
      normalizeTree(this.tree)
      this.usingMock = false
    } catch {
      // 目录不可用时显示离线示例，并明确标注，避免误认为服务端内容。
      this.tree = MOCK_TREE
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
    bodyEl.innerHTML = renderMarkdown(body)
    const leadingHeading = bodyEl.firstElementChild?.tagName === 'H1' ? bodyEl.firstElementChild : null
    const title = fm.title ?? leadingHeading?.textContent ?? entry?.node.title ?? path
    leadingHeading?.remove()
    const audience = fm.audience ? AUDIENCE_LABEL[fm.audience] ?? fm.audience : null

    const doc = document.createElement('article')
    doc.className = 'manual-doc'
    const h = document.createElement('h1')
    h.textContent = title
    doc.appendChild(h)
    if (audience) {
      const tag = document.createElement('span')
      tag.className = 'manual-audience'
      tag.textContent = audience
      h.appendChild(document.createTextNode(' '))
      h.appendChild(tag)
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

function normalizeTree(nodes: ManualNode[]): void {
  for (const n of nodes) {
    if (!n.children) n.children = []
    normalizeTree(n.children)
  }
}
