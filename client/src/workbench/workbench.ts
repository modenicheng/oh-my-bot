import { create } from '@bufbuild/protobuf'
import { ClientMsgSchema, SnippetConfigSchema, AiPromptSchema, encodeClient,
         type EvScriptLog, type EvScriptResult, type EvSnippetResult, type EvAiQuota, type EvAiUsage, type SnippetSetting } from '@omb/protocol'
import { ManualView } from '../manual/manual'
import { mountIcons } from '../icons'
import type { RouteExtra, WorkbenchPanel } from '../route'
import type { BotEditor } from './editor'
import { DEFAULT_CONSOLE_HEIGHT, ScriptConsoleView } from './script-console'
import { draftKeyFor, isBotLanguage, languagePrefKey, type BotLanguage } from './ts-submit'
import { SnippetPanelView } from './snippet-panel'
import { AiPanelView } from './ai-panel'
import { AI_SCRIPT_RESULT_ID } from './ai-assist'
import './workbench.css'

export const INITIAL_SOURCE_TS = `import type { BotContext } from '@omb/bot-api'

export function tick(bot: BotContext) {
  let target = bot.nearestCore()
  if (bot.self.hp <= 45) {
    let nearest = Infinity
    for (const pack of bot.scan().healthPacks) {
      if (!pack.available) continue
      const distance = Math.hypot(pack.x - bot.self.position.x, pack.y - bot.self.position.y)
      if (distance < nearest) { nearest = distance; target = pack }
    }
  }
  if (target) bot.navigateTo(target)
}
`
export const INITIAL_SOURCE = `/** @param {import('@omb/bot-api').BotContext} bot */
function tick(bot) {
  let target = bot.nearestCore()
  if (bot.self.hp <= 45) {
    let nearest = Infinity
    for (const pack of bot.scan().healthPacks) {
      if (!pack.available) continue
      const distance = Math.hypot(pack.x - bot.self.position.x, pack.y - bot.self.position.y)
      if (distance < nearest) { nearest = distance; target = pack }
    }
  }
  if (target) bot.navigateTo(target)
}
`

const LAYOUT_KEY = 'omb.workbench.layout'
const MIN_WIDTH = 320
const MIN_BATTLEFIELD_WIDTH = 360
const MIN_RATIO = 25
const MAX_RATIO = 75

interface WorkbenchDeps {
  root: HTMLElement
  gameView: HTMLElement
  docsButton: HTMLButtonElement
  editorButton: HTMLButtonElement
  initial: RouteExtra
  onLayout: () => void
  send: (frame: Uint8Array) => boolean
  toggleAssist: () => void
}

/** 文档与编辑器共享一列；提交状态只接受当前连接、当前对局的匹配回执。 */
export class Workbench {
  private readonly panels = new Set<WorkbenchPanel>()
  private readonly manual: ManualView
  private editor?: BotEditor
  private loadingEditor = false
  private docPath: string
  private draftKey = ''
  private source = INITIAL_SOURCE
  private language: BotLanguage = 'js'
  private prefKey = ''
  private online = false
  private inMatch = false
  private assistOn = false
  private identity = { roomCode: '', nick: '' }
  private nextScriptId = 0
  private compiling = false
  private pending?: { id: number; source: string; timer: ReturnType<typeof setTimeout> }
  private loaded?: { source: string; revision: number }
  private readonly docsPane: HTMLElement
  private readonly editorPane: HTMLElement
  private readonly resizeHandle: HTMLElement
  private readonly splitHandle: HTMLElement
  private width = Math.min(600, Math.max(400, window.innerWidth * .36))
  private ratio = 50
  private consoleOpen = true
  private consoleHeight = DEFAULT_CONSOLE_HEIGHT
  private stopResizing?: () => void
  private readonly submitButton: HTMLButtonElement
  private readonly assistButton: HTMLButtonElement
  private readonly draftStatus: HTMLElement
  private readonly languageButtons: HTMLButtonElement[]
  private readonly scriptConsole: ScriptConsoleView
  private readonly snippetPanel: SnippetPanelView
  private readonly aiPanel: AiPanelView
  private snippetPane!: HTMLElement
  private aiPane!: HTMLElement

