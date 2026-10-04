export interface ScriptLogEntry {
  robotId: number
  scriptRev: number
  tick: number
  level: string
  text: string
  truncated: boolean
  source?: 'script' | 'client'
  repeat?: number
}

export type ConsoleValueSnapshot =
  | { kind: 'undefined' | 'null' }
  | { kind: 'string' | 'number' | 'boolean' | 'generic' | 'special'; value: string }
  | { kind: 'object' | 'array'; properties: Array<[string, ConsoleValueSnapshot]>; omitted: number }

export interface StructuredConsoleMessage {
  args: ConsoleValueSnapshot[]
  omitted: number
}

export const STRUCTURED_CONSOLE_PREFIX = '\u001eomb-console:v1:'
export const MAX_CONSOLE_ENTRIES = 300
export const MIN_CONSOLE_HEIGHT = 112
export const DEFAULT_CONSOLE_HEIGHT = 224
export const CONSOLE_HEIGHT_STEP = 24

const MAX_SNAPSHOT_PARSE_DEPTH = 8
const MAX_SNAPSHOT_PARSE_NODES = 256

export function clampConsoleHeight(value: number, max: number): number {
  const upper = Math.max(MIN_CONSOLE_HEIGHT, Math.floor(max))
  return Math.max(MIN_CONSOLE_HEIGHT, Math.min(upper, Math.round(value)))
}

export function consoleHeightForKey(key: string, current: number, max: number): number | undefined {
  if (key === 'Home') return MIN_CONSOLE_HEIGHT
  if (key === 'End') return Math.max(MIN_CONSOLE_HEIGHT, Math.floor(max))
  if (key === 'ArrowUp' || key === '+' || key === '=') return clampConsoleHeight(current + CONSOLE_HEIGHT_STEP, max)
  if (key === 'ArrowDown' || key === '-') return clampConsoleHeight(current - CONSOLE_HEIGHT_STEP, max)
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? Math.min(value, 1_000_000_000) : 0
}

function parseSnapshot(value: unknown, depth: number, budget: { nodes: number }): ConsoleValueSnapshot | undefined {
  if (!isRecord(value) || depth > MAX_SNAPSHOT_PARSE_DEPTH || ++budget.nodes > MAX_SNAPSHOT_PARSE_NODES) return undefined
  const kind = value.k
  if (kind === 'u') return { kind: 'undefined' }
  if (kind === 'z') return { kind: 'null' }
  if (kind === 's' || kind === 'n' || kind === 'b' || kind === 'g' || kind === 'x') {
    if (value.v !== undefined && typeof value.v !== 'string') return undefined
    const names = { s: 'string', n: 'number', b: 'boolean', g: 'generic', x: 'special' } as const
    return { kind: names[kind], value: typeof value.v === 'string' ? value.v : '' }
  }
  if (kind !== 'o' && kind !== 'a' || !Array.isArray(value.p) || value.p.length > 64) return undefined
  const properties: Array<[string, ConsoleValueSnapshot]> = []
  for (const pair of value.p) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') return undefined
    const child = parseSnapshot(pair[1], depth + 1, budget)
    if (!child) return undefined
    properties.push([pair[0], child])
  }
  return { kind: kind === 'a' ? 'array' : 'object', properties, omitted: safeCount(value.m) }
}

export function parseStructuredConsoleMessage(text: string): StructuredConsoleMessage | undefined {
  if (!text.startsWith(STRUCTURED_CONSOLE_PREFIX)) return undefined
  try {
    const payload: unknown = JSON.parse(text.slice(STRUCTURED_CONSOLE_PREFIX.length))
    if (!isRecord(payload) || !Array.isArray(payload.a) || payload.a.length > 32) return undefined
    const budget = { nodes: 0 }
    const args: ConsoleValueSnapshot[] = []
    for (const value of payload.a) {
      const parsed = parseSnapshot(value, 0, budget)
      if (!parsed) return undefined
      args.push(parsed)
    }
    return { args, omitted: safeCount(payload.m) }
  } catch {
    return undefined
  }
}

