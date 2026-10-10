// Snippet 驾驶辅助面板：官方模块的开关/参数 → 显式应用 →
// EvSnippetResult 回执确认。控件使用项目自绘像素 UI；官方源码只展示/复制，
// 不会写入玩家编辑器。本地草稿按 room+nick 持久化。
import type { EvSnippetResult, SnippetSourceView } from '@omb/protocol'
import { icon, type IconName } from '../icons'
import {
  SNIPPET_ROWS, clampSnippetNumber, defaultSnippetDraft, loadSnippetDraft, saveSnippetDraft,
  snippetDraftMatchesApplied, snippetRowsFromSources, snippetSettingsFor, validateWaypoints,
  type SnippetDraft, type SnippetRowDef, type SnippetRowState,
} from './snippets'

export interface SnippetPanelDeps {
  root: HTMLElement
  send: (settings: ReturnType<typeof snippetSettingsFor>) => boolean
  availability: () => { online: boolean; inMatch: boolean }
  /** 应用配置后激活驾驶辅助（幂等）：Snippet 不开辅助不生效，这是最常见的
   * 玩家困惑（应用了却“没反应”）。返回是否已处于辅助开启状态。 */
  activateAssist?: () => boolean
}

export type SnippetApplyStatus =
  | { phase: 'idle' }
  | { phase: 'pending' }
  | { phase: 'ok'; rev: number }
  | { phase: 'error'; message: string }

const SNIPPET_ICONS: Record<SnippetRowDef['key'], IconName> = {
  autoAim: 'target',
  shield: 'shield',
  avoid: 'dash',
  patrol: 'replay',
  globalCore: 'target',
  lowHpHealthPack: 'energy',
}

function valueLabel(def: SnippetRowDef, value: number): string {
  if (def.param.type !== 'number') return ''
  return `${value}${def.param.unit}`
}

export class SnippetPanelView {
  private draft: SnippetDraft = defaultSnippetDraft()
  private applied?: ReturnType<typeof snippetSettingsFor>
  private appliedRev = 0
  private sources = new Map<number, SnippetSourceView>()
  /** 行定义：初始用离线兜底（审计 X-2），服务器 catalog 回执后以服务器为准。 */
  private rowDefs: readonly SnippetRowDef[] = SNIPPET_ROWS
  private identity = { roomCode: '', nick: '' }
  private status: SnippetApplyStatus = { phase: 'idle' }
  private pendingTimer?: ReturnType<typeof setTimeout>
  /** 草稿落盘防抖：滑块拖动每 input 同步 JSON+localStorage 会阻塞输入路径。 */
  private persistTimer?: number
  private statusEl!: HTMLElement
  private enabledCountEl!: HTMLElement
  private sourceCountEl!: HTMLElement
  private applyButton!: HTMLButtonElement
  private rows = new Map<SnippetRowDef['key'], {
    def: SnippetRowDef
    row: HTMLElement
    toggle: HTMLInputElement
    body: HTMLElement
    valueEl?: HTMLInputElement
    valueReadout?: HTMLOutputElement
    rangeFill?: HTMLElement
    textEl?: HTMLInputElement
    sourceBox: HTMLElement
    sourceToggle: HTMLButtonElement
    sourcePre: HTMLElement
    sourceNote: HTMLElement
  }>()

  constructor(private readonly deps: SnippetPanelDeps) {
    this.build()
    // 防抖落盘的兜底：页面隐藏/关闭时不丢最后 400ms 的滑块调整。
    window.addEventListener('pagehide', () => this.persistNow())
  }

  private build(): void {
    const root = this.deps.root
    root.innerHTML = `
      <header class="workbench-heading snippet-heading">
        <div class="snippet-heading-copy">
          <span class="snippet-kicker">OFFICIAL MODULE RACK</span>
          <h2>Snippet 驾驶辅助</h2>
        </div>
        <div class="snippet-heading-meta" aria-label="辅助模块状态">
          <span class="snippet-enabled-count">0 / ${this.rowDefs.length} ONLINE</span>
          <span class="snippet-source-count">源码 0 / ${this.rowDefs.length}</span>
        </div>
      </header>
      <div class="snippet-list" aria-label="官方 Snippet 模块"></div>
      <footer class="snippet-footer">
        <span class="snippet-status" role="status"></span>
        <button type="button" class="primary snippet-apply">应用配置</button>
      </footer>`
    this.statusEl = root.querySelector<HTMLElement>('.snippet-status')!
    this.enabledCountEl = root.querySelector<HTMLElement>('.snippet-enabled-count')!
    this.sourceCountEl = root.querySelector<HTMLElement>('.snippet-source-count')!
    this.applyButton = root.querySelector<HTMLButtonElement>('.snippet-apply')!
    this.buildRows()
    this.applyButton.addEventListener('click', () => this.apply())
    this.render()
  }

