import { create } from '@bufbuild/protobuf'
import { ClientMsgSchema, encodeClient, type EvScriptResult } from '@omb/protocol'
import { ManualView } from '../manual/manual'
import { mountIcons } from '../icons'
import type { RouteExtra, WorkbenchPanel } from '../route'
import type { BotEditor } from './editor'
import './workbench.css'

const INITIAL_SOURCE = `/** @param {import('@omb/bot-api').TickContext} ctx */
function tick(ctx) {
  const core = ctx.api.nearestCore()
  if (core) ctx.api.moveTo(core)
}
`

interface WorkbenchDeps {
  root: HTMLElement
  gameView: HTMLElement
  docsButton: HTMLButtonElement
  editorButton: HTMLButtonElement
  initial: RouteExtra
  onLayout: () => void
  onInputBlocked: (blocked: boolean) => void
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
  private online = false
  private inMatch = false
  private assistOn = false
  private nextScriptId = 0
  private pending?: { id: number; source: string; timer: ReturnType<typeof setTimeout> }
  private loaded?: { source: string; revision: number }
  private readonly docsPane: HTMLElement
  private readonly editorPane: HTMLElement
  private readonly submitButton: HTMLButtonElement
  private readonly assistButton: HTMLButtonElement
  private readonly result: HTMLElement
  private readonly draftStatus: HTMLElement

  constructor(private readonly deps: WorkbenchDeps) {
    this.docPath = deps.initial.doc ?? 'index.md'
    for (const panel of deps.initial.panels ?? []) this.panels.add(panel)
    deps.root.innerHTML = `
      <nav class="workbench-tools" aria-label="侧栏窗口">
        <button type="button" data-panel="docs" aria-controls="workbench-docs"><span data-icon="book"></span>文档</button>
        <button type="button" data-panel="editor" aria-controls="workbench-editor"><span data-icon="code"></span>编辑器</button>
        <button type="button" id="workbench-close"><span data-icon="back"></span>返回战场</button>
      </nav>
      <section id="workbench-docs" class="workbench-pane" aria-label="文档">
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
      <section id="workbench-editor" class="workbench-pane" aria-label="脚本编辑器">
        <header class="workbench-heading">
          <h2>bot.js <span>JavaScript</span></h2>
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
    this.submitButton = this.el('workbench-submit')
    this.assistButton = this.el('workbench-assist')
    this.result = this.el('workbench-result')
    this.draftStatus = this.el('workbench-draft')
    this.manual = new ManualView({
      root: this.docsPane,
      breadcrumb: this.el('workbench-breadcrumb'),
      sidebar: this.el('workbench-toc'),
      content: this.el('workbench-doc-content'),
      status: this.el('workbench-doc-status'),
      onExit: () => this.toggle('docs'),
      onNavigate: path => {
        this.docPath = path
        this.el('workbench-toc').hidden = true
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
    // 初始化仅设置布局；宿主完成构造后再打开异步视图。
    this.renderLayout()
  }

  private el<T extends HTMLElement>(id: string): T {
    return this.deps.root.querySelector<T>(`#${id}`)!
  }

  get isOpen(): boolean { return this.panels.size > 0 }

  get route(): RouteExtra { return { panels: [...this.panels], doc: this.docPath } }

  activate(): void {
    this.deps.onInputBlocked(this.isOpen)
    if (this.panels.has('docs')) void this.manual.open(this.docPath)
    if (this.panels.has('editor')) void this.ensureEditor()
  }

  toggle(panel: WorkbenchPanel): void {
    if (this.panels.has(panel)) {
      this.panels.delete(panel)
      if (panel === 'docs') this.manual.close()
    } else {
      this.panels.add(panel)
    }
    this.renderLayout()
    this.deps.onInputBlocked(this.isOpen)
    this.deps.onLayout()
    if (this.panels.has(panel)) {
      if (panel === 'docs') void this.manual.open(this.docPath)
      else void this.ensureEditor()
    } else if (!this.isOpen) {
      this.deps.docsButton.blur()
      this.deps.editorButton.blur()
      this.deps.gameView.querySelector<HTMLCanvasElement>('canvas')?.focus()
    }
  }

  close(): void {
    this.panels.clear()
    this.manual.close()
    this.renderLayout()
    this.deps.onInputBlocked(false)
    this.deps.onLayout()
    this.deps.gameView.querySelector<HTMLCanvasElement>('canvas')?.focus()
  }

  private renderLayout(): void {
    this.deps.root.hidden = !this.isOpen
    this.deps.gameView.classList.toggle('has-workbench', this.isOpen)
    this.docsPane.hidden = !this.panels.has('docs')
    this.editorPane.hidden = !this.panels.has('editor')
    for (const [button, panel] of [[this.deps.docsButton, 'docs'], [this.deps.editorButton, 'editor']] as const) {
      button.setAttribute('aria-expanded', String(this.panels.has(panel)))
    }
    this.deps.root.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach(button => {
      button.setAttribute('aria-expanded', String(this.panels.has(button.dataset.panel as WorkbenchPanel)))
    })
  }

  setIdentity(roomCode: string, nick: string): void {
    const key = `omb.bot.draft:${JSON.stringify([roomCode, nick])}`
    if (this.draftKey === key) return
    this.resetMatch()
    this.draftKey = key
    this.source = INITIAL_SOURCE
    try {
      this.source = localStorage.getItem(key) ?? INITIAL_SOURCE
      this.draftStatus.textContent = '本地草稿'
    } catch { this.draftStatus.textContent = '草稿无法保存' }
    this.editor?.setValue(this.source)
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
          this.el('workbench-diagnostics').textContent = errors || warnings ? `${errors} 个错误 · ${warnings} 个警告` : '检查通过 · Bot API 补全'
        },
      })
      loading.hidden = true
      this.renderButtons()
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
    this.submitButton.disabled = !this.editor || !this.online || !this.inMatch || !!this.pending
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
    if (!this.editor || !this.online || !this.inMatch || this.pending) return
    const source = this.editor.getValue()
    const id = this.nextScriptId = (this.nextScriptId + 1) >>> 0
    const frame = encodeClient(create(ClientMsgSchema, { payload: { case: 'scriptSubmit', value: { clientScriptId: id, source } } }))
    // WebSocket 默认上限为整帧 32 KiB；超限会断开连接，不能只计算字符数。
    if (frame.byteLength > 32768) {
      this.setResult('脚本过大：提交消息不能超过 32 KiB，请精简后重试。', 'error')
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