function entriesMatch(a: ScriptLogEntry, b: ScriptLogEntry): boolean {
  return a.robotId === b.robotId &&
    a.scriptRev === b.scriptRev &&
    a.level === b.level &&
    a.text === b.text &&
    a.truncated === b.truncated &&
    (a.source ?? 'script') === (b.source ?? 'script')
}

export class ScriptConsoleBuffer {
  private values: ScriptLogEntry[] = []
  private discarded = 0

  get entries(): readonly ScriptLogEntry[] { return this.values }
  get dropped(): number { return this.discarded }
  get messageCount(): number { return this.values.reduce((sum, entry) => sum + (entry.repeat ?? 1), 0) }

  push(entry: ScriptLogEntry): void {
    const previous = this.values.at(-1)
    if (previous && entriesMatch(previous, entry)) {
      previous.repeat = (previous.repeat ?? 1) + (entry.repeat ?? 1)
      previous.tick = entry.tick
      return
    }
    this.values.push({ ...entry, repeat: entry.repeat ?? 1 })
    if (this.values.length <= MAX_CONSOLE_ENTRIES) return
    const remove = this.values.length - MAX_CONSOLE_ENTRIES
    this.values.splice(0, remove)
    this.discarded += remove
  }

  clear(): void {
    this.values = []
    this.discarded = 0
  }
}

interface ScriptConsoleViewOptions {
  trigger: HTMLButtonElement
  open: boolean
  height: number
  onOpenChange: (open: boolean) => void
  onHeightChange: (height: number) => void
}

function snapshotPreview(value: ConsoleValueSnapshot, nested = false): string {
  switch (value.kind) {
    case 'undefined': return 'undefined'
    case 'null': return 'null'
    case 'string': return nested ? JSON.stringify(value.value) : value.value
    case 'special': return `[${value.value || 'Unavailable'}]`
    case 'number':
    case 'boolean':
    case 'generic': return value.value
    case 'object':
    case 'array': {
      const shown = value.properties.slice(0, 3).map(([name, child]) =>
        value.kind === 'array' ? snapshotPreview(child, true) : `${name}: ${snapshotPreview(child, true)}`)
      if (value.properties.length > shown.length || value.omitted) shown.push('…')
      const body = shown.join(', ')
      return value.kind === 'array' ? `Array(${value.properties.length + value.omitted}) [${body}]` : `{${body}}`
    }
  }
}

function renderSnapshot(value: ConsoleValueSnapshot, nested = false): HTMLElement {
  if (value.kind !== 'object' && value.kind !== 'array') {
    const token = document.createElement('span')
    token.className = `script-console-value value-${value.kind}`
    token.textContent = snapshotPreview(value, nested)
    return token
  }
  if (!value.properties.length && !value.omitted) {
    const empty = document.createElement('span')
    empty.className = 'script-console-value value-object'
    empty.textContent = value.kind === 'array' ? 'Array(0) []' : '{}'
    return empty
  }

  const details = document.createElement('details')
  details.className = `script-console-object value-${value.kind}`
  const summary = document.createElement('summary')
  summary.textContent = snapshotPreview(value, true)
  const properties = document.createElement('div')
  properties.className = 'script-console-properties'
  for (const [name, child] of value.properties) {
    const row = document.createElement('div')
    row.className = 'script-console-property'
    const key = document.createElement('span')
    key.className = 'script-console-property-key'
    key.textContent = `${name}:`
    row.append(key, renderSnapshot(child, true))
    properties.append(row)
  }
  if (value.omitted) {
    const omitted = document.createElement('div')
    omitted.className = 'script-console-property script-console-omitted'
    omitted.textContent = '… 更多属性未显示'
    properties.append(omitted)
  }
  details.append(summary, properties)
  return details
}

/** Browser-style Console drawer: logs survive closing, while size/open state persist through the workbench. */
export class ScriptConsoleView {
  private readonly buffer = new ScriptConsoleBuffer()
  private readonly trigger: HTMLButtonElement
  private readonly triggerCount: HTMLElement
  private readonly clearButton: HTMLButtonElement
  private readonly closeButton: HTMLButtonElement
  private readonly resizeHandle: HTMLElement
  private readonly list: HTMLElement
  private readonly count: HTMLElement
  private readonly options: ScriptConsoleViewOptions
  private opened: boolean
  private preferredHeight: number
  private appliedHeight = DEFAULT_CONSOLE_HEIGHT
  private finishResize?: () => void
  /** 与 buffer.entries 平行的已渲染行（含可选 revision 分隔线），支撑增量 append。 */
  private readonly rows: { divider: HTMLElement | null; line: HTMLElement }[] = []
  private renderedDropped = 0
  private lastRevision = -1
  private noticeEl: HTMLElement | null = null
  private emptyEl: HTMLElement | null = null