  constructor(private readonly deps: WorkbenchDeps) {
    this.docPath = deps.initial.doc ?? 'index.md'
    for (const panel of deps.initial.panels ?? []) this.panels.add(panel)
    try {
      const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null')
      if (typeof saved?.width === 'number' && Number.isFinite(saved.width)) this.width = saved.width
      if (typeof saved?.ratio === 'number' && Number.isFinite(saved.ratio)) this.ratio = saved.ratio
      if (typeof saved?.consoleOpen === 'boolean') this.consoleOpen = saved.consoleOpen
      if (typeof saved?.consoleHeight === 'number' && Number.isFinite(saved.consoleHeight)) this.consoleHeight = saved.consoleHeight
    } catch { /* 存储不可用时仍可调整布局。 */ }
    deps.root.tabIndex = -1
    deps.root.innerHTML = `
      <div id="workbench-resize" class="workbench-resize" role="separator" tabindex="0" aria-label="侧栏宽度" aria-orientation="vertical" aria-controls="workbench"></div>
      <nav class="workbench-tools" aria-label="侧栏窗口">
        <button type="button" data-panel="docs" aria-controls="workbench-docs"><span data-icon="book"></span>文档</button>
        <button type="button" data-panel="editor" aria-controls="workbench-editor"><span data-icon="code"></span>编辑器</button>
        <button type="button" data-panel="snippets" aria-controls="workbench-snippets" title="Snippet 驾驶辅助开关面板；战场画布获焦时 Space 或小键盘 Enter 切换辅助总开关"><span data-icon="target"></span>辅助</button>
        <button type="button" data-panel="ai" aria-controls="workbench-ai" title="AI 助手：自然语言修改脚本；配额内自动热更"><span data-icon="energy"></span>AI</button>
        <button type="button" id="workbench-close"><span data-icon="back"></span>返回战场</button>
      </nav>
      <section id="workbench-docs" class="workbench-pane" tabindex="-1" aria-label="文档">
        <header class="workbench-heading">
          <h2>玩家手册</h2>
          <button type="button" id="workbench-toc-toggle" aria-expanded="false" aria-controls="workbench-toc">目录</button>
          <button type="button" data-panel="docs" aria-label="收起文档"><span data-icon="collapse"></span></button>
        </header>
        <nav id="workbench-toc" aria-label="侧栏手册目录" hidden></nav>
        <div id="workbench-breadcrumb" class="workbench-breadcrumb"></div>
        <div id="workbench-doc-status" class="workbench-status" role="status"></div>
        <div id="workbench-doc-content" tabindex="0" aria-label="手册正文"></div>
      </section>
      <div id="workbench-split" class="workbench-resize" role="separator" tabindex="0" aria-label="文档与编辑器高度" aria-orientation="horizontal" aria-controls="workbench-docs workbench-editor"></div>
      <section id="workbench-editor" class="workbench-pane" tabindex="-1" aria-label="脚本编辑器">
        <header class="workbench-heading workbench-editor-heading">
          <h2>bot.<span id="workbench-lang-ext">js</span> <span id="workbench-lang-name">JavaScript</span></h2>
          <span id="workbench-draft" role="status">本地草稿</span>
          <div class="workbench-editor-controls">
            <span id="workbench-lang-switch" class="workbench-lang-switch" role="group" aria-label="脚本语言">
              <button type="button" data-lang="js" aria-pressed="true" title="编辑 JavaScript，按原样提交">JS</button>
              <button type="button" data-lang="ts" aria-pressed="false" title="编辑 TypeScript，提交前在浏览器内编译为 JavaScript">TS</button>
            </span>
            <button type="button" id="workbench-submit" class="primary" disabled title="提交当前草稿（Ctrl / ⌘ + Enter）"><span data-icon="play"></span>提交</button>
            <button type="button" id="workbench-assist" aria-pressed="false" disabled aria-keyshortcuts="Space">辅助 OFF</button>
            <button type="button" id="workbench-console-toggle" aria-expanded="true" aria-controls="workbench-console">Console <span data-console-trigger-count>0</span></button>
          </div>
          <button type="button" data-panel="editor" aria-label="收起编辑器"><span data-icon="collapse"></span></button>
        </header>
        <div class="workbench-editor-area">
          <div id="workbench-code"></div>
          <div id="workbench-editor-loading" role="status">正在加载编辑器…</div>
        </div>
        <div class="workbench-editor-meta"><span id="workbench-diagnostics" role="status">JavaScript · Bot API 补全</span><span>Ctrl / ⌘ + Enter 提交</span></div>
        <section id="workbench-console" class="script-console" aria-label="脚本 Console"></section>
      </section>
      <section id="workbench-snippets" class="workbench-pane workbench-tool-pane" tabindex="-1" aria-label="Snippet 驾驶辅助"></section>
      <section id="workbench-ai" class="workbench-pane workbench-tool-pane" tabindex="-1" aria-label="AI 助手"></section>`
    mountIcons(deps.root)
    this.docsPane = this.el('workbench-docs')
    this.editorPane = this.el('workbench-editor')
    this.resizeHandle = this.el('workbench-resize')
    this.splitHandle = this.el('workbench-split')
    this.submitButton = this.el('workbench-submit')
    this.assistButton = this.el('workbench-assist')
    this.draftStatus = this.el('workbench-draft')
    this.languageButtons = Array.from(this.deps.root.querySelectorAll<HTMLButtonElement>('#workbench-lang-switch [data-lang]'))
    this.scriptConsole = new ScriptConsoleView(this.el('workbench-console'), {
      trigger: this.el('workbench-console-toggle'),
      open: this.consoleOpen,
      height: this.consoleHeight,
      onOpenChange: open => {
        this.consoleOpen = open
        this.saveLayout()
      },
      onHeightChange: height => {
        this.consoleHeight = height
        this.saveLayout()
      },
    })
    this.snippetPane = this.el('workbench-snippets')
    this.aiPane = this.el('workbench-ai')
    this.snippetPanel = new SnippetPanelView({
      root: this.snippetPane,
      send: settings => this.sendSnippetConfig(settings),
      availability: () => ({ online: this.online, inMatch: this.inMatch }),
    })
    this.aiPanel = new AiPanelView({
      root: this.aiPane,
      send: text => this.sendAiPrompt(text),
      availability: () => ({ online: this.online, inMatch: this.inMatch }),
      editorDirty: () => !this.loaded || this.loaded.source !== this.source,
    })
    for (const button of this.languageButtons) {
      button.addEventListener('click', () => this.setLanguage((button.dataset.lang as BotLanguage) === 'ts' ? 'ts' : 'js'))
    }
    this.manual = new ManualView({
      root: this.docsPane,
      breadcrumb: this.el('workbench-breadcrumb'),
      sidebar: this.el('workbench-toc'),
      content: this.el('workbench-doc-content'),
      status: this.el('workbench-doc-status'),
      onExit: () => this.toggle('docs'),
      onNavigate: path => {
        this.docPath = path
        const toc = this.el('workbench-toc')
        if (toc.contains(document.activeElement)) this.focusPanel('docs')
        toc.hidden = true
        this.el('workbench-toc-toggle').setAttribute('aria-expanded', 'false')
        deps.onLayout()
      },
    })
    deps.root.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach(button => {
      button.addEventListener('click', () => this.toggle(button.dataset.panel as WorkbenchPanel))
    })
    deps.docsButton.addEventListener('click', () => this.toggle('docs'))
    deps.editorButton.addEventListener('click', () => this.toggle('editor'))
    this.el('workbench-close').addEventListener('click', () => this.close())
    this.el('workbench-toc-toggle').addEventListener('click', () => {
      const toc = this.el('workbench-toc')
      toc.hidden = !toc.hidden
      this.el('workbench-toc-toggle').setAttribute('aria-expanded', String(!toc.hidden))
    })
    this.submitButton.addEventListener('click', () => this.submit())
    this.assistButton.addEventListener('click', () => deps.toggleAssist())
    deps.root.addEventListener('pointerdown', event => {
      const target = event.target
      if (event.button !== 0 || !(target instanceof Element)) return
      if (target.closest('.monaco-editor, button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])')) return
      const pane = target.closest<HTMLElement>('.workbench-pane') ?? deps.root
      pane.focus({ preventScroll: true })
    })
    this.bindResize(this.resizeHandle, 'width')
    this.bindResize(this.splitHandle, 'split')
    window.addEventListener('resize', () => {
      this.stopResizing?.()
      this.renderSizes()
      this.scriptConsole.refreshLayout()
    })
    window.addEventListener('blur', () => this.stopResizing?.())
    // 初始化仅设置布局；宿主完成构造后再打开异步视图。
    this.renderLayout()
    this.saveLayout()
  }