  /** 按当前 rowDefs 重建行 DOM（服务器 catalog 与兜底表不一致时整体换血）。 */
  private buildRows(): void {
    const list = this.deps.root.querySelector<HTMLElement>('.snippet-list')!
    this.rows.clear()
    for (const def of this.rowDefs) list.append(this.buildRow(def))
  }

  private buildRow(def: SnippetRowDef): HTMLElement {
    const row = document.createElement('section')
    row.className = 'snippet-row'
    row.dataset.kind = def.key

    const head = document.createElement('div')
    head.className = 'snippet-row-head'
    const label = document.createElement('label')
    label.className = 'snippet-toggle'
    const toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.className = 'snippet-check-input'
    toggle.id = `snippet-${def.key}`
    toggle.setAttribute('aria-label', `启用${def.title}`)
    const iconBox = document.createElement('span')
    iconBox.className = 'snippet-module-icon'
    // 服务器目录出现未知 key（版本偏差）时图标兜底，不因查表 miss 崩溃。
    iconBox.append(icon(SNIPPET_ICONS[def.key] ?? 'target'))
    const copy = document.createElement('span')
    copy.className = 'snippet-module-copy'
    const name = document.createElement('strong')
    name.className = 'snippet-name'
    name.textContent = def.title
    const hint = document.createElement('small')
    hint.className = 'snippet-hint'
    hint.textContent = def.hint
    copy.append(name, hint)
    const switchUi = document.createElement('span')
    switchUi.className = 'snippet-switch'
    switchUi.setAttribute('aria-hidden', 'true')
    const switchLed = document.createElement('span')
    switchLed.className = 'snippet-switch-led'
    switchUi.append(switchLed)
    label.append(toggle, iconBox, copy, switchUi)

    const sourceToggle = document.createElement('button')
    sourceToggle.type = 'button'
    sourceToggle.id = `snippet-source-toggle-${def.key}`
    sourceToggle.className = 'snippet-source-toggle'
    sourceToggle.setAttribute('aria-expanded', 'false')
    sourceToggle.setAttribute('aria-controls', `snippet-source-${def.key}`)
    sourceToggle.append(icon('code'), document.createTextNode('源码'))
    head.append(label, sourceToggle)

    const body = document.createElement('div')
    body.className = 'snippet-row-body'
    let valueEl: HTMLInputElement | undefined
    let valueReadout: HTMLOutputElement | undefined
    let rangeFill: HTMLElement | undefined
    let textEl: HTMLInputElement | undefined

    if (def.param.type === 'number') {
      const control = document.createElement('label')
      control.className = 'snippet-control snippet-control-range'
      const meta = document.createElement('span')
      meta.className = 'snippet-control-meta'
      const caption = document.createElement('span')
      caption.className = 'snippet-control-label'
      caption.textContent = def.param.unit === '%' ? 'HP 阈值' : def.key === 'avoid' ? '威胁半径' : '搜索半径'
      valueReadout = document.createElement('output')
      valueReadout.className = 'snippet-range-value'
      const rangeId = `snippet-range-${def.key}`
      valueReadout.htmlFor = rangeId
      meta.append(caption, valueReadout)
      const rangeShell = document.createElement('span')
      rangeShell.className = 'snippet-range-shell'
      const rangeTrack = document.createElement('span')
      rangeTrack.className = 'snippet-range-track'
      rangeFill = document.createElement('span')
      rangeFill.className = 'snippet-range-fill'
      const rangeThumb = document.createElement('span')
      rangeThumb.className = 'snippet-range-thumb'
      rangeFill.append(rangeThumb)
      rangeTrack.append(rangeFill)
      valueEl = document.createElement('input')
      valueEl.type = 'range'
      valueEl.id = rangeId
      valueEl.className = 'snippet-range-input'
      valueEl.min = String(def.param.min)
      valueEl.max = String(def.param.max)
      valueEl.step = String(def.param.step)
      valueEl.setAttribute('aria-label', caption.textContent)
      rangeShell.append(rangeTrack, valueEl)
      const scale = document.createElement('span')
      scale.className = 'snippet-range-scale'
      scale.innerHTML = `<span>${def.param.min}${def.param.unit}</span><span>${def.param.max}${def.param.unit}</span>`
      control.append(meta, rangeShell, scale)
      body.append(control)
    } else if (def.param.type === 'waypoints') {
      const control = document.createElement('label')
      control.className = 'snippet-control snippet-control-route'
      const meta = document.createElement('span')
      meta.className = 'snippet-control-meta'
      const caption = document.createElement('span')
      caption.className = 'snippet-control-label'
      caption.textContent = '巡逻路径点'
      const format = document.createElement('span')
      format.className = 'snippet-control-format'
      format.textContent = 'x,y ; x,y'
      meta.append(caption, format)
      textEl = document.createElement('input')
      textEl.type = 'text'
      textEl.className = 'snippet-route-input'
      textEl.spellcheck = false
      textEl.placeholder = '30,0;0,30;-30,0;0,-30'
      control.append(meta, textEl)
      body.append(control)
    }

    const sourceBox = document.createElement('div')
    sourceBox.id = `snippet-source-${def.key}`
    sourceBox.className = 'snippet-source'
    sourceBox.hidden = true
    sourceBox.setAttribute('role', 'region')
    sourceBox.setAttribute('aria-labelledby', sourceToggle.id)
    const sourcePre = document.createElement('pre')
    sourceBox.append(sourcePre)
    const sourceFoot = document.createElement('div')
    sourceFoot.className = 'snippet-source-foot'
    const sourceNote = document.createElement('span')
    sourceNote.className = 'snippet-source-note'
    const copyButton = document.createElement('button')
    copyButton.type = 'button'
    copyButton.className = 'snippet-copy-source'
    copyButton.append(icon('code'), document.createTextNode('复制'))
    sourceFoot.append(sourceNote, copyButton)
    sourceBox.append(sourceFoot)

    copyButton.addEventListener('click', () => {
      const source = this.sources.get(def.kind)?.source ?? ''
      if (!source) {
        copyButton.textContent = '等待源码'
        window.setTimeout(() => copyButton.replaceChildren(icon('code'), document.createTextNode('复制')), 1500)
        return
      }
      void navigator.clipboard?.writeText(source).then(() => {
        copyButton.textContent = '已复制'
        window.setTimeout(() => copyButton.replaceChildren(icon('code'), document.createTextNode('复制')), 1500)
      }).catch(() => {
        copyButton.textContent = '复制失败'
        window.setTimeout(() => copyButton.replaceChildren(icon('code'), document.createTextNode('复制')), 1500)
      })
    })
    sourceToggle.addEventListener('click', () => {
      const open = sourceBox.hidden
      sourceBox.hidden = !open
      sourceToggle.setAttribute('aria-expanded', String(open))
      if (open) this.renderSource(def, sourcePre, sourceNote)
    })

    const bind = (update: (state: SnippetRowState) => void) => () => {
      const state = this.draft[def.key]
      update(state)
      this.persist()
      this.render()
    }
    toggle.addEventListener('change', bind(state => { state.enabled = toggle.checked }))
    valueEl?.addEventListener('input', bind(state => { state.p1 = clampSnippetNumber(def, Number(valueEl!.value)) }))
    textEl?.addEventListener('input', bind(state => { state.s1 = textEl!.value }))
    textEl?.addEventListener('change', bind(state => { state.s1 = textEl!.value.trim() }))

    row.append(head, body, sourceBox)
    this.rows.set(def.key, { def, row, toggle, body, valueEl, valueReadout, rangeFill, textEl, sourceBox, sourceToggle, sourcePre, sourceNote })
    return row
  }