  constructor(private readonly root: HTMLElement, options: ScriptConsoleViewOptions) {
    this.options = options
    this.trigger = options.trigger
    this.opened = options.open
    this.preferredHeight = options.height
    root.innerHTML = `
      <div class="script-console-resize" role="separator" tabindex="0" aria-label="调整 Console 高度" aria-orientation="horizontal" aria-controls="script-console-output"></div>
      <header class="script-console-toolbar">
        <div class="script-console-tabs" role="tablist" aria-label="调试面板">
          <button type="button" class="script-console-tab" role="tab" aria-selected="true" aria-controls="script-console-output">Console <span data-console-count>0</span></button>
        </div>
        <div class="script-console-actions">
          <button type="button" class="script-console-clear">清空</button>
          <button type="button" class="script-console-close" aria-label="关闭 Console" title="关闭 Console">×</button>
        </div>
      </header>
      <div class="script-console-body" id="script-console-output" role="tabpanel">
        <div class="script-console-list" role="log" aria-live="off" aria-label="脚本 Console 输出" tabindex="0"></div>
      </div>`
    this.triggerCount = this.trigger.querySelector<HTMLElement>('[data-console-trigger-count]')!
    this.clearButton = root.querySelector<HTMLButtonElement>('.script-console-clear')!
    this.closeButton = root.querySelector<HTMLButtonElement>('.script-console-close')!
    this.resizeHandle = root.querySelector<HTMLElement>('.script-console-resize')!
    this.list = root.querySelector<HTMLElement>('.script-console-list')!
    this.count = root.querySelector<HTMLElement>('[data-console-count]')!
    this.trigger.addEventListener('click', () => this.setOpen(!this.opened, !this.opened))
    root.querySelector<HTMLButtonElement>('.script-console-tab')?.addEventListener('click', () => this.list.focus({ preventScroll: true }))
    this.clearButton.addEventListener('click', () => this.clear())
    this.closeButton.addEventListener('click', () => { this.setOpen(false); this.trigger.focus({ preventScroll: true }) })
    this.bindResize()
    this.setOpen(this.opened, false, false)
    this.render()
  }

  get isOpen(): boolean { return this.opened }
  get height(): number { return this.preferredHeight }

  append(entry: ScriptLogEntry): void {
    // 滚动跟随判定必须在写入前读布局（写后再读会强制同步布局）。
    const follow = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 24
    const scrollTop = this.list.scrollTop
    const droppedBefore = this.buffer.dropped
    const lengthBefore = this.buffer.entries.length
    this.buffer.push(entry)
    const entries = this.buffer.entries
    // push 只会：合并进末行（长度不变）、追加（+1）、追加后从头部裁剪（裁 evicted 行）。
    const evicted = this.buffer.dropped - droppedBefore
    const added = entries.length - (lengthBefore - evicted)
    for (let i = 0; i < evicted; i++) {
      const row = this.rows.shift()
      row?.divider?.remove()
      row?.line.remove()
    }
    if (added === 0 && evicted === 0) {
      // 重复合并：末行的 repeat 徽标与 tick 变化，整行重建（O(1)，不重解析其余行）。
      const index = this.rows.length - 1
      const fresh = this.buildRow(entries.at(-1)!)
      const stale = this.rows[index]
      if (stale) {
        stale.divider?.remove()
        if (fresh.divider) stale.line.before(fresh.divider)
        stale.line.replaceWith(fresh.line)
        this.rows[index] = fresh
      }
    }
    for (let i = this.rows.length; i < entries.length; i++) {
      const row = this.buildRow(entries[i]!)
      if (row.divider) this.list.insertBefore(row.divider, this.emptyEl)
      this.list.insertBefore(row.line, this.emptyEl)
      this.rows.push(row)
    }
    this.renderedDropped = this.buffer.dropped
    if (this.buffer.dropped > 0) {
      const text = `客户端缓冲已丢弃最早 ${this.buffer.dropped} 行日志`
      if (this.noticeEl) this.noticeEl.textContent = text
      else {
        this.noticeEl = document.createElement('div')
        this.noticeEl.className = 'script-console-notice'
        this.noticeEl.textContent = text
        this.list.prepend(this.noticeEl)
      }
    }
    if (this.emptyEl && this.rows.length) { this.emptyEl.remove(); this.emptyEl = null }
    this.syncFooter()
    if (this.opened) {
      const scrollHeight = this.list.scrollHeight // force final layout after evictions/wrapping
      this.list.scrollTop = follow ? scrollHeight : scrollTop
    }
  }

