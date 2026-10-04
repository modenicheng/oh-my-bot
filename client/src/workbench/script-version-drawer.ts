// 脚本版本抽屉：编辑器面板内的当前版本指示 + 历史列表 + 回退动作。
// 战术终端风格：紧凑表格式列表（版本号/来源/时间），不是聊天气泡或通用卡片。
// 键盘可达：抽屉本身 tabindex=0 纳入 workbench 焦点链；行按钮原生 <button>。
import type { EvScriptRollbackResult } from '@omb/protocol'
import { icon } from '../icons'
import {
  displayOrder, originLabel, relativeVersionTime,
  type ScriptVersionState, type ScriptVersionView,
} from './script-versions'

export interface VersionDrawerDeps {
  root: HTMLElement
  /** 回退到指定版本（上行）；视图不负责可用性判断，由 workbench 统一守卫。 */
  rollback: (versionId: number) => void
  /** 找回未提交草稿（AI 直填覆盖前的手改）。 */
  restoreStash: () => boolean
  hasStash: () => boolean
  availability: () => { online: boolean; inMatch: boolean }
}

export class ScriptVersionDrawer {
  private toggleButton!: HTMLButtonElement
  private panel!: HTMLElement
  private badge!: HTMLElement
  private listEl!: HTMLElement
  private statusEl!: HTMLElement
  private stashButton!: HTMLButtonElement
  private open = false
  private pending?: number
  private pendingTimer?: ReturnType<typeof setTimeout>
  private stashVisible = false
  private state?: ScriptVersionState

  constructor(private readonly deps: VersionDrawerDeps) {
    this.build()
  }