  apply(): void {
    if (this.status.phase === 'pending') return
    const { online, inMatch } = this.deps.availability()
    if (!online || !inMatch) return
    for (const def of this.rowDefs) {
      if (def.param.type !== 'waypoints') continue
      const state = this.draft[def.key]
      if (!state.enabled) continue
      const problem = validateWaypoints(state.s1)
      if (problem) {
        this.status = { phase: 'error', message: `${def.title}：${problem}` }
        this.render()
        return
      }
    }
    const sent = this.deps.send(snippetSettingsFor(this.draft, this.rowDefs))
    if (!sent) {
      this.status = { phase: 'error', message: '请求未发送：连接正在切换，请稍后重试。' }
      this.render()
      return
    }
    this.clearPendingTimer()
    this.status = { phase: 'pending' }
    this.pendingTimer = setTimeout(() => {
      if (this.status.phase !== 'pending') return
      this.status = { phase: 'error', message: '10 秒内未收到服务器回执；现役配置未确认，可重新应用。' }
      this.render()
    }, 10_000)
    this.render()
  }

  setIdentity(roomCode: string, nick: string): void {
    if (this.identity.roomCode === roomCode && this.identity.nick === nick) return
    this.persistNow() // 身份切换前把旧草稿落盘
    this.identity = { roomCode, nick }
    this.draft = roomCode ? loadSnippetDraft(roomCode, nick) : defaultSnippetDraft(this.rowDefs)
    this.ensureDraftFor(this.rowDefs)
    this.applied = undefined
    this.appliedRev = 0
    this.clearPendingTimer()
    this.status = { phase: 'idle' }
    this.render()
  }