  private el<T extends HTMLElement>(id: string): T {
    return this.deps.root.querySelector<T>(`#${id}`)!
  }

  get isOpen(): boolean { return this.panels.size > 0 }

  get route(): RouteExtra { return { panels: [...this.panels], doc: this.docPath } }

  activate(): void {
    this.renderSizes()
    if (this.isOpen && window.matchMedia('(max-width: 760px)').matches) this.focusPanel(this.primaryPanel())
    if (this.panels.has('docs')) void this.manual.open(this.docPath)
    if (this.panels.has('editor')) void this.ensureEditor()
    if (this.panels.has('snippets') || this.panels.has('ai')) this.renderToolPanels()
  }

  toggle(panel: WorkbenchPanel): void {
    const pane = this.paneOf(panel)
    const needsFocus = pane.contains(document.activeElement) || document.activeElement === this.splitHandle
    if (this.panels.has(panel)) {
      this.panels.delete(panel)
      if (panel === 'docs') this.manual.close()
    } else if (panel === 'snippets' || panel === 'ai') {
      if (this.panels.has('docs')) this.manual.close()
      this.panels.clear()
      this.panels.add(panel)
    } else {
      this.panels.delete('snippets')
      this.panels.delete('ai')
      this.panels.add(panel)
    }
    this.renderLayout()
    this.deps.onLayout()
    if (this.panels.has(panel)) {
      this.focusPanel(panel)
      if (panel === 'docs') void this.manual.open(this.docPath)
      else if (panel === 'editor') void this.ensureEditor()
    } else if (!this.isOpen) {
      this.focusCanvas()
    } else if (needsFocus) {
      this.focusPanel(this.primaryPanel())
    }
  }

