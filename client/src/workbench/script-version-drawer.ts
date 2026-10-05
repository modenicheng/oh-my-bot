// 脚本版本浮层：编辑器标题栏的当前版本指示 + 历史列表 + 回退动作。
// body portal：根容器只剩 toggle，面板挂在 document.body（position:fixed），
// 不再被编辑器标题栏 overflow/层叠上下文裁剪或挤压布局。
// 战术终端风格：紧凑表格式列表（版本号/来源/语言/时间）。
// 键盘可达：行按钮原生 <button>；Esc 收起并把焦点还给 toggle。
import type { EvScriptRollbackResult } from '@omb/protocol'
import { icon } from '../icons'
import {
  computePanelPlacement, PANEL_VIEWPORT_MARGIN,
} from './script-version-placement'
import {
  displayOrder, languageLabel, originLabel, relativeVersionTime,
  type ScriptVersionState, type ScriptVersionView,
} from './script-versions'

export interface VersionDrawerDeps {
  root: HTMLElement
  /** 回退到指定版本（上行）；视图不负责可用性判断，由 workbench 统一守卫。 */
  rollback: (versionId: number) => void
  /** 找回未提交草稿（直填/回退覆盖前的手改；切回其语言）。 */
  restoreStash: () => boolean
  hasStash: () => boolean
  availability: () => { online: boolean; inMatch: boolean }
}

/**
 * 版本浮层视图。生命周期：workbench 构造时创建，页面级单例；
 * dispose() 摘除 portal 面板与全局监听（关闭 workbench 视图/身份清理）。
 */