  acceptResult(result: EvSnippetResult): void {
    this.clearPendingTimer()
    for (const view of result.sources) this.sources.set(view.kind, view)
    // 审计 X-2：服务器 catalog 到达后行定义以服务器为准（key/title/hint/参数
    // 控件/默认值），SNIPPET_ROWS 退化为离线兜底。仅在真正不一致时重建行 DOM。
    if (result.sources.length > 0) {
      const defs = snippetRowsFromSources(result.sources)
      if (this.catalogDiffers(defs)) {
        this.rowDefs = defs
        this.ensureDraftFor(defs)
        this.buildRows()
      }
    }
    if (result.ok) {
      this.applied = result.applied.map(setting => ({ ...setting }))
      this.appliedRev = result.scriptRev
      this.status = { phase: 'ok', rev: result.scriptRev }
      // 应用成功即激活辅助：snippet 挂在辅助仲裁层下，不开辅助等于没应用。
      if (result.applied.some(setting => setting.enabled)) this.deps.activateAssist?.()
    } else {
      this.status = { phase: 'error', message: result.error || '服务器拒绝了配置' }
    }
    this.render()
  }

  markOffline(): void {
    if (this.status.phase !== 'pending') return
    this.clearPendingTimer()
    this.status = { phase: 'error', message: '连接中断，结果未知；重连后可重新应用。' }
    this.render()
  }