  private build(): void {
    const root = this.deps.root
    root.innerHTML = `
      <button type="button" id="script-versions-toggle" aria-expanded="false" aria-controls="script-versions-panel" title="脚本版本历史（可回退到任意历史版本）">
        <span data-icon="replay"></span>版本<span id="script-versions-badge" class="script-versions-badge" hidden></span>
      </button>
      <section id="script-versions-panel" class="script-versions-panel" hidden tabindex="-1" aria-label="脚本版本历史">
        <header class="script-versions-head">
          <span>版本历史</span>
          <span class="script-versions-hint">房间内保留最近 32 个版本</span>
        </header>
        <div id="script-versions-list" class="script-versions-list" role="list"></div>
        <div id="script-versions-status" class="script-versions-status" role="status"></div>
      </section>`
    this.toggleButton = root.querySelector<HTMLButtonElement>('#script-versions-toggle')!
    this.badge = root.querySelector<HTMLElement>('#script-versions-badge')!
    this.panel = root.querySelector<HTMLElement>('#script-versions-panel')!
    this.listEl = root.querySelector<HTMLElement>('#script-versions-list')!
    this.statusEl = root.querySelector<HTMLElement>('#script-versions-status')!
    this.toggleButton.addEventListener('click', () => this.toggleOpen())
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer !== undefined) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = undefined
    }
  }

  private toggleOpen(): void {
    this.open = !this.open
    this.panel.hidden = !this.open
    this.toggleButton.setAttribute('aria-expanded', String(this.open))
    if (this.open) {
      this.render()
      // 展开后聚焦面板：方向键/Tab 在行按钮间移动；Esc 收起。
      this.panel.focus({ preventScroll: true })
    }
  }

  close(): void {
    this.open = false
    this.panel.hidden = true
    this.toggleButton.setAttribute('aria-expanded', 'false')
  }

  focusToggle(): void {
    this.toggleButton.focus({ preventScroll: true })
  }

  /** Esc 收起（workbench 键盘分发调用）。 */
  handleKeydown(event: KeyboardEvent): boolean {
    if (!this.open || event.key !== 'Escape') return false
    this.close()
    this.toggleButton.focus({ preventScroll: true })
    return true
  }

  setPending(versionId: number): void {
    this.clearPendingTimer()
    this.pending = versionId
    this.pendingTimer = setTimeout(() => {
      if (this.pending === undefined) return
      this.pending = undefined
      this.statusEl.textContent = '10 秒内未收到回退回执；当前版本未变，可重试。'
      this.render()
    }, 10_000)
    this.render()
  }

  acceptResult(result: EvScriptRollbackResult): void {
    this.clearPendingTimer()
    this.pending = undefined
    if (result.ok) {
      this.statusEl.textContent = `已回退并装载 r${result.scriptRev}；编辑器已同步。`
    } else {
      this.statusEl.textContent = result.error || '回退失败，当前脚本保持不变。'
    }
    this.render()
  }

  markOffline(): void {
    if (this.pending === undefined) return
    this.clearPendingTimer()
    this.pending = undefined
    this.statusEl.textContent = '连接中断，回退结果未知；当前版本以服务器为准。'
    this.render()
  }

  render(state?: ScriptVersionState): void {
    if (state) this.state = state
    const view = this.state
    const stash = this.deps.hasStash()
    if (stash !== this.stashVisible) {
      this.stashVisible = stash
      if (stash) this.ensureStashButton()
      else this.stashButton?.remove()
    }
    if (this.stashButton) this.stashButton.disabled = this.pending !== undefined
    if (!view || view.versions.length === 0) {
      this.badge.hidden = true
      this.renderEmpty()
      return
    }
    this.badge.hidden = false
    this.badge.textContent = String(view.versions.length)
    const { online, inMatch } = this.deps.availability()
    const rows = displayOrder(view)
    const fragment = document.createDocumentFragment()
    for (const version of rows) {
      fragment.append(this.renderRow(version, version.id === view.currentId, !online || !inMatch))
    }
    this.listEl.replaceChildren(fragment)
  }

  private renderEmpty(): void {
    const empty = document.createElement('p')
    empty.className = 'script-versions-empty'
    empty.textContent = '提交脚本或使用 AI 改码后，这里会出现可回退的版本记录。'
    this.listEl.replaceChildren(empty)
  }

  private renderRow(version: ScriptVersionView, isCurrent: boolean, disabled: boolean): HTMLElement {
    const row = document.createElement('div')
    row.className = 'script-version-row'
    row.dataset.current = String(isCurrent)
    row.setAttribute('role', 'listitem')
    const meta = document.createElement('div')
    meta.className = 'script-version-meta'
    const label = document.createElement('span')
    label.className = 'script-version-label'
    label.textContent = `v${version.id} · ${originLabel(version.origin)} · r${version.scriptRev}`
    const time = document.createElement('span')
    time.className = 'script-version-time'
    time.textContent = relativeVersionTime(version.wallMs)
    meta.append(label, time)
    const action = document.createElement('div')
    action.className = 'script-version-action'
    if (isCurrent) {
      const tag = document.createElement('span')
      tag.className = 'script-version-current-tag'
      tag.textContent = '当前'
      action.append(tag)
    } else {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.dataset.versionId = String(version.id)
      const pending = this.pending === version.id
      btn.disabled = disabled || this.pending !== undefined
      btn.textContent = pending ? '回退中…' : '回退到此版本'
      btn.title = disabled ? '连接恢复或进入对局后可回退' : `装载 v${version.id} 的源码并设为当前版本`
      btn.addEventListener('click', () => this.deps.rollback(version.id))
      action.append(btn)
    }
    row.append(meta, action)
    return row
  }

  private ensureStashButton(): void {
    if (this.stashButton) return
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'script-versions-stash'
    btn.textContent = '找回未提交改动'
    btn.title = 'AI 直填前如有未提交手改，点此放回编辑器（不会自动提交）'
    btn.addEventListener('click', () => {
      if (this.deps.restoreStash()) {
        this.statusEl.textContent = '未提交改动已放回编辑器；确认后再提交。'
        this.render()
      }
    })
    this.panel.querySelector('.script-versions-head')?.after(btn)
    this.stashButton = btn
  }
}