  /** 当前可见面板的首选回焦目标（关闭焦点所在面板后）。 */
  private primaryPanel(): WorkbenchPanel {
    if (this.panels.has('docs')) return 'docs'
    if (this.panels.has('editor')) return 'editor'
    if (this.panels.has('snippets')) return 'snippets'
    if (this.panels.has('ai')) return 'ai'
    return 'docs'
  }

  private paneOf(panel: WorkbenchPanel): HTMLElement {
    if (panel === 'docs') return this.docsPane
    if (panel === 'editor') return this.editorPane
    if (panel === 'snippets') return this.snippetPane
    return this.aiPane
  }

  close(): void {
    this.panels.clear()
    this.manual.close()
    this.renderLayout()
    this.deps.onLayout()
    this.focusCanvas()
  }

  private focusCanvas(): void {
    this.deps.gameView.querySelector<HTMLCanvasElement>('canvas')?.focus({ preventScroll: true })
  }

  private focusPanel(panel: WorkbenchPanel): void {
    const target = panel === 'docs' ? this.el('workbench-doc-content') : this.paneOf(panel)
    if (!target.getClientRects().length) return
    target.focus({ preventScroll: true })
    if (panel === 'editor') this.editor?.focus()
    else if (panel === 'snippets') this.snippetPanel.focus()
    else if (panel === 'ai') this.aiPanel.focus()
  }

  private renderLayout(): void {
    this.stopResizing?.()
    this.deps.root.hidden = !this.isOpen
    this.deps.gameView.classList.toggle('has-workbench', this.isOpen)
    this.docsPane.hidden = !this.panels.has('docs')
    this.editorPane.hidden = !this.panels.has('editor')
    this.snippetPane.hidden = !this.panels.has('snippets')
    this.aiPane.hidden = !this.panels.has('ai')
    // 上下分幅仅对「文档 + 编辑器」同开有意义；工具面板整列展示。
    const splitRelevant = this.panels.size === 2 && this.panels.has('docs') && this.panels.has('editor')
    this.splitHandle.hidden = !splitRelevant
    if (this.panels.has('snippets') || this.panels.has('ai')) {
      // 辅助/AI 占整列时隐藏文档与编辑器，避免四层堆叠挤压。
      this.docsPane.hidden = true
      this.editorPane.hidden = true
      this.splitHandle.hidden = true
    }
    this.renderSizes()
    for (const [button, panel] of [[this.deps.docsButton, 'docs'], [this.deps.editorButton, 'editor']] as const) {
      button.setAttribute('aria-expanded', String(this.panels.has(panel)))
    }
    this.deps.root.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach(button => {
      button.setAttribute('aria-expanded', String(this.panels.has(button.dataset.panel as WorkbenchPanel)))
    })
  }

