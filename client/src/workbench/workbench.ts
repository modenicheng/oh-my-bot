import { create } from '@bufbuild/protobuf'
import { ClientMsgSchema, encodeClient, type EvScriptResult } from '@omb/protocol'
import { ManualView } from '../manual/manual'
import { mountIcons } from '../icons'
import type { RouteExtra, WorkbenchPanel } from '../route'
import type { BotEditor } from './editor'
import { draftKeyFor, isBotLanguage, languagePrefKey, type BotLanguage } from './ts-submit'
import './workbench.css'

const INITIAL_SOURCE_TS = `import type { TickContext } from '@omb/bot-api'

export function tick(ctx: TickContext) {
  const core = ctx.api.nearestCore()
  if (core) ctx.api.moveTo(core)
}
`
const INITIAL_SOURCE = `/** @param {import('@omb/bot-api').TickContext} ctx */
function tick(ctx) {
  const core = ctx.api.nearestCore()
  if (core) ctx.api.moveTo(core)
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
  send: (frame: Uint8Array) => void
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
  private stopResizing?: () => void
  private readonly submitButton: HTMLButtonElement
  private readonly assistButton: HTMLButtonElement
  private readonly result: HTMLElement
  private readonly draftStatus: HTMLElement
  private readonly languageButtons: HTMLButtonElement[]

  constructor(private readonly deps: WorkbenchDeps) {
    this.docPath = deps.initial.doc ?? 'index.md'
    for (const panel of deps.initial.panels ?? []) this.panels.add(panel)
    try {
      const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null')
      if (typeof saved?.width === 'number' && Number.isFinite(saved.width)) this.width = saved.width
      if (typeof saved?.ratio === 'number' && Number.isFinite(saved.ratio)) this.ratio = saved.ratio
    } catch { /* 存储不可用时仍可调整布局。 */ }
    deps.root.tabIndex = -1
    deps.root.innerHTML = `
      <div id="workbench-resize" class="workbench-resize" role="separator" tabindex="0" aria-label="侧栏宽度" aria-orientation="vertical" aria-controls="workbench"></div>
      <nav class="workbench-tools" aria-label="侧栏窗口">
        <button type="button" data-panel="docs" aria-controls="workbench-docs"><span data-icon="book"></span>文档</button>
        <button type="button" data-panel="editor" aria-controls="workbench-editor"><span data-icon="code"></span>编辑器</button>
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
        <header class="workbench-heading">
          <h2>bot.<span id="workbench-lang-ext">js</span> <span id="workbench-lang-name">JavaScript</span></h2>
          <span id="workbench-lang-switch" class="workbench-lang-switch" role="group" aria-label="脚本语言">
            <button type="button" data-lang="js" aria-pressed="true" title="编辑 JavaScript，按原样提交">JS</button>
            <button type="button" data-lang="ts" aria-pressed="false" title="编辑 TypeScript，提交前在浏览器内编译为 JavaScript">TS</button>
          </span>
          <span id="workbench-draft" role="status">本地草稿</span>
          <button type="button" data-panel="editor" aria-label="收起编辑器"><span data-icon="collapse"></span></button>
        </header>
        <div class="workbench-editor-area">
          <div id="workbench-code"></div>
          <div id="workbench-editor-loading" role="status">正在加载编辑器…</div>
        </div>
        <div class="workbench-editor-meta"><span id="workbench-diagnostics" role="status">JavaScript · Bot API 补全</span><span>Ctrl / ⌘ + Enter 提交</span></div>
        <div class="workbench-actions">
          <button type="button" id="workbench-submit" class="primary" disabled><span data-icon="play"></span>提交到机器人</button>
          <button type="button" id="workbench-assist" aria-pressed="false" disabled>辅助 OFF</button>
        </div>
        <div id="workbench-result" class="workbench-status" role="status" aria-live="polite">提交后开启辅助，让脚本驾驶机器人。</div>
      </section>`
    mountIcons(deps.root)
    this.docsPane = this.el('workbench-docs')
    this.editorPane = this.el('workbench-editor')
    this.resizeHandle = this.el('workbench-resize')
    this.splitHandle = this.el('workbench-split')
    this.submitButton = this.el('workbench-submit')
    this.assistButton = this.el('workbench-assist')
    this.result = this.el('workbench-result')
    this.draftStatus = this.el('workbench-draft')
    this.languageButtons = Array.from(this.deps.root.querySelectorAll<HTMLButtonElement>('#workbench-lang-switch [data-lang]'))
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
    if (this.isOpen && window.matchMedia('(max-width: 760px)').matches) this.focusPanel(this.panels.has('docs') ? 'docs' : 'editor')
    if (this.panels.has('docs')) void this.manual.open(this.docPath)
    if (this.panels.has('editor')) void this.ensureEditor()
  }

  toggle(panel: WorkbenchPanel): void {
    const pane = panel === 'docs' ? this.docsPane : this.editorPane
    const needsFocus = pane.contains(document.activeElement) || document.activeElement === this.splitHandle
    if (this.panels.has(panel)) {
      this.panels.delete(panel)
      if (panel === 'docs') this.manual.close()
    } else {
      this.panels.add(panel)
    }
    this.renderLayout()
    this.deps.onLayout()
    if (this.panels.has(panel)) {
      this.focusPanel(panel)
      if (panel === 'docs') void this.manual.open(this.docPath)
      else void this.ensureEditor()
    } else if (!this.isOpen) {
      this.focusCanvas()
    } else if (needsFocus) {
      this.focusPanel(this.panels.has('docs') ? 'docs' : 'editor')
    }
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
    const target = panel === 'docs' ? this.el('workbench-doc-content') : this.editorPane
    if (!target.getClientRects().length) return
    target.focus({ preventScroll: true })
    if (panel === 'editor') this.editor?.focus()
  }

  private renderLayout(): void {
    this.stopResizing?.()
    this.deps.root.hidden = !this.isOpen
    this.deps.gameView.classList.toggle('has-workbench', this.isOpen)
    this.docsPane.hidden = !this.panels.has('docs')
    this.editorPane.hidden = !this.panels.has('editor')
    this.splitHandle.hidden = this.panels.size !== 2
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
    if (restoreFocus && this.resizeHandle.hidden && this.isOpen) this.focusPanel(this.panels.has('docs') ? 'docs' : 'editor')
  }

  private saveLayout(): void {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ width: this.width, ratio: this.ratio })) }
    catch { /* 调整仍在当前页面生效。 */ }
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

  setIdentity(roomCode: string, nick: string): void {
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
          if (this.loaded && this.result.dataset.kind === 'ok') {
            this.setResult(`服务器已加载 r${this.loaded.revision}。${source === this.loaded.source ? '草稿与已加载版本一致。' : '草稿已有新修改，尚未提交。'}`, 'ok')
          }
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
      if (this.pending) this.setResult('连接中断，提交结果未知；重连后可重新提交。', 'error')
      this.clearPending()
    }
    this.online = online
    this.inMatch = inMatch
    this.renderButtons()
  }

  resetMatch(): void {
    const wasPending = !!this.pending
    this.clearPending()
    this.loaded = undefined
    this.assistOn = false
    this.inMatch = false
    this.setResult(wasPending ? '对局已切换，请重新提交草稿。' : '草稿已保留。提交后开启辅助，让脚本驾驶机器人。')
    this.renderButtons()
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
    this.editorPane.dataset.dirty = String(!this.loaded || this.loaded.source !== this.source)
  }

  private setResult(text: string, kind: 'info' | 'ok' | 'error' = 'info'): void {
    this.result.textContent = text
    this.result.dataset.kind = kind
  }

  submit(): void {
    if (!this.editor || !this.online || !this.inMatch || this.pending || this.compiling) return
    const id = this.nextScriptId = (this.nextScriptId + 1) >>> 0
    if (this.language === 'ts') {
      this.compiling = true
      this.renderButtons()
      this.setResult('正在编译 TypeScript…')
      void this.editor.compile().then(outcome => {
        this.compiling = false
        if (!outcome.ok) {
          // 编译失败：不发送任何内容，旧脚本继续运行，错误按 TS 原始行列展示。
          this.setResult(`TypeScript 编译失败，未提交：\n${outcome.errors.join('\n')}`, 'error')
          this.renderButtons()
          return
        }
        this.sendScript(id, outcome.js)
      }).catch(error => {
        this.compiling = false
        this.setResult(`TypeScript 编译失败，未提交：${error instanceof Error ? error.message : String(error)}`, 'error')
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
      this.setResult('脚本过大：提交消息不能超过 32 KiB，请精简后重试。', 'error')
      this.renderButtons()
      return
    }
    this.pending = { id, source, timer: setTimeout(() => {
      this.clearPending()
      this.setResult('未收到服务器回执，结果未知；检查连接后可重新提交。', 'error')
      this.renderButtons()
    }, 10000) }
    this.setResult('正在提交，等待服务器回执…')
    this.renderButtons()
    this.deps.send(frame)
  }

  acceptResult(result: EvScriptResult): void {
    if (!this.pending || result.clientScriptId !== this.pending.id) return
    const source = this.pending.source
    this.clearPending()
    if (result.ok) {
      this.loaded = { source, revision: result.scriptRev }
      this.setResult(`服务器已加载 r${result.scriptRev}。${source !== this.source ? '草稿已有新修改，尚未提交。' : '开启辅助后由脚本接管；手操仍可逐轴接管。'}`, 'ok')
    } else {
      this.setResult(`加载失败：${result.error || '服务器拒绝了脚本'}。原脚本保持不变。`, 'error')
    }
    this.renderButtons()
  }

  private clearPending(): void {
    if (this.pending) clearTimeout(this.pending.timer)
    this.pending = undefined
  }
}
