import './mobile-controls.css'
import { icon, type IconName } from '../icons'
import { setLandscapeLayout, viewportPoint, viewportRect } from '../app/landscape'
import { TouchState, type FireMode, type TouchAbility, type TouchGeometry, type TouchSnapshot } from './input/touch-state'
import { OrientationGate } from './orientation'

export type { TouchSnapshot } from './input/touch-state'

export interface MobileControlsDeps {
  onInput: (snapshot: TouchSnapshot) => void
  onShot: (aim: number) => void
  onGateChange: () => void
  onAssist: () => void
  onChat: () => void
  onMenu: () => void
}

type Layout = 'auto' | 'touch' | 'desktop'
const MODE_KEY = 'omb.mobile.fire-mode', LAYOUT_KEY = 'omb.mobile.layout'
const EMPTY_GEOMETRY: TouchGeometry = {
  left: { left: 0, top: 0, width: 0, height: 0 }, moveRadius: 60,
  right: { x: -1000, y: -1000, radius: 0 }, abilities: {},
}
const ABILITIES: readonly TouchAbility[] = ['dash', 'shield', 'interact']
const SKILL_IDS = { dash: 'dash', shield: 'shield', interact: 'uplink' } as const

function stored(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function persist(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* Private/storage-disabled browsing still works. */ }
}
function text(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value
}
function data(element: HTMLElement, key: string, value: string | undefined): void {
  if (element.dataset[key] === value) return
  if (value === undefined) delete element.dataset[key]
  else element.dataset[key] = value
}

/** Presentation and Pointer Events adapter; no combat timing or authoritative eligibility. */
export class MobileControls {
  private readonly surface = document.createElement('div')
  private readonly leftZone = document.createElement('div')
  private readonly leftStick = document.createElement('div')
  private readonly leftKnob = document.createElement('span')
  private readonly rightStick = document.createElement('div')
  private readonly rightKnob = document.createElement('span')
  private readonly gatePanel = document.createElement('div')
  private readonly gateTitle = document.createElement('h2')
  private readonly gateCopy = document.createElement('p')
  private readonly layoutLabel = document.createElement('label')
  private readonly layoutSelect = document.createElement('select')
  private readonly buttons = new Map<string, HTMLButtonElement>()
  private readonly statuses = new Map<string, HTMLElement>()
  private readonly state: TouchState
  private readonly orientation: OrientationGate
  private readonly coarse = matchMedia('(pointer: coarse)')
  private readonly observers: ResizeObserver[] = []
  private readonly removeListeners: Array<() => void> = []
  private readonly touchHelp = document.createElement('details')
  private layout: Layout
  private effectiveTouch = false
  private battleVisible = true
  private supported = false
  private enabled: boolean | undefined
  private disposed = false
  private drawer: 'scores' | 'upgrades' | undefined
  private leftBounds = { left: 0, top: 0 }
  private geometry: TouchGeometry = EMPTY_GEOMETRY