export class ScriptVersionDrawer {
  private static readonly PANEL_ID = 'script-versions-panel'
  private readonly toggleButton: HTMLButtonElement
  private badge!: HTMLElement
  private panel!: HTMLElement
  private listEl!: HTMLElement
  private statusEl!: HTMLElement
  private stashButton?: HTMLButtonElement
  private stashVisible = false
  private open = false
  private pending?: number
  private pendingTimer?: ReturnType<typeof setTimeout>
  private state?: ScriptVersionState
  private readonly onGlobalPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    const target = event.target
    if (target instanceof Node && (this.panel.contains(target) || this.toggleButton.contains(target))) return
    this.close()
  }
  private readonly onWindowResize = () => { if (this.open) this.refreshPosition() }
  /** 打开期间捕获滚动：浮层 fixed 定位，滚动下层内容时保持贴合锚点。 */
  private readonly onDocScroll = () => { if (this.open) this.refreshPosition() }
  private readonly onWindowKeyDown = (event: KeyboardEvent) => {
    if (!this.open || event.key !== 'Escape') return
    // 冒泡阶段收起：不拦截捕获链，Monaco 内部（补全列表等）的 Esc 处理不受影响。
    this.close()
    this.toggleButton.focus({ preventScroll: true })
  }

  constructor(private readonly deps: VersionDrawerDeps) {
    this.deps.root.replaceChildren()
    this.toggleButton = document.createElement('button')
    this.toggleButton.type = 'button'
    this.toggleButton.id = 'script-versions-toggle'
    this.toggleButton.setAttribute('aria-expanded', 'false')
    this.toggleButton.setAttribute('aria-controls', ScriptVersionDrawer.PANEL_ID)
    this.toggleButton.title = '脚本版本历史（可回退到任意历史版本）'
    const label = document.createElement('span')
    label.append(icon('replay'), document.createTextNode('版本'))
    this.badge = document.createElement('span')
    this.badge.id = 'script-versions-badge'
    this.badge.className = 'script-versions-badge'
    this.badge.hidden = true
    this.toggleButton.append(label, this.badge)
    this.toggleButton.addEventListener('click', () => this.toggleOpen())
    this.deps.root.append(this.toggleButton)
    this.buildPanel()
  }

  /** portal 面板节点（hidden 挂载到 body；打开时显示 + 定位）。 */
  private buildPanel(): void {
    this.panel = document.createElement('section')
    this.panel.id = ScriptVersionDrawer.PANEL_ID
    this.panel.className = 'script-versions-panel'
    this.panel.hidden = true
    this.panel.setAttribute('aria-label', '脚本版本历史')
    const header = document.createElement('header')
    header.className = 'script-versions-head'
    const title = document.createElement('span')
    title.textContent = '版本历史'
    const hint = document.createElement('span')
    hint.className = 'script-versions-hint'
    hint.textContent = '房间内保留最近 32 个版本'
    header.append(title, hint)
    this.listEl = document.createElement('div')
    this.listEl.id = 'script-versions-list'
    this.listEl.className = 'script-versions-list'
    this.listEl.setAttribute('role', 'list')
    this.statusEl = document.createElement('div')
    this.statusEl.id = 'script-versions-status'
    this.statusEl.className = 'script-versions-status'
    this.statusEl.setAttribute('role', 'status')
    this.panel.append(header, this.listEl, this.statusEl)
    document.body.append(this.panel)
  }

  private toggleOpen(): void {
    if (this.open) this.close()
    else this.openPanel()
  }

  private openPanel(): void {
    this.open = true
    this.panel.hidden = false
    this.toggleButton.setAttribute('aria-expanded', 'true')
    this.render()
    this.refreshPosition()
    document.addEventListener('pointerdown', this.onGlobalPointerDown, true)
    window.addEventListener('keydown', this.onWindowKeyDown)
    window.addEventListener('resize', this.onWindowResize)
    document.addEventListener('scroll', this.onDocScroll, { capture: true, passive: true })
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this.panel.hidden = true
    this.toggleButton.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', this.onGlobalPointerDown, true)
    window.removeEventListener('keydown', this.onWindowKeyDown)
    window.removeEventListener('resize', this.onWindowResize)
    document.removeEventListener('scroll', this.onDocScroll, { capture: true } as EventListenerOptions)
  }

  /** 重算面板几何（打开期间 resize/滚动/布局变化时由监听器调用）。 */
  refreshPosition(): void {
    if (!this.open) return
    const rect = this.toggleButton.getBoundingClientRect()
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const place = computePanelPlacement(
      { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      viewport,
    )
    const style = this.panel.style
    style.position = 'fixed'
    style.left = `${place.left}px`
    style.top = `${place.top}px`
    style.width = `${place.width}px`
    style.maxHeight = `${place.maxHeight}px`
    this.panel.dataset.placement = place.placement
    this.panel.style.setProperty('--panel-margin', String(PANEL_VIEWPORT_MARGIN))
  }

  focusToggle(): void {
    this.toggleButton.focus({ preventScroll: true })
  }

  /** Esc 收起（workbench 编辑器面板键盘分发调用；窗口级兜底在构造时挂）。 */
  handleKeydown(event: KeyboardEvent): boolean {
    if (!this.open || event.key !== 'Escape') return false
    this.close()
    this.focusToggle()
    return true
  }

  /** 摘除 portal 面板与全局监听（workbench 销毁/身份清理路径）。 */
  dispose(): void {
    this.close()
    this.clearPendingTimer()
    this.panel.remove()
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
      else { this.stashButton?.remove(); this.stashButton = undefined }
    }
    if (this.stashButton) this.stashButton.disabled = this.pending !== undefined
    if (this.open) this.refreshPosition()
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
    label.textContent = `v${version.id} · ${originLabel(version.origin)} · ${languageLabel(version.language)} · r${version.scriptRev}`
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
    btn.title = '服务器直填/回退覆盖前如有未提交手改，点此放回编辑器（不会自动提交）'
    btn.addEventListener('click', () => {
      if (this.deps.restoreStash()) {
        this.statusEl.textContent = '未提交改动已放回编辑器；确认后再提交。'
        this.render()
      }
    })
    this.panel.querySelector('.script-versions-head')?.after(btn)
    this.stashButton = btn
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer !== undefined) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = undefined
    }
  }
}
