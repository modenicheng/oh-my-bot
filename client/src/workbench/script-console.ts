export interface ScriptLogEntry {
  robotId: number
  scriptRev: number
  tick: number
  level: string
  text: string
  truncated: boolean
}

export const MAX_CONSOLE_ENTRIES = 300

export class ScriptConsoleBuffer {
  private values: ScriptLogEntry[] = []
  private discarded = 0

  get entries(): readonly ScriptLogEntry[] { return this.values }
  get dropped(): number { return this.discarded }

  push(entry: ScriptLogEntry): void {
    this.values.push(entry)
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

export class ScriptConsoleView {
  private readonly buffer = new ScriptConsoleBuffer()
  private readonly toggle: HTMLButtonElement
  private readonly clearButton: HTMLButtonElement
  private readonly body: HTMLElement
  private readonly list: HTMLElement
  private readonly count: HTMLElement
  private expanded = true

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = `
      <header class="script-console-heading">
        <button type="button" class="script-console-toggle" aria-expanded="true">Console <span data-console-count>0</span></button>
        <button type="button" class="script-console-clear">清空</button>
      </header>
      <div class="script-console-body">
        <div class="script-console-list" role="log" aria-live="off" aria-label="脚本 Console 输出"></div>
      </div>`
    this.toggle = root.querySelector<HTMLButtonElement>('.script-console-toggle')!
    this.clearButton = root.querySelector<HTMLButtonElement>('.script-console-clear')!
    this.body = root.querySelector<HTMLElement>('.script-console-body')!
    this.list = root.querySelector<HTMLElement>('.script-console-list')!
    this.count = root.querySelector<HTMLElement>('[data-console-count]')!
    this.toggle.addEventListener('click', () => this.setExpanded(!this.expanded))
    this.clearButton.addEventListener('click', () => this.clear())
    this.render()
  }

  append(entry: ScriptLogEntry): void {
    const follow = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 24
    this.buffer.push(entry)
    this.render()
    if (this.expanded && follow) this.list.scrollTop = this.list.scrollHeight
  }

  clear(): void {
    this.buffer.clear()
    this.render()
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded
    this.body.hidden = !expanded
    this.toggle.setAttribute('aria-expanded', String(expanded))
    this.root.dataset.collapsed = String(!expanded)
    if (expanded) this.list.scrollTop = this.list.scrollHeight
  }

  private render(): void {
    const fragment = document.createDocumentFragment()
    let revision = -1
    if (this.buffer.dropped) {
      const notice = document.createElement('div')
      notice.className = 'script-console-notice'
      notice.textContent = `客户端缓冲已丢弃最早 ${this.buffer.dropped} 条日志`
      fragment.append(notice)
    }
    for (const entry of this.buffer.entries) {
      if (entry.scriptRev !== revision) {
        revision = entry.scriptRev
        const divider = document.createElement('div')
        divider.className = 'script-console-revision'
        divider.textContent = `script r${revision}`
        fragment.append(divider)
      }
      const line = document.createElement('div')
      const level = ['log', 'info', 'warn', 'error', 'debug'].includes(entry.level) ? entry.level : 'log'
      line.className = `script-console-line level-${level}`
      line.dataset.tick = String(entry.tick)
      const meta = document.createElement('span')
      meta.className = 'script-console-meta'
      meta.textContent = `t${entry.tick} ${level}`
      const text = document.createElement('span')
      text.className = 'script-console-text'
      text.textContent = entry.text + (entry.truncated && !entry.text.includes('limit reached') ? ' [截断]' : '')
      line.append(meta, text)
      fragment.append(line)
    }
    this.list.replaceChildren(fragment)
    this.count.textContent = String(this.buffer.entries.length)
    this.clearButton.disabled = this.buffer.entries.length === 0
  }
}