  private maxWidth(): number {
    return Math.max(MIN_WIDTH, (this.deps.gameView.clientWidth || document.documentElement.clientWidth) - MIN_BATTLEFIELD_WIDTH)
  }

  private renderSizes(): void {
    const maxWidth = this.maxWidth()
    this.width = Math.max(MIN_WIDTH, Math.round(this.width))
    const effectiveWidth = Math.min(maxWidth, this.width)
    this.ratio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, Math.round(this.ratio)))
    this.deps.gameView.style.setProperty('--workbench-width', `${effectiveWidth}px`)
    this.docsPane.style.flexGrow = String(this.ratio)
    this.editorPane.style.flexGrow = String(100 - this.ratio)
    this.scriptConsole.refreshLayout()
    this.resizeHandle.setAttribute('aria-valuemin', String(MIN_WIDTH))
    this.resizeHandle.setAttribute('aria-valuemax', String(maxWidth))
    this.resizeHandle.setAttribute('aria-valuenow', String(effectiveWidth))
    this.resizeHandle.setAttribute('aria-valuetext', `${effectiveWidth} 像素`)
    this.splitHandle.setAttribute('aria-valuemin', String(MIN_RATIO))
    this.splitHandle.setAttribute('aria-valuemax', String(MAX_RATIO))
    this.splitHandle.setAttribute('aria-valuenow', String(this.ratio))
    this.splitHandle.setAttribute('aria-valuetext', `文档 ${this.ratio}%，编辑器 ${100 - this.ratio}%`)
    const restoreFocus = document.activeElement === this.resizeHandle
    this.resizeHandle.hidden = window.matchMedia('(max-width: 760px)').matches
    if (restoreFocus && this.resizeHandle.hidden && this.isOpen) this.focusPanel(this.primaryPanel())
  }

  private saveLayout(): void {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({
        width: this.width,
        ratio: this.ratio,
        consoleOpen: this.consoleOpen,
        consoleHeight: this.consoleHeight,
      }))
    } catch { /* 调整仍在当前页面生效。 */ }
  }

  private bindResize(handle: HTMLElement, axis: 'width' | 'split'): void {
    const isWidth = axis === 'width'
    let drag: { pointerId: number; start: number; value: number; span: number } | undefined
    const finish = (event?: PointerEvent) => {
      if (!drag || (event && event.pointerId !== drag.pointerId)) return
      const { pointerId } = drag
      drag = undefined
      this.stopResizing = undefined
      delete document.documentElement.dataset.workbenchResize
      delete handle.dataset.resizing
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      this.saveLayout()
      this.deps.onLayout()
    }
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary || handle.hidden) return
      this.stopResizing?.()
      event.preventDefault()
      handle.focus({ preventScroll: true })
      handle.setPointerCapture(event.pointerId)
      drag = {
        pointerId: event.pointerId,
        start: isWidth ? event.clientX : event.clientY,
        value: isWidth ? Math.min(this.width, this.maxWidth()) : this.ratio,
        span: Math.max(1, this.docsPane.getBoundingClientRect().height + this.editorPane.getBoundingClientRect().height),
      }
      this.stopResizing = finish
      document.documentElement.dataset.workbenchResize = axis
      handle.dataset.resizing = ''
    })
    handle.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return
      event.preventDefault()
      if (isWidth) this.width = Math.max(MIN_WIDTH, Math.min(this.maxWidth(), drag.value - (event.clientX - drag.start)))
      else this.ratio = drag.value + (event.clientY - drag.start) / drag.span * 100
      this.renderSizes()
    })
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', finish)
    handle.addEventListener('lostpointercapture', finish)
    handle.addEventListener('keydown', event => {
      if (handle.hidden || event.altKey || event.ctrlKey || event.metaKey) return
      let value = isWidth ? Math.min(this.width, this.maxWidth()) : this.ratio
      const step = isWidth ? 16 : 5
      if (event.key === 'Home') value = isWidth ? MIN_WIDTH : MIN_RATIO
      else if (event.key === 'End') value = isWidth ? this.maxWidth() : MAX_RATIO
      else if ([isWidth ? 'ArrowLeft' : 'ArrowDown', '+', '='].includes(event.key)) value += step
      else if ([isWidth ? 'ArrowRight' : 'ArrowUp', '-'].includes(event.key)) value -= step
      else return
      event.preventDefault()
      event.stopPropagation()
      this.stopResizing?.()
      if (isWidth) this.width = Math.max(MIN_WIDTH, Math.min(this.maxWidth(), value))
      else this.ratio = value
      this.renderSizes()
      this.saveLayout()
      this.deps.onLayout()
    })
  }

  clearIdentity(): void {
    if (this.draftKey) this.saveLanguagePref()
    this.draftKey = ''
    this.prefKey = ''
    this.identity = { roomCode: '', nick: '' }
    this.snippetPanel.setIdentity('', '')
    this.aiPanel.resetSession('identity')
    this.resetMatch()
  }

  setIdentity(roomCode: string, nick: string): void {
    this.snippetPanel.setIdentity(roomCode, nick)
    if (this.identity.roomCode !== roomCode || this.identity.nick !== nick) {
      this.identity = { roomCode, nick }
      this.aiPanel.resetSession('identity')
    }
    const prefKey = languagePrefKey(roomCode, nick)
    if (this.draftKey) this.saveLanguagePref()
    let language = this.language
    if (this.prefKey !== prefKey) {
      language = this.loadLanguagePref(prefKey)
      this.prefKey = prefKey
    }
    const key = draftKeyFor(roomCode, nick, language)
    if (this.draftKey === key) return
    this.resetMatch()
    this.draftKey = key
    // 编辑器已存在时同步切换模型，避免把 TS 源码写进 JS 模型。
    this.applyLanguage(language, this.editor !== undefined)
    this.source = this.loadDraft() ?? (language === 'ts' ? INITIAL_SOURCE_TS : INITIAL_SOURCE)
    try {
      this.draftStatus.textContent = '本地草稿'
    } catch { this.draftStatus.textContent = '草稿无法保存' }
    this.editor?.setValue(this.source)
  }

  private loadDraft(): string | undefined {
    if (!this.draftKey) return undefined
    try { return localStorage.getItem(this.draftKey) ?? undefined } catch { return undefined }
  }

  private loadLanguagePref(prefKey: string): BotLanguage {
    try {
      const saved = localStorage.getItem(prefKey)
      return isBotLanguage(saved) ? saved : 'js'
    } catch { return 'js' }
  }

  private saveLanguagePref(): void {
    if (!this.prefKey) return
    try { localStorage.setItem(this.prefKey, this.language) } catch { /* 语言偏好不可存时不阻断 */ }
  }

  /** 切换语言：标题/按钮/诊断提示同步，编辑器模型与草稿键跟随；不改内容。 */
  setLanguage(language: BotLanguage): void {
    if (language === this.language) return
    this.applyLanguage(language, true)
    const nextKey = this.languageKeyFor()
    if (this.draftKey) {
      this.saveLanguagePref()
      this.draftKey = nextKey
      this.source = this.loadDraft() ?? (language === 'ts' ? INITIAL_SOURCE_TS : INITIAL_SOURCE)
      try { this.draftStatus.textContent = '本地草稿' } catch { /* 忽略 */ }
      this.editor?.setValue(this.source)
    } else {
      this.draftKey = nextKey
    }
    this.renderButtons()
  }

  private languageKeyFor(): string {
    if (!this.draftKey) return ''
    // 从现有键恢复身份（房间码 + 昵称），再按新语言重建。
    try {
      const identity = JSON.parse(this.draftKey.slice('omb.bot.draft:'.length))
      const [roomCode = '', nick = ''] = Array.isArray(identity) ? identity : []
      return draftKeyFor(roomCode, nick, this.language)
    } catch { return this.draftKey }
  }

  private applyLanguage(language: BotLanguage, forward: boolean): void {
    this.language = language
    this.el('workbench-lang-ext').textContent = language === 'ts' ? 'ts' : 'js'
    this.el('workbench-lang-name').textContent = language === 'ts' ? 'TypeScript' : 'JavaScript'
    for (const button of this.languageButtons) {
      button.setAttribute('aria-pressed', String((button.dataset.lang === 'ts') === (language === 'ts')))
    }
    this.el('workbench-diagnostics').textContent = language === 'ts' ? 'TypeScript · 提交时编译为 JavaScript' : 'JavaScript · Bot API 补全'
    if (forward) this.editor?.setLanguage(language)
  }

  private async ensureEditor(): Promise<void> {
    if (this.editor || this.loadingEditor) return
    this.loadingEditor = true
    const loading = this.el('workbench-editor-loading')
    loading.hidden = false
    loading.textContent = '正在加载编辑器…'
    try {
      const { createBotEditor } = await import('./editor')
      this.editor = createBotEditor(this.el('workbench-code'), this.source, {
        onChange: source => {
          this.source = source
          try {
            if (this.draftKey) localStorage.setItem(this.draftKey, source)
            this.draftStatus.textContent = '草稿已保存'
          } catch { this.draftStatus.textContent = '草稿无法保存，请复制备份' }
          this.renderButtons()
        },
        onSubmit: () => this.submit(),
        onDiagnostics: (errors, warnings) => {
          this.el('workbench-diagnostics').textContent = errors || warnings ? `${errors} 个错误 · ${warnings} 个警告` : this.language === 'ts' ? '检查通过 · 提交时编译为 JavaScript' : '检查通过 · Bot API 补全'
        },
      }, this.language)
      loading.hidden = true
      this.renderButtons()
      if (this.editorPane.getClientRects().length && this.editorPane.contains(document.activeElement)) this.editor.focus()
    } catch (error) {
      loading.textContent = `编辑器加载失败：${error instanceof Error ? error.message : String(error)}。收起后重新展开可重试。`
    } finally { this.loadingEditor = false }
  }

  setAvailability(online: boolean, inMatch: boolean): void {
    if (this.online && !online) {
      const hadPending = !!this.pending
      this.clearPending()
      this.scriptConsole.clear()
      if (hadPending) this.scriptConsole.appendClient('warn', '连接中断，提交结果未知；重连后可重新提交。')
      this.snippetPanel.markOffline()
      this.aiPanel.markOffline()
    }
    this.online = online
    this.inMatch = inMatch
    this.renderButtons()
    this.renderToolPanels()
  }

  resetMatch(): void {
    const wasPending = !!this.pending
    this.clearPending()
    this.loaded = undefined
    this.assistOn = false
    this.inMatch = false
    this.scriptConsole.clear()
    if (wasPending) this.scriptConsole.appendClient('warn', '对局已切换，提交已取消；草稿仍保留。')
    this.snippetPanel.markMatchEnded()
    this.aiPanel.markMatchEnded()
    this.renderButtons()
    this.renderToolPanels()
  }

  setAssist(on: boolean): void {
    if (this.assistOn === on) return
    this.assistOn = on
    this.renderButtons()
  }

  private renderButtons(): void {
    this.submitButton.disabled = !this.editor || !this.online || !this.inMatch || !!this.pending || this.compiling
    this.submitButton.title = !this.online ? '连接恢复后可提交' : !this.inMatch ? '进入热身或正式对局后可提交' : '提交当前草稿（Ctrl / ⌘ + Enter）'
    this.assistButton.disabled = !this.online || !this.inMatch
    this.assistButton.textContent = `辅助 ${this.assistOn ? 'ON' : 'OFF'}`
    this.assistButton.setAttribute('aria-pressed', String(this.assistOn))
    this.assistButton.title = !this.online ? '连接恢复后可切换' : !this.inMatch ? '进入热身或正式对局后可切换（战场画布获焦时 Space / 小键盘 Enter）' : '战场画布获焦时按 Space 或小键盘 Enter 切换'
    this.editorPane.dataset.dirty = String(!this.loaded || this.loaded.source !== this.source)
  }

  submit(): void {
    if (!this.editor || !this.online || !this.inMatch || this.pending || this.compiling) return
    const id = this.nextScriptId = (this.nextScriptId + 1) >>> 0
    if (this.language === 'ts') {
      this.compiling = true
      this.renderButtons()
      this.scriptConsole.appendClient('info', '正在编译 TypeScript…')
      void this.editor.compile().then(outcome => {
        this.compiling = false
        if (!outcome.ok) {
          // 编译失败：不发送任何内容，旧脚本继续运行，错误按 TS 原始行列展示。
          this.scriptConsole.appendClient('error', `TypeScript 编译失败，未提交：\n${outcome.errors.join('\n')}`)
          this.renderButtons()
          return
        }
        this.sendScript(id, outcome.js)
      }).catch(error => {
        this.compiling = false
        this.scriptConsole.appendClient('error', `TypeScript 编译失败，未提交：${error instanceof Error ? error.message : String(error)}`)
        this.renderButtons()
      })
      return
    }
    this.sendScript(id, this.editor.getValue())
  }

  /** 编码后的整帧超过 32 KiB 会断开连接，不能只计算字符数。 */
  private sendScript(id: number, source: string): void {
    const frame = encodeClient(create(ClientMsgSchema, { payload: { case: 'scriptSubmit', value: { clientScriptId: id, source } } }))
    if (frame.byteLength > 32768) {
      this.scriptConsole.appendClient('error', '脚本过大：提交消息不能超过 32 KiB，请精简后重试。')
      this.renderButtons()
      return
    }
    this.pending = { id, source, timer: setTimeout(() => {
      this.clearPending()
      this.scriptConsole.appendClient('warn', '未收到服务器回执，结果未知；检查连接后可重新提交。')
      this.renderButtons()
    }, 10000) }
    this.scriptConsole.appendClient('info', '正在提交，等待服务器回执…')
    this.renderButtons()
    this.deps.send(frame)
  }

  acceptScriptLog(log: EvScriptLog): void {
    this.scriptConsole.append({
      robotId: log.robotId,
      scriptRev: log.scriptRev,
      tick: log.tick,
      level: log.level,
      text: log.text,
      truncated: log.truncated,
    })
  }

  acceptResult(result: EvScriptResult): void {
    if (result.clientScriptId === AI_SCRIPT_RESULT_ID) {
      // 服务器保留 id 0：AI 改码回执（非玩家提交）。成功热更交 AI 面板，
      // 失败已走 robot=0 定向说明；两种都不碰玩家提交 pending。
      if (result.ok) this.aiPanel.acceptHotSwap()
      return
    }
    if (!this.pending || result.clientScriptId !== this.pending.id) return
    const source = this.pending.source
    this.clearPending()
    if (result.ok) {
      this.loaded = { source, revision: result.scriptRev }
      this.scriptConsole.appendClient('info', `服务器已加载脚本 r${result.scriptRev}。${source !== this.source ? '当前草稿已有新修改。' : '开启辅助后运行；手操仍可逐轴接管。'}`)
    } else {
      this.scriptConsole.appendClient('error', `加载失败：${result.error || '服务器拒绝了脚本'}。原脚本保持不变。`)
    }
    this.renderButtons()
  }

  /** SnippetConfig 上行（仅在线对局中；帧超限防护与脚本提交一致）。 */
  sendSnippetConfig(settings: SnippetSetting[]): boolean {
    if (!this.online || !this.inMatch) return false
    const frame = encodeClient(create(ClientMsgSchema, {
      payload: { case: 'snippetConfig', value: create(SnippetConfigSchema, { snippets: settings }) },
    }))
    if (frame.byteLength > 32768) return false
    return this.deps.send(frame)
  }

  /** AiPrompt 上行（单玩家串行；AI 面板 pending 时已禁用发送）。 */
  sendAiPrompt(text: string): void {
    if (!this.online || !this.inMatch) return
    this.deps.send(encodeClient(create(ClientMsgSchema, {
      payload: { case: 'aiPrompt', value: create(AiPromptSchema, { text }) },
    })))
  }

  acceptSnippetResult(result: EvSnippetResult): void {
    this.snippetPanel.acceptResult(result)
  }

  acceptAiQuota(quota: EvAiQuota): void {
    this.aiPanel.acceptQuota(quota)
  }

  acceptAiUsage(usage: EvAiUsage): void {
    this.aiPanel.acceptUsage(usage)
  }

  /** 快照 SelfState 的配额初值（重连/进入对局时的权威基线）。 */
  acceptSelfAiQuota(roundsLeft: number, tokensLeftK: number): void {
    // SelfState 给的是“剩余”，面板文案用“剩余”；全局护栏只由定向回执提供。
    this.aiPanel.acceptQuota({ roundsLeft, tokensLeftK })
  }

  /** robot=0 定向说明：AI 面板 pending 时优先消费，否则返回 false 走系统通道。 */
  consumeAiDirectedSay(text: string): boolean {
    return this.aiPanel.acceptDirectedSay(text)
  }

  private renderToolPanels(): void {
    this.snippetPanel.render()
    this.aiPanel.render()
  }

  private clearPending(): void {
    if (this.pending) clearTimeout(this.pending.timer)
    this.pending = undefined
  }
}