  appendClient(level: 'info' | 'warn' | 'error', text: string): void {
    this.append({ robotId: 0, scriptRev: 0, tick: 0, level, text, truncated: false, source: 'client' })
  }

  clear(): void {
    this.buffer.clear()
    this.render()
  }

  setOpen(open: boolean, focusConsole = false, notify = true): void {
    if (this.opened === open && this.root.hidden === !open) {
      if (open) this.refreshLayout()
      if (focusConsole) this.list.focus({ preventScroll: true })
      return
    }
    this.stopResizing()
    this.opened = open
    this.root.hidden = !open
    this.trigger.setAttribute('aria-expanded', String(open))
    if (open) {
      this.refreshLayout()
      this.list.scrollTop = this.list.scrollHeight
      if (focusConsole) this.list.focus({ preventScroll: true })
    }
    if (notify) this.options.onOpenChange(open)
  }

  refreshLayout(): void {
    if (!this.opened) return
    this.applyHeight(this.preferredHeight)
  }

  private maxHeight(): number {
    const paneHeight = this.root.parentElement?.clientHeight || DEFAULT_CONSOLE_HEIGHT + 180
    return Math.max(MIN_CONSOLE_HEIGHT, paneHeight - 180)
  }

  private applyHeight(value: number): void {
    this.appliedHeight = clampConsoleHeight(value, this.maxHeight())
    this.root.style.height = `${this.appliedHeight}px`
    this.resizeHandle.setAttribute('aria-valuemin', String(MIN_CONSOLE_HEIGHT))
    this.resizeHandle.setAttribute('aria-valuemax', String(Math.max(MIN_CONSOLE_HEIGHT, Math.floor(this.maxHeight()))))
    this.resizeHandle.setAttribute('aria-valuenow', String(this.appliedHeight))
    this.resizeHandle.setAttribute('aria-valuetext', `${this.appliedHeight} 像素`)
  }

  private setHeight(value: number, notify: boolean): void {
    this.preferredHeight = clampConsoleHeight(value, this.maxHeight())
    this.applyHeight(this.preferredHeight)
    if (notify) this.options.onHeightChange(this.preferredHeight)
  }

  private stopResizing(): void {
    this.finishResize?.()
  }