  constructor(private readonly root: HTMLElement, private readonly deps: MobileControlsDeps) {
    const preference = stored(LAYOUT_KEY)
    this.layout = preference === 'touch' || preference === 'desktop' ? preference : 'auto'
    this.state = new TouchState(EMPTY_GEOMETRY, stored(MODE_KEY) === 'hold' ? 'hold' : 'single')
    this.orientation = new OrientationGate(root, () => this.invalidateGeometry())
    this.build()
    this.bindNativeButtons()
    this.listen(root, 'pointerdown', event => this.pointerDown(event as PointerEvent))
    this.listen(root, 'pointermove', event => this.pointerMove(event as PointerEvent))
    this.listen(root, 'pointerup', event => this.pointerUp(event as PointerEvent))
    this.listen(root, 'pointercancel', event => this.pointerCancel(event as PointerEvent))
    this.listen(root, 'lostpointercapture', event => this.pointerCancel(event as PointerEvent))
    this.listen(window, 'blur', () => this.cancel())
    this.listen(window, 'pagehide', () => this.cancel())
    this.listen(document, 'visibilitychange', () => this.cancel())
    this.listen(this.coarse, 'change', () => this.refreshLayout())
    // Captured gestures suppress synthetic compatibility mouse events, not document zoom.
    this.listen(this.surface, 'mousedown', event => event.stopPropagation())
    this.listen(this.surface, 'contextmenu', event => event.preventDefault())
    this.listen(this.surface, 'keydown', event => {
      if ((event as KeyboardEvent).key === 'Escape' && this.drawer) {
        event.preventDefault()
        this.toggleDrawer(this.drawer)
      }
    })
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => this.invalidateGeometry())
      observer.observe(root)
      observer.observe(this.leftZone)
      observer.observe(this.rightStick)
      this.observers.push(observer)
    }
    this.refreshLayout(false)
    this.update()
  }

  get touch(): boolean { return !this.disposed && this.effectiveTouch }
  get blocked(): boolean {
    return this.touch && this.battleVisible && (!this.supported || this.drawer !== undefined)
  }

  /** Warmup/Running presentation lifetime, separate from focus and the selected layout. */
  setBattleVisible(visible: boolean): void {
    if (this.disposed || visible === this.battleVisible) return
    if (!visible) {
      this.cancel()
      this.drawer = undefined
      this.root.classList.remove('touch-scores-open', 'touch-upgrades-open')
      for (const key of ['scores', 'upgrades']) this.buttons.get(key)!.setAttribute('aria-expanded', 'false')
    }
    this.battleVisible = visible
    this.renderGate()
    if (visible) this.measureGeometry()
    this.deps.onGateChange()
  }

  setCapability(supported: boolean): void {
    if (this.disposed || supported === this.supported) return
    this.cancel()
    this.supported = supported
    this.renderGate()
    this.deps.onGateChange()
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || enabled === this.enabled) return
    if (!enabled) this.cancel() // Stop reaches the consumer before it disables the input source.
    this.enabled = enabled
    data(this.surface, 'enabled', String(enabled))
    if (enabled) this.measureGeometry()
    // This method is called by the gate callback itself; never notify it recursively.
  }

  cancel(): void {
    if (this.disposed) return
    const owners = this.state.owners
    this.state.cancel()
    this.releaseCaptures(owners)
    this.emit()
  }

  /** Send the old-axis stop before dropping sticky takeover, never rearm after Assist. */
  resetTakeover(): void {
    if (this.disposed) return
    this.cancel()
    this.state.resetTakeover()
    this.renderGestures()
  }

  /** Called at render rate: cached nodes only; no bounding boxes/computed style here. */
  update(): void {
    if (this.disposed) return
    for (const ability of ABILITIES) {
      const source = this.root.querySelector<HTMLElement>(`#skill-${SKILL_IDS[ability]}`)
      const button = this.buttons.get(ability)!
      const state = source?.dataset.state ?? 'off'
      data(button, 'state', state)
      data(button, 'takeover', source?.dataset.takeover)
      const reason = source?.querySelector('.skill-cd')?.textContent ?? '—'
      text(this.statuses.get(ability)!, (state === 'cooling' || state === 'active') && /\d/.test(reason) ? reason : '')
      const description = `${button.dataset.label} · ${reason}`
      if (button.getAttribute('aria-label') !== description) button.setAttribute('aria-label', description)
      // Unavailable styling must never disable the release of an already captured owner.
      const unavailable = source?.dataset.state === 'off' || source?.dataset.state === 'cooling' || !source
      if (button.getAttribute('aria-disabled') !== String(unavailable)) button.setAttribute('aria-disabled', String(unavailable))
    }
    const fire = this.root.querySelector<HTMLElement>('#skill-fire')
    data(this.rightStick, 'state', fire?.dataset.state ?? 'off')
    text(this.statuses.get('fire')!, fire?.querySelector('.skill-cd')?.textContent ?? '—')
    const assist = this.root.querySelector<HTMLElement>('#hud-assist')
    text(this.statuses.get('assist')!, assist?.textContent ?? '辅助')
    const pressed = this.root.querySelector<HTMLElement>('#skill-assist')?.dataset.state === 'active'
      || assist?.textContent?.includes('ON') === true
    const assistButton = this.buttons.get('assist')!
    if (assistButton.getAttribute('aria-pressed') !== String(pressed)) assistButton.setAttribute('aria-pressed', String(pressed))
    // Keep the top row bounded even when scores grow; the HUD already shows the number.
    text(this.statuses.get('scores')!, '积分')
    const scoreLabel = `积分排行，当前积分 ${this.root.querySelector('#hud-self-score strong')?.textContent || '—'}`
    const scoresButton = this.buttons.get('scores')!
    if (scoresButton.getAttribute('aria-label') !== scoreLabel) scoresButton.setAttribute('aria-label', scoreLabel)
    text(this.statuses.get('upgrades')!, `升级 ${this.root.querySelector('.hud-up-points b')?.textContent ?? '0'}`)
  }

  dispose(): void {
    if (this.disposed) return
    this.cancel()
    this.disposed = true
    this.removeListeners.splice(0).forEach(remove => remove())
    this.observers.forEach(observer => observer.disconnect())
    this.orientation.dispose()
    this.touchHelp.remove()
    this.surface.remove()
    this.layoutLabel.remove()
    this.root.classList.remove('touch-battle', 'touch-upgrades-open', 'touch-scores-open')
  }

  private build(): void {
    this.surface.className = 'mobile-controls'
    this.surface.dataset.battleControl = ''
    this.surface.tabIndex = -1
    this.surface.setAttribute('aria-label', '触控战场操作')

    const toolbar = document.createElement('nav')
    toolbar.className = 'mobile-toolbar'
    toolbar.setAttribute('aria-label', '触控战场菜单')
    toolbar.append(
      this.button('menu', '选项', undefined, () => this.auxiliary(this.deps.onMenu)),
      this.button('assist', '辅助', undefined, () => this.auxiliary(this.deps.onAssist)),
      this.button('scores', '积分', undefined, () => this.toggleDrawer('scores')),
    )
    const tools = document.createElement('nav')
    tools.className = 'mobile-tools'
    tools.setAttribute('aria-label', '触控辅助操作')
    tools.append(
      this.button('upgrades', '升级', 'skillPoint', () => this.toggleDrawer('upgrades')),
      this.button('chat', '发言', undefined, () => this.auxiliary(this.deps.onChat)),
    )

    this.leftZone.className = 'mobile-move-zone'
    this.leftZone.dataset.mobileRole = 'move'
    this.leftZone.setAttribute('aria-label', '移动摇杆')
    this.leftStick.className = 'mobile-stick mobile-move-stick'
    this.leftKnob.className = 'mobile-stick-knob'
    this.leftStick.append(this.leftKnob)
    const moveLabel = document.createElement('span')
    moveLabel.className = 'mobile-move-label'
    moveLabel.textContent = '移动'
    this.leftZone.append(this.leftStick, moveLabel)

    const cluster = document.createElement('div')
    cluster.className = 'mobile-right-cluster'
    this.rightStick.className = 'mobile-stick mobile-aim-stick'
    this.rightStick.dataset.mobileRole = 'aim'
    this.rightStick.setAttribute('aria-label', '瞄准摇杆，拖动后松手单发')
    this.rightKnob.className = 'mobile-stick-knob'
    const aimLabel = document.createElement('span')
    aimLabel.className = 'mobile-stick-label'
    aimLabel.textContent = '瞄准'
    const fireStatus = document.createElement('small')
    fireStatus.className = 'mobile-fire-status'
    this.statuses.set('fire', fireStatus)
    this.rightStick.append(this.rightKnob, aimLabel, fireStatus)
    cluster.append(this.rightStick)
    for (const ability of ABILITIES) {
      const label = { dash: '冲刺', shield: '护盾', interact: '黑入' }[ability]
      const button = this.button(ability, label, ability === 'interact' ? 'uplink' : ability, undefined, true)
      delete button.dataset.mobileAction
      button.dataset.mobileAbility = ability
      button.classList.add('mobile-ability')
      button.dataset.label = label
      const status = document.createElement('small')
      status.className = 'mobile-ability-status'
      status.setAttribute('aria-hidden', 'true')
      button.append(status)
      this.statuses.set(ability, status)
      cluster.append(button)
    }
    const mode = this.button('mode', '松手单发', 'fire', () => this.switchMode(), true)
    cluster.append(mode)
    this.renderMode()

    this.gatePanel.className = 'mobile-gate'
    this.gatePanel.dataset.mobileGate = ''
    this.gatePanel.setAttribute('role', 'region')
    this.gatePanel.setAttribute('aria-label', '触控操作暂停')
    const card = document.createElement('div')
    card.className = 'mobile-gate-card'
    const menu = this.button('gate-menu', '选项 / 离开', undefined, () => this.auxiliary(this.deps.onMenu))
    menu.dataset.mobileAction = 'menu'
    card.append(this.gateTitle, this.gateCopy, menu)
    this.gatePanel.append(card)
    this.surface.append(toolbar, tools, this.leftZone, cluster, this.gatePanel)
    this.root.append(this.surface)

    this.layoutLabel.className = 'mobile-layout-choice'
    const title = document.createElement('span')
    title.textContent = '操作布局'
    this.layoutSelect.dataset.mobileLayout = ''
    this.layoutSelect.setAttribute('aria-label', '操作布局')
    for (const [value, label] of [['auto', '自动'], ['touch', '触控'], ['desktop', '键鼠']]) {
      const option = document.createElement('option')
      option.value = value!
      option.textContent = label!
      this.layoutSelect.append(option)
    }
    this.layoutSelect.value = this.layout
    this.layoutLabel.append(title, this.layoutSelect)
    const options = this.root.ownerDocument.querySelector('#game-options .game-options-panel')
    ;(options ?? this.root).append(this.layoutLabel)
    if (!options) this.layoutLabel.classList.add('mobile-layout-fallback')
    this.touchHelp.className = 'mobile-help'
    const summary = document.createElement('summary')
    summary.textContent = '触控操作帮助'
    summary.tabIndex = 0 // Include the native disclosure in GameOptions' modal focus loop.
    const helpCopy = document.createElement('p')
    helpCopy.textContent = '左摇杆移动，右摇杆定向瞄准。默认松手单发（准星图标），回到中心取消；切换为按住连发（三发图标）后，按住外圈开火。按住冲刺、护盾或黑入；瞄准手指经过技能按钮不会触发技能或中断开火，技能需直接按下，松手结束。技能角标亮点表示激活，短横表示不可用；数字显示冷却或黑入进度。'
    this.touchHelp.append(summary, helpCopy)
    options?.append(this.touchHelp)
    this.listen(this.layoutSelect, 'change', () => {
      const next = this.layoutSelect.value
      this.layout = next === 'touch' || next === 'desktop' ? next : 'auto'
      persist(LAYOUT_KEY, this.layout)
      this.refreshLayout()
    })
  }

  private button(action: string, label: string, glyph?: IconName, click?: () => void, iconOnly = false): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.mobileAction = action
    button.setAttribute('aria-label', label)
    if (glyph) button.append(icon(glyph))
    if (!iconOnly) {
      const caption = document.createElement('span')
      caption.className = 'mobile-control-caption'
      caption.textContent = label
      button.append(caption)
      this.statuses.set(action, caption)
    }
    this.buttons.set(action, button)
    if (click) {
      let activatedOnDown = false
      // A third/nonprimary touch may never produce a compatibility click.
      this.listen(button, 'pointerdown', event => {
        const pointer = event as PointerEvent
        activatedOnDown = pointer.button === 0 && (pointer.pointerType === 'touch' || pointer.pointerType === 'pen')
        if (!activatedOnDown) return
        event.preventDefault()
        event.stopPropagation()
        button.focus({ preventScroll: true })
        click()
      })
      this.listen(button, 'click', event => {
        event.stopPropagation()
        // Dedupe touch/pen clicks; a new mouse down restores native click behavior.
        if (activatedOnDown && (event as MouseEvent).detail > 0) {
          activatedOnDown = false
          event.preventDefault()
          return
        }
        click()
      })
    }
    return button
  }

  private bindNativeButtons(): void {
    const options = this.root.ownerDocument.getElementById('game-options')
    const buttons = [...this.root.querySelectorAll<HTMLButtonElement>('button'),
      ...(options?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    for (const button of buttons) {
      if (this.surface.contains(button)) continue
      let activatedOnDown = false
      // Existing HUD/host buttons also need to work while both thumbs are held.
      this.listen(button, 'pointerdown', event => {
        const pointer = event as PointerEvent
        activatedOnDown = this.touch && this.battleVisible && !button.disabled &&
          !pointer.isPrimary && pointer.button === 0 &&
          (pointer.pointerType === 'touch' || pointer.pointerType === 'pen')
        if (!activatedOnDown) return
        event.preventDefault()
        event.stopPropagation()
        this.cancel()
        button.focus({ preventScroll: true })
        button.click()
      })
      // Capture precedes existing click listeners, which may already be bound.
      this.listen(button, 'click', event => {
        if (!activatedOnDown || (event as MouseEvent).detail === 0) return
        activatedOnDown = false
        event.preventDefault()
        event.stopImmediatePropagation()
      }, true)
    }
  }

  private pointerDown(event: PointerEvent): void {
    const target = event.target as Element | null
    // An open mobile drawer is a modal touch surface. Tapping anywhere else
    // dismisses it, but the dismissing contact must not become battle input.
    if (this.drawer !== undefined && !target?.closest(
      '.hud-upgrades, .hud-roster, [data-mobile-action="upgrades"], [data-mobile-action="scores"]')) {
      this.closeDrawer()
      return
    }
    if (!this.touch || !this.battleVisible || this.blocked || event.pointerType === 'mouse' || event.button !== 0) return
    if (!target?.closest('[data-mobile-role], [data-mobile-ability]')) return
    // Focusing first synchronously enables main's battle-domain gate on first contact.
    this.surface.focus({ preventScroll: true })
    const point = viewportPoint(event.clientX, event.clientY)
    if (!this.enabled || !this.state.pointerDown(event.pointerId, point.x, point.y)) return
    event.preventDefault()
    event.stopPropagation()
    try { this.surface.setPointerCapture(event.pointerId) }
    catch {
      this.state.pointerCancel(event.pointerId)
      this.emit()
      return
    }
    this.emit()
  }

  private pointerMove(event: PointerEvent): void {
    const point = viewportPoint(event.clientX, event.clientY)
    if (!this.state.pointerMove(event.pointerId, point.x, point.y)) return
    event.preventDefault()
    this.emit()
  }

  private pointerUp(event: PointerEvent): void {
    const point = viewportPoint(event.clientX, event.clientY)
    const result = this.state.pointerUp(event.pointerId, point.x, point.y)
    if (!result.handled) return
    event.preventDefault()
    this.releaseCaptures([event.pointerId])
    this.emit()
    if (result.shot !== undefined) this.deps.onShot(result.shot)
  }

  private pointerCancel(event: PointerEvent): void {
    if (!this.state.pointerCancel(event.pointerId)) return
    this.releaseCaptures([event.pointerId])
    this.emit()
  }

  private switchMode(): void {
    const owners = this.state.owners
    const mode: FireMode = this.state.mode === 'single' ? 'hold' : 'single'
    this.state.setMode(mode)
    this.releaseCaptures(owners.filter(id => !this.state.owners.includes(id)))
    persist(MODE_KEY, mode)
    this.renderMode()
    this.emit()
  }

  private renderMode(): void {
    const held = this.state.mode === 'hold', button = this.buttons.get('mode')!
    button.replaceChildren(icon(held ? 'fireBurst' : 'fire'))
    data(button, 'mode', this.state.mode)
    const description = `开火模式：${held ? '按住连发' : '松手单发'}，点击切换为${held ? '松手单发' : '按住连发'}`
    button.setAttribute('aria-label', description)
    button.title = description
    button.setAttribute('aria-pressed', String(held))
    this.rightStick.setAttribute('aria-label', held ? '瞄准摇杆，按住外圈连发' : '瞄准摇杆，拖动后松手单发')
  }

  private auxiliary(action: () => void): void {
    this.cancel()
    action()
  }

  private toggleDrawer(drawer: 'scores' | 'upgrades'): void {
    if (this.drawer === drawer) {
      this.closeDrawer()
      return
    }
    this.cancel()
    this.drawer = drawer
    this.root.classList.toggle('touch-scores-open', this.drawer === 'scores')
    this.root.classList.toggle('touch-upgrades-open', this.drawer === 'upgrades')
    for (const key of ['scores', 'upgrades']) this.buttons.get(key)!.setAttribute('aria-expanded', String(this.drawer === key))
    this.deps.onGateChange()
  }

  private closeDrawer(): void {
    if (this.drawer === undefined) return
    this.cancel()
    this.drawer = undefined
    this.root.classList.remove('touch-scores-open', 'touch-upgrades-open')
    for (const key of ['scores', 'upgrades']) this.buttons.get(key)!.setAttribute('aria-expanded', 'false')
    this.deps.onGateChange()
  }

  private refreshLayout(notify = true): void {
    const next = this.layout === 'touch' || this.layout === 'auto' && this.coarse.matches
    if (next !== this.effectiveTouch) {
      this.cancel()
      this.state.resetTakeover()
      this.effectiveTouch = next
      this.drawer = undefined
      this.root.classList.remove('touch-scores-open', 'touch-upgrades-open')
    }
    this.root.classList.toggle('touch-battle', next)
    this.touchHelp.hidden = !next
    if (!next) this.touchHelp.open = false
    setLandscapeLayout(this.layout)
    this.renderGate()
    this.measureGeometry()
    if (notify) this.deps.onGateChange()
  }

  private invalidateGeometry(): void {
    if (this.disposed) return
    this.cancel() // Release before any hit region can move beneath an old finger.
    this.measureGeometry()
    this.renderGate()
    this.deps.onGateChange()
  }

  private measureGeometry(): void {
    if (!this.touch || !this.battleVisible) return
    const left = viewportRect(this.leftZone), right = viewportRect(this.rightStick)
    this.leftBounds = { left: left.left, top: left.top }
    this.geometry = {
      left: { left: left.left, top: left.top, width: left.width, height: left.height },
      moveRadius: right.width / 2,
      right: { x: right.left + right.width / 2, y: right.top + right.height / 2, radius: right.width / 2 },
      abilities: Object.fromEntries(ABILITIES.map(ability => {
        const rect = viewportRect(this.buttons.get(ability)!)
        return [ability, { left: rect.left, top: rect.top, width: rect.width, height: rect.height }]
      })),
    }
    this.state.setGeometry(this.geometry)
    this.renderGestures()
  }

  private renderGate(): void {
    this.surface.hidden = !this.touch || !this.battleVisible
    this.gatePanel.hidden = this.surface.hidden || this.supported
    text(this.gateTitle, '触控版本不兼容')
    text(this.gateCopy, '服务器尚不支持安全单发，请更新服务器，或在选项中切换键鼠布局。不会自动开始射击。')
  }

  private emit(): void {
    this.renderGestures()
    this.deps.onInput(this.state.snapshot)
  }

  private renderGestures(): void {
    const left = this.state.left
    this.leftStick.hidden = !left
    if (left) {
      this.leftStick.style.left = `${left.origin.x - this.leftBounds.left}px`
      this.leftStick.style.top = `${left.origin.y - this.leftBounds.top}px`
      this.knob(this.leftKnob, left.point.x - left.origin.x, left.point.y - left.origin.y, this.geometry.moveRadius)
    }
    const right = this.state.right, snapshot = this.state.snapshot
    data(this.rightStick, 'gesture', right.phase)
    if (right.point && right.phase !== 'ability-held') {
      this.knob(this.rightKnob, right.point.x - this.geometry.right.x, right.point.y - this.geometry.right.y, this.geometry.right.radius)
    } else this.knob(this.rightKnob, 0, 0, 1)
    for (const ability of ABILITIES) data(this.buttons.get(ability)!, 'held', String(snapshot[ability]))
  }

  private knob(element: HTMLElement, dx: number, dy: number, radius: number): void {
    const length = Math.hypot(dx, dy), scale = length > radius ? radius / length : 1
    const transform = `translate(${dx * scale}px, ${dy * scale}px)`
    if (element.style.transform !== transform) element.style.transform = transform
  }

  private releaseCaptures(owners: number[]): void {
    for (const id of owners) {
      try { this.surface.releasePointerCapture(id) } catch { /* Already released by the UA. */ }
    }
  }

  private listen(target: EventTarget, type: string, handler: (event: Event) => void, capture = false): void {
    target.addEventListener(type, handler, capture)
    this.removeListeners.push(() => target.removeEventListener(type, handler, capture))
  }
}