  markMatchEnded(): void {
    if (this.status.phase !== 'pending') return
    this.clearPendingTimer()
    this.status = { phase: 'error', message: '对局已切换，应用结果未知；草稿保留。' }
    this.render()
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer)
    this.pendingTimer = undefined
  }

  /** 服务器目录与当前行定义是否有差异（key/文案/控件形态/默认值任一）。 */
  private catalogDiffers(defs: readonly SnippetRowDef[]): boolean {
    if (defs.length !== this.rowDefs.length) return true
    return defs.some((def, i) => {
      const cur = this.rowDefs[i]
      if (!cur) return true
      return cur.key !== def.key || cur.title !== def.title || cur.hint !== def.hint
        || JSON.stringify(cur.param) !== JSON.stringify(def.param)
        || cur.defaultEnabled !== def.defaultEnabled
        || cur.defaultP1 !== def.defaultP1 || cur.defaultS1 !== def.defaultS1
    })
  }

  /** 为服务器目录中出现而本地草稿缺失的行补默认态（版本偏差防御）。 */
  private ensureDraftFor(defs: readonly SnippetRowDef[]): void {
    for (const def of defs) {
      if (!this.draft[def.key]) {
        this.draft[def.key] = { enabled: def.defaultEnabled, p1: def.defaultP1, s1: def.defaultS1 }
      }
    }
  }

  private persist(): void {
    if (this.persistTimer !== undefined) return
    this.persistTimer = window.setTimeout(() => { this.persistTimer = undefined; this.persistNow() }, 400)
  }

  private persistNow(): void {
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
    const { roomCode, nick } = this.identity
    if (!roomCode) return
    saveSnippetDraft(roomCode, nick, this.draft)
  }

  private renderSource(def: SnippetRowDef, pre: HTMLElement, note: HTMLElement): void {
    const view = this.sources.get(def.kind)
    if (!view) {
      pre.textContent = '// 正在等待服务器同步官方源码…'
      note.textContent = '进入对局或应用配置后自动同步'
      return
    }
    pre.textContent = view.source
    note.textContent = `${view.title} · 服务器执行定稿`
  }

  render(): void {
    let enabledCount = 0
    for (const entry of this.rows.values()) {
      const state = this.draft[entry.def.key]
      if (state.enabled) enabledCount++
      entry.toggle.checked = state.enabled
      entry.row.classList.toggle('enabled', state.enabled)
      entry.row.dataset.source = this.sources.has(entry.def.kind) ? 'ready' : 'waiting'
      entry.body.setAttribute('aria-disabled', String(!state.enabled))
      if (entry.valueEl && entry.def.param.type === 'number') {
        entry.valueEl.disabled = !state.enabled
        entry.valueEl.value = String(state.p1)
        const progress = ((state.p1 - entry.def.param.min) / (entry.def.param.max - entry.def.param.min)) * 100
        if (entry.rangeFill) entry.rangeFill.style.width = `${Math.max(0, Math.min(100, progress))}%`
        if (entry.valueReadout) entry.valueReadout.textContent = valueLabel(entry.def, state.p1)
      }
      if (entry.textEl && document.activeElement !== entry.textEl) entry.textEl.value = state.s1
      if (entry.textEl) entry.textEl.disabled = !state.enabled
      if (!entry.sourceBox.hidden) this.renderSource(entry.def, entry.sourcePre, entry.sourceNote)
    }
    this.enabledCountEl.textContent = `${enabledCount} / ${this.rowDefs.length} ONLINE`
    this.enabledCountEl.dataset.active = String(enabledCount > 0)
    this.sourceCountEl.textContent = `源码 ${this.sources.size} / ${this.rowDefs.length}`
    this.sourceCountEl.dataset.ready = String(this.sources.size === this.rowDefs.length)

    const { online, inMatch } = this.deps.availability()
    this.applyButton.disabled = !online || !inMatch || this.status.phase === 'pending'
    this.applyButton.textContent = this.status.phase === 'pending' ? '应用中…' : '应用配置'
    const dirty = this.applied ? !snippetDraftMatchesApplied(this.draft, this.applied) : this.hasAnyEnabled()
    this.applyButton.dataset.dirty = String(dirty)
    let text: string
    switch (this.status.phase) {
      case 'pending': text = '正在应用，等待服务器回执…'; break
      case 'ok': text = this.appliedRev === 0
        ? '配置已保存，正在装配本局运行时'
        : dirty ? `已生效 r${this.appliedRev} · 本地有未应用修改` : `已生效 r${this.appliedRev}`; break
      case 'error': text = this.status.message; break
      default: text = this.applied
        ? dirty ? '本地有未应用的修改' : '与服务器一致'
        : this.hasAnyEnabled() ? '草稿已保存，尚未应用' : '选择模块后应用到当前机器人'
    }
    this.statusEl.textContent = text
    this.statusEl.dataset.phase = this.status.phase
    this.statusEl.dataset.dirty = String(dirty)
  }

  private hasAnyEnabled(): boolean {
    return this.rowDefs.some(row => this.draft[row.key].enabled)
  }

  /** 已应用配置里含自瞄模块（服务器已回执生效）。用于瞄准 guard。 */
  aimsTurret(): boolean {
    return !!this.applied?.some(setting => setting.kind === 1)
  }

  focus(): void {
    ;(this.rows.get('autoAim')?.toggle ?? this.applyButton).focus({ preventScroll: true })
  }
}