  private bindResize(): void {
    let drag: { pointerId: number; startY: number; height: number } | undefined
    const finish = (event?: PointerEvent) => {
      if (!drag || event && event.pointerId !== drag.pointerId) return
      const pointerId = drag.pointerId
      drag = undefined
      this.finishResize = undefined
      delete document.documentElement.dataset.consoleResize
      delete this.resizeHandle.dataset.resizing
      if (this.resizeHandle.hasPointerCapture(pointerId)) this.resizeHandle.releasePointerCapture(pointerId)
      this.options.onHeightChange(this.preferredHeight)
    }
    this.resizeHandle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary || !this.opened) return
      this.stopResizing()
      event.preventDefault()
      this.resizeHandle.focus({ preventScroll: true })
      this.resizeHandle.setPointerCapture(event.pointerId)
      drag = { pointerId: event.pointerId, startY: event.clientY, height: this.appliedHeight }
      this.finishResize = () => finish()
      document.documentElement.dataset.consoleResize = ''
      this.resizeHandle.dataset.resizing = ''
    })
    this.resizeHandle.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return
      event.preventDefault()
      this.setHeight(drag.height + drag.startY - event.clientY, false)
    })
    this.resizeHandle.addEventListener('pointerup', finish)
    this.resizeHandle.addEventListener('pointercancel', finish)
    this.resizeHandle.addEventListener('lostpointercapture', finish)
    this.resizeHandle.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const next = consoleHeightForKey(event.key, this.appliedHeight, this.maxHeight())
      if (next === undefined) return
      event.preventDefault()
      event.stopPropagation()
      this.stopResizing()
      this.setHeight(next, true)
    })
  }

  /** 全量重建（构造与 clear 时）：append 走增量路径，不经过这里。 */
  private render(): void {
    this.rows.length = 0
    this.renderedDropped = this.buffer.dropped
    this.lastRevision = -1
    this.noticeEl = null
    this.emptyEl = null
    const fragment = document.createDocumentFragment()
    if (this.buffer.dropped) {
      this.noticeEl = document.createElement('div')
      this.noticeEl.className = 'script-console-notice'
      this.noticeEl.textContent = `客户端缓冲已丢弃最早 ${this.buffer.dropped} 行日志`
      fragment.append(this.noticeEl)
    }
    for (const entry of this.buffer.entries) {
      const row = this.buildRow(entry)
      this.rows.push(row)
      if (row.divider) fragment.append(row.divider)
      fragment.append(row.line)
    }
    if (!this.rows.length && !this.buffer.dropped) {
      this.emptyEl = document.createElement('div')
      this.emptyEl.className = 'script-console-empty'
      this.emptyEl.textContent = '等待脚本输出 · 使用 console.log(...) 调试'
      fragment.append(this.emptyEl)
    }
    this.list.replaceChildren(fragment)
    this.syncFooter()
  }

  private syncFooter(): void {
    const size = String(this.buffer.messageCount)
    if (this.count.textContent !== size) this.count.textContent = size
    if (this.triggerCount.textContent !== size) this.triggerCount.textContent = size
    this.clearButton.disabled = this.buffer.entries.length === 0
  }

  private buildRow(entry: ScriptLogEntry): { divider: HTMLElement | null; line: HTMLElement } {
    const client = entry.source === 'client'
    let divider: HTMLElement | null = null
    if (!client && entry.scriptRev !== this.lastRevision) {
      this.lastRevision = entry.scriptRev
      divider = document.createElement('div')
      divider.className = 'script-console-revision'
      divider.textContent = `script r${entry.scriptRev}`
    }
    const line = document.createElement('div')
    const level = ['log', 'info', 'warn', 'error', 'debug'].includes(entry.level) ? entry.level : 'log'
    line.className = `script-console-line level-${level}${client ? ' source-client' : ''}`
    line.dataset.tick = String(entry.tick)
    const meta = document.createElement('span')
    meta.className = 'script-console-meta'
    if ((entry.repeat ?? 1) > 1) {
      const repeat = document.createElement('span')
      repeat.className = 'script-console-repeat'
      repeat.textContent = String(entry.repeat)
      repeat.title = `连续重复 ${entry.repeat} 次`
      meta.append(repeat)
    }
    const position = document.createElement('span')
    position.textContent = client ? `client ${level}` : `t${entry.tick} ${level}`
    meta.append(position)

    const parsed = parseStructuredConsoleMessage(entry.text)
    let content: HTMLElement
    if (parsed) {
      content = document.createElement('div')
      content.className = 'script-console-values'
      for (const value of parsed.args) content.append(renderSnapshot(value))
      if (parsed.omitted) {
        const omitted = document.createElement('span')
        omitted.className = 'script-console-omitted'
        omitted.textContent = `… +${parsed.omitted} args`
        content.append(omitted)
      }
    } else {
      content = document.createElement('span')
      content.className = 'script-console-text'
      content.textContent = entry.text
    }
    if (entry.truncated && !entry.text.includes('limit reached')) {
      const truncated = document.createElement('span')
      truncated.className = 'script-console-truncated'
      truncated.textContent = '[截断]'
      content.append(truncated)
    }
    line.append(meta, content)
    return { divider, line }
  }
}
