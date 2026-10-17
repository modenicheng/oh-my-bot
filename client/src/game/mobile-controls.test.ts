// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initLandscapeViewport, type LandscapeViewport } from '../app/landscape'
import { MobileControls } from './mobile-controls'

let stage: HTMLElement
let coarse: MediaQueryList
let resize: ResizeObserverCallback
let landscape: LandscapeViewport | undefined
const instances: MobileControls[] = []
const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) })
function element(selector: string): HTMLElement { return stage.querySelector<HTMLElement>(selector)! }
function pointer(target: EventTarget, type: string, id: number, x: number, y: number, extra = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { pointerId: id, clientX: x, clientY: y, pointerType: 'touch', button: 0, isPrimary: false }, extra)
  target.dispatchEvent(event)
  return event
}
function fixture() {
  const deps = {
    onInput: vi.fn(), onShot: vi.fn(), onGateChange: vi.fn(), onAssist: vi.fn(), onChat: vi.fn(), onMenu: vi.fn(),
  }
  const controls = new MobileControls(stage, deps)
  instances.push(controls)
  controls.setCapability(true)
  controls.setEnabled(true)
  return { controls, ...deps }
}

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = `<section id="view-game"><div id="game-stage">
    <canvas tabindex="0"></canvas><button id="btn-game-start">Start</button><div id="hud">
    <div id="skill-dash" data-state="ready"><span class="skill-cd">按住</span></div>
    <div id="skill-shield" data-state="cooling"><span class="skill-cd">1.23s</span></div>
    <div id="skill-uplink" data-state="off"><span class="skill-cd">靠近</span></div>
    <div id="skill-fire" data-state="ready"><span class="skill-cd">—</span></div>
    <span id="hud-assist">辅助 OFF</span><div id="hud-self-score">当前积分<strong>12</strong></div>
    <div id="hud-help" hidden>WASD 移动 · 鼠标瞄准<br><kbd>SHIFT</kbd> 冲刺</div>
    <div class="hud-upgrades"><span class="hud-up-points"><b>3</b></span><button class="hud-up-row">升级机体</button></div>
    </div></div><section id="game-options"><div class="game-options-panel"><button id="options-pause">Pause</button></div></section></section>`
  stage = document.getElementById('game-stage')!
  const query = Object.assign(new EventTarget(), { matches: true, media: '(pointer: coarse)' })
  coarse = query as unknown as MediaQueryList
  vi.stubGlobal('matchMedia', () => coarse)
  vi.stubGlobal('innerWidth', 844)
  vi.stubGlobal('innerHeight', 390)
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback }
    observe(): void {}
    disconnect(): void {}
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.mobileRole === 'move') return rect(10, 180, 260, 180)
    if (this.dataset.mobileRole === 'aim') return rect(490, 230, 120, 120)
    if (this.dataset.mobileAbility === 'dash') return rect(410, 290, 56, 56)
    if (this.dataset.mobileAbility === 'shield') return rect(410, 226, 56, 56)
    if (this.dataset.mobileAbility === 'interact') return rect(522, 160, 56, 56)
    return rect(0, 0, 844, 390)
  })
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value: vi.fn(), configurable: true })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { value: vi.fn(), configurable: true })
})
afterEach(() => {
  instances.splice(0).forEach(value => value.dispose())
  landscape?.dispose()
  landscape = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('mobile control DOM adapter', () => {
  it.each(['btn-game-start', 'options-pause'])('activates existing %s with a third touch once and cancels the held sticks', id => {
    const f = fixture(), button = document.getElementById(id)!
    const start = vi.fn(() => expect(f.onInput.mock.lastCall?.[0])
      .toMatchObject({ moveX: 0, fire: false }))
    button.addEventListener('click', start)
    pointer(element('[data-mobile-role="move"]'), 'pointerdown', 1, 100, 280)
    pointer(stage, 'pointermove', 1, 160, 280)
    pointer(element('[data-mobile-role="aim"]'), 'pointerdown', 2, 550, 290)
    pointer(stage, 'pointermove', 2, 610, 290)
    pointer(button, 'pointerdown', 3, 400, 30)
    expect(start).toHaveBeenCalledOnce()
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(start).toHaveBeenCalledOnce()
    button.click()
    expect(start).toHaveBeenCalledTimes(2)
    pointer(stage, 'pointerup', 2, 610, 290)
    expect(f.onShot).not.toHaveBeenCalled()
    f.controls.dispose()
    pointer(button, 'pointerdown', 4, 400, 30)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('focuses battle domain before input, accepts a nonprimary second thumb, captures on one stable root', () => {
    const f = fixture(), root = element('.mobile-controls')
    expect(root.hasAttribute('data-battle-control')).toBe(true)
    f.onInput.mockImplementation(() => { expect(document.activeElement).toBe(root) })
    pointer(element('[data-mobile-role="move"]'), 'pointerdown', 1, 100, 280)
    pointer(stage, 'pointermove', 1, 160, 280)
    pointer(element('[data-mobile-role="aim"]'), 'pointerdown', 2, 550, 290)
    pointer(stage, 'pointermove', 2, 610, 290)
    expect(root.setPointerCapture).toHaveBeenCalledWith(1)
    expect(root.setPointerCapture).toHaveBeenCalledWith(2)
    expect(f.onInput.mock.lastCall?.[0]).toMatchObject({ moveX: 1000, aim: 0, fire: false, axisMask: 7 })
    pointer(stage, 'pointerup', 2, 550, 350)
    pointer(stage, 'lostpointercapture', 2, 550, 350)
    expect(f.onShot).toHaveBeenCalledExactlyOnceWith(Math.PI / 2)
    expect(f.onInput.mock.lastCall?.[0].moveX).toBe(1000)
  })

  it('keeps an aim owner through ability buttons despite unavailable HUD', () => {
    const f = fixture()
    pointer(element('[data-mobile-role="aim"]'), 'pointerdown', 2, 550, 290)
    pointer(stage, 'pointermove', 2, 610, 290)
    pointer(stage, 'pointermove', 2, 438, 312)
    expect(f.onInput.mock.lastCall?.[0]).toMatchObject({ dash: false, fire: false, axisMask: 6 })
    element('#skill-dash').dataset.state = 'off'
    f.controls.update()
    pointer(stage, 'pointermove', 2, 438, 250)
    pointer(stage, 'pointerup', 2, 610, 290)
    expect(f.onInput.mock.lastCall?.[0]).toMatchObject({ dash: false, shield: false, fire: false, axisMask: 6 })
    expect(f.onShot).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('keeps a final-up aim direction even when it is inside an ability button', () => {
    const f = fixture()
    pointer(element('[data-mobile-role="aim"]'), 'pointerdown', 2, 550, 290)
    pointer(stage, 'pointermove', 2, 610, 290)
    pointer(stage, 'pointerup', 2, 438, 312)
    expect(f.onShot).toHaveBeenCalledExactlyOnceWith(Math.atan2(22, -112))
    expect(f.onInput.mock.lastCall?.[0].dash).toBe(false)
  })

  it('mode pointerdown changes once, cancels only right, persists and never starts held fire', () => {
    const f = fixture()
    pointer(element('[data-mobile-role="move"]'), 'pointerdown', 1, 100, 280)
    pointer(stage, 'pointermove', 1, 160, 280)
    pointer(element('[data-mobile-role="aim"]'), 'pointerdown', 2, 550, 290)
    pointer(stage, 'pointermove', 2, 610, 290)
    const button = element('[data-mobile-action="mode"]')
    pointer(button, 'pointerdown', 3, 400, 180)
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(button.dataset.mode).toBe('hold')
    expect(button.getAttribute('aria-label')).toContain('按住连发')
    expect(f.onInput.mock.lastCall?.[0]).toMatchObject({ moveX: 1000, fire: false })
    pointer(stage, 'pointerup', 2, 610, 290)
    expect(f.onShot).not.toHaveBeenCalled()
    f.controls.dispose()
    const next = fixture()
    expect(element('[data-mobile-action="mode"]').dataset.mode).toBe('hold')
    pointer(element('[data-mobile-role="aim"]'), 'pointerdown', 4, 550, 290)
    pointer(stage, 'pointermove', 4, 610, 290)
    expect(next.onInput.mock.lastCall?.[0].fire).toBe(true)
  })

  for (const action of ['menu', 'chat', 'assist', 'scores', 'upgrades'] as const) {
    it(`activates ${action} on a nonprimary third contact and ignores the subsequent pointer click`, () => {
      const f = fixture()
      pointer(element('[data-mobile-role="move"]'), 'pointerdown', 1, 100, 280)
      pointer(stage, 'pointermove', 1, 160, 280)
      pointer(element('[data-mobile-role="aim"]'), 'pointerdown', 2, 550, 290)
      pointer(stage, 'pointermove', 2, 610, 290)
      const button = element(`[data-mobile-action="${action}"]`)
      const count = (): number => {
        switch (action) {
          case 'menu': return f.onMenu.mock.calls.length
          case 'chat': return f.onChat.mock.calls.length
          case 'assist': return f.onAssist.mock.calls.length
          default: return Number(stage.classList.contains(`touch-${action}-open`))
        }
      }
      const event = pointer(button, 'pointerdown', 3, 400, 60)
      expect(count()).toBe(1)
      expect(event.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(button)
      expect(f.onInput.mock.lastCall?.[0]).toMatchObject({ moveX: 0, fire: false })
      pointer(button, 'pointerup', 3, 400, 60)
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
      expect(count()).toBe(1)
      // Keyboard, assistive technology and HTMLElement.click() still use detail=0.
      button.click()
      expect(count()).toBe(action === 'scores' || action === 'upgrades' ? 0 : 2)
      expect(f.onShot).not.toHaveBeenCalled()
    })
  }

  it('activates the unsupported-version menu on nonprimary pointerdown without a compatibility click', () => {
    const f = fixture()
    f.controls.setCapability(false)
    expect(element('[data-mobile-gate]').hidden).toBe(false)
    const button = element('[data-mobile-gate] [data-mobile-action="menu"]')
    pointer(button, 'pointerdown', 3, 100, 500)
    expect(f.onMenu).toHaveBeenCalledOnce()
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(f.onMenu).toHaveBeenCalledOnce()
    button.click()
    expect(f.onMenu).toHaveBeenCalledTimes(2)
  })

  it('does not activate auxiliary actions for a secondary mouse button', () => {
    const f = fixture()
    pointer(element('[data-mobile-action="menu"]'), 'pointerdown', 3, 400, 60, { pointerType: 'mouse', button: 2 })
    expect(f.onMenu).not.toHaveBeenCalled()
  })

  it('waits for the normal mouse click and does not swallow it after a touch with no click', () => {
    const f = fixture(), button = element('[data-mobile-action="menu"]')
    pointer(button, 'pointerdown', 1, 400, 60, { pointerType: 'mouse' })
    expect(f.onMenu).not.toHaveBeenCalled()
    pointer(button, 'pointerup', 1, 400, 60, { pointerType: 'mouse' })
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(f.onMenu).toHaveBeenCalledOnce()
    pointer(button, 'pointerdown', 2, 400, 60)
    expect(f.onMenu).toHaveBeenCalledTimes(2)
    pointer(button, 'pointercancel', 2, 400, 60)
    pointer(button, 'pointerdown', 3, 400, 60, { pointerType: 'mouse' })
    expect(f.onMenu).toHaveBeenCalledTimes(2)
    pointer(button, 'pointerup', 3, 400, 60, { pointerType: 'mouse' })
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(f.onMenu).toHaveBeenCalledTimes(3)
  })

  it('activates pen on down once and leaves keyboard activation available', () => {
    const f = fixture(), button = element('[data-mobile-action="menu"]')
    pointer(button, 'pointerdown', 1, 400, 60, { pointerType: 'pen' })
    expect(f.onMenu).toHaveBeenCalledOnce()
    pointer(button, 'pointerup', 1, 400, 60, { pointerType: 'pen' })
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    expect(f.onMenu).toHaveBeenCalledOnce()
    button.click()
    expect(f.onMenu).toHaveBeenCalledTimes(2)
  })

  it('disable emits a neutral with old axes even before enabled and needs a fresh down after recovery', () => {
    const f = fixture()
    pointer(element('[data-mobile-role="aim"]'), 'pointerdown', 1, 550, 290)
    pointer(stage, 'pointermove', 1, 610, 290)
    f.controls.setEnabled(false)
    expect(f.onInput.mock.lastCall?.[0]).toMatchObject({ fire: false, axisMask: 6 })
    const gates = f.onGateChange.mock.calls.length
    f.controls.setEnabled(false)
    expect(f.onGateChange).toHaveBeenCalledTimes(gates)
    f.controls.setEnabled(true)
    pointer(stage, 'pointerup', 1, 610, 290)
    expect(f.onShot).not.toHaveBeenCalled()
    f.controls.resetTakeover()
    pointer(element('[data-mobile-role="move"]'), 'pointerdown', 2, 100, 280)
    pointer(stage, 'pointermove', 2, 160, 280)
    expect(f.onInput.mock.lastCall?.[0].axisMask).toBe(1)
  })

  it('cancel paths and geometry changes never fire or revive a finger; update performs no layout reads', () => {
    const f = fixture(), reads = vi.mocked(HTMLElement.prototype.getBoundingClientRect)
    const baseline = reads.mock.calls.length
    for (let i = 0; i < 120; i++) f.controls.update()
    expect(reads).toHaveBeenCalledTimes(baseline)
    for (const cancel of [
      () => pointer(stage, 'pointercancel', 1, 610, 290),
      () => pointer(stage, 'lostpointercapture', 1, 610, 290),
      () => window.dispatchEvent(new Event('blur')),
      () => window.dispatchEvent(new Event('pagehide')),
      () => document.dispatchEvent(new Event('visibilitychange')),
      () => window.dispatchEvent(new Event('resize')),
      () => window.dispatchEvent(new Event('landscapechange')),
      () => resize([], {} as ResizeObserver),
    ]) {
      pointer(element('[data-mobile-role="aim"]'), 'pointerdown', 1, 550, 290)
      pointer(stage, 'pointermove', 1, 610, 290)
      cancel()
      pointer(stage, 'pointerup', 1, 610, 290)
    }
    expect(f.onShot).not.toHaveBeenCalled()
    expect(f.onInput.mock.lastCall?.[0].fire).toBe(false)
  })

  it('gates unsupported touch versions and keeps supported physical portrait usable on hybrids', () => {
    const f = fixture()
    f.controls.setCapability(false)
    expect(f.controls.blocked).toBe(true)
    expect(element('[data-mobile-gate]').textContent).toMatch(/版本|更新/)
    element('[data-mobile-gate] [data-mobile-action="menu"]').click()
    expect(f.onMenu).toHaveBeenCalledOnce()
    const select = document.querySelector<HTMLSelectElement>('[data-mobile-layout]')!
    expect([...select.options].map(option => option.text)).toEqual(['自动', '触控', '键鼠'])
    select.value = 'desktop'
    select.dispatchEvent(new Event('change'))
    vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 844)
    window.dispatchEvent(new Event('resize'))
    expect(f.controls.touch).toBe(false)
    expect(f.controls.blocked).toBe(false)
    select.value = 'touch'; select.dispatchEvent(new Event('change'))
    f.controls.setCapability(true)
    expect(f.controls.blocked).toBe(false)
    expect(element('[data-mobile-gate]').hidden).toBe(true)
    pointer(element('[data-mobile-role="aim"]'), 'pointerdown', 1, 550, 290)
    pointer(stage, 'pointerup', 1, 610, 290)
    expect(f.onShot).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('maps rotated pointer contacts and measured hit regions into the same logical space', () => {
    vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 844)
    const bounds = vi.mocked(HTMLElement.prototype.getBoundingClientRect)
    const logicalBounds = bounds.getMockImplementation()!
    bounds.mockImplementation(function (this: HTMLElement) {
      const logical = logicalBounds.call(this)
      return rect(390 - logical.bottom, logical.left, logical.height, logical.width)
    })
    landscape = initLandscapeViewport()
    const f = fixture()
    expect(f.controls.blocked).toBe(false)
    pointer(element('[data-mobile-role="move"]'), 'pointerdown', 1, 110, 100)
    pointer(stage, 'pointermove', 1, 110, 160)
    pointer(element('[data-mobile-role="aim"]'), 'pointerdown', 2, 100, 550)
    pointer(stage, 'pointermove', 2, 100, 610)
    expect(f.onInput.mock.lastCall?.[0]).toMatchObject({ moveX: 1000, moveY: 0, aim: 0, fire: false })
    pointer(stage, 'pointerup', 2, 40, 550)
    expect(f.onShot).toHaveBeenCalledExactlyOnceWith(Math.PI / 2)
    expect(f.onInput.mock.lastCall?.[0].moveX).toBe(1000)
    // Direct ability ownership also uses the remapped rectangle.
    pointer(element('[data-mobile-ability="shield"]'), 'pointerdown', 3, 140, 438)
    expect(f.onInput.mock.lastCall?.[0].shield).toBe(true)
    pointer(stage, 'pointerup', 3, 140, 438)
    expect(f.onInput.mock.lastCall?.[0].shield).toBe(false)
  })

  it('syncs the global landscape surface when the options layout override changes', () => {
    vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 844)
    landscape = initLandscapeViewport()
    const f = fixture(), select = document.querySelector<HTMLSelectElement>('[data-mobile-layout]')!
    expect(landscape.rotated).toBe(true)
    select.value = 'desktop'; select.dispatchEvent(new Event('change'))
    expect(f.controls.touch).toBe(false)
    expect(landscape.enabled).toBe(false)
    select.value = 'touch'; select.dispatchEvent(new Event('change'))
    expect(f.controls.touch).toBe(true)
    expect(landscape.rotated).toBe(true)
    expect(f.controls.blocked).toBe(false)
  })

  it('follows coarse pointer changes in auto mode but never uses narrow viewport alone', () => {
    const f = fixture()
    Object.defineProperty(coarse, 'matches', { value: false, configurable: true })
    coarse.dispatchEvent(new Event('change'))
    expect(f.controls.touch).toBe(false)
    vi.stubGlobal('innerWidth', 375); vi.stubGlobal('innerHeight', 667)
    window.dispatchEvent(new Event('resize'))
    expect(f.controls.touch).toBe(false)
  })

  it('suspends the version gate after battle without removing mobile layout or settings', () => {
    const f = fixture()
    vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 844)
    window.dispatchEvent(new Event('resize'))
    f.controls.setCapability(false)
    expect(element('[data-mobile-gate]').hidden).toBe(false)
    f.onGateChange.mockClear()
    f.controls.setBattleVisible(false)
    expect(element('.mobile-controls').hidden).toBe(true)
    expect(element('[data-mobile-gate]').hidden).toBe(true)
    expect(f.controls.blocked).toBe(false)
    expect(f.controls.touch).toBe(true)
    expect(stage.classList.contains('touch-battle')).toBe(true)
    expect(document.querySelector('[data-mobile-layout]')?.isConnected).toBe(true)
    expect(f.onGateChange).toHaveBeenCalledOnce()
    f.controls.setBattleVisible(false)
    expect(f.onGateChange).toHaveBeenCalledOnce()
    f.controls.update()
    f.controls.setEnabled(true)
    window.dispatchEvent(new Event('resize'))
    coarse.dispatchEvent(new Event('change'))
    f.controls.setCapability(true)
    expect(element('.mobile-controls').hidden).toBe(true)
    expect(element('[data-mobile-gate]').hidden).toBe(true)
    f.controls.setBattleVisible(true)
    expect(element('.mobile-controls').hidden).toBe(false)
    expect(element('[data-mobile-gate]').hidden).toBe(true)
    expect(f.controls.blocked).toBe(false)
  })

  it('hiding the battle cancels gestures before hiding and cannot resume an old finger', () => {
    const f = fixture()
    pointer(element('[data-mobile-role="aim"]'), 'pointerdown', 1, 550, 290)
    pointer(stage, 'pointermove', 1, 610, 290)
    f.onInput.mockImplementation(snapshot => {
      expect(element('.mobile-controls').hidden).toBe(false)
      expect(snapshot).toMatchObject({ fire: false, axisMask: 6 })
    })
    f.controls.setBattleVisible(false)
    f.onInput.mockReset()
    pointer(element('[data-mobile-role="aim"]'), 'pointerdown', 2, 550, 290)
    pointer(stage, 'pointermove', 2, 610, 290)
    pointer(stage, 'pointerup', 1, 610, 290)
    expect(f.onInput).not.toHaveBeenCalled()
    f.controls.setBattleVisible(true)
    pointer(stage, 'pointerup', 2, 610, 290)
    expect(f.onShot).not.toHaveBeenCalled()
    pointer(element('[data-mobile-role="aim"]'), 'pointerdown', 3, 550, 290)
    pointer(stage, 'pointerup', 3, 610, 290)
    expect(f.onShot).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('closes touch drawers on battle hide without discarding their controls', () => {
    const f = fixture()
    element('[data-mobile-action="upgrades"]').click()
    expect(stage.classList.contains('touch-upgrades-open')).toBe(true)
    f.controls.setBattleVisible(false)
    expect(stage.classList.contains('touch-upgrades-open')).toBe(false)
    expect(element('[data-mobile-action="upgrades"]').getAttribute('aria-expanded')).toBe('false')
    f.controls.setBattleVisible(true)
    expect(f.controls.blocked).toBe(false)
    element('[data-mobile-action="scores"]').click()
    f.controls.setBattleVisible(false)
    expect(stage.classList.contains('touch-scores-open')).toBe(false)
    expect(element('[data-mobile-action="scores"]').getAttribute('aria-expanded')).toBe('false')
  })

  it('closes a touch drawer from the outside without starting a new battle gesture', () => {
    const f = fixture()
    element('[data-mobile-action="upgrades"]').click()
    expect(f.controls.blocked).toBe(true)
    const event = pointer(stage, 'pointerdown', 9, 700, 80)
    expect(event.defaultPrevented).toBe(false)
    expect(stage.classList.contains('touch-upgrades-open')).toBe(false)
    expect(element('[data-mobile-action="upgrades"]').getAttribute('aria-expanded')).toBe('false')
    expect(f.onInput.mock.lastCall?.[0]).toMatchObject({ moveX: 0, fire: false, dash: false, shield: false })
    expect(f.controls.blocked).toBe(false)
    pointer(stage, 'pointermove', 9, 610, 290)
    expect(f.onShot).not.toHaveBeenCalled()
  })

  it('mirrors authoritative HUD states, reason and takeover without fake cooldown or disabled release', () => {
    const f = fixture()
    f.controls.update()
    const shield = element('[data-mobile-ability="shield"]') as HTMLButtonElement
    expect(shield.dataset.state).toBe('cooling')
    expect(shield.textContent).toContain('1.23s')
    expect(shield.disabled).toBe(false)
    expect(element('[data-mobile-ability="interact"]').getAttribute('aria-label')).toContain('靠近')
    element('#skill-shield').dataset.takeover = 'script'
    f.controls.update()
    expect(shield.dataset.takeover).toBe('script')
    expect(element('[data-mobile-action="scores"]').textContent).toBe('积分')
    expect(element('[data-mobile-action="scores"]').getAttribute('aria-label')).toContain('12')
    expect(element('[data-mobile-action="upgrades"]').textContent).toContain('3')
  })

  it('keeps the scores button compact as the authoritative score grows', () => {
    const f = fixture(), score = element('#hud-self-score strong'), button = element('[data-mobile-action="scores"]')
    for (const value of ['—', '1234567890']) {
      score.textContent = value
      f.controls.update()
      expect(button.textContent).toBe('积分')
      expect(button.getAttribute('aria-label')).toBe(`积分排行，当前积分 ${value}`)
    }
  })

  it('owns a touch help disclosure in options without changing desktop help nodes', () => {
    const panel = element('#hud-help'), original = Array.from(panel.childNodes)
    const f = fixture()
    const help = document.querySelector<HTMLDetailsElement>('#game-options .mobile-help')!
    expect(help).not.toBeNull()
    expect(help.querySelector('summary')?.textContent).toBe('触控操作帮助')
    // GameOptions includes explicit tabindex nodes in its modal focus loop.
    expect(help.querySelector('summary')?.getAttribute('tabindex')).toBe('0')
    expect(help.textContent).toContain('左摇杆移动')
    expect(help.textContent).toContain('松手单发')
    expect(help.textContent).toContain('按住连发')
    expect(help.textContent).toContain('经过技能按钮')
    expect(help.textContent).not.toMatch(/WASD|SHIFT|鼠标/)
    expect(Array.from(panel.childNodes)).toEqual(original)
    expect(panel.hidden).toBe(true)
    expect(help.open).toBe(false)
    expect(help.hidden).toBe(false)
    const select = document.querySelector<HTMLSelectElement>('[data-mobile-layout]')!
    help.open = true
    select.value = 'desktop'; select.dispatchEvent(new Event('change'))
    expect(help.hidden).toBe(true)
    expect(help.open).toBe(false)
    expect(Array.from(panel.childNodes)).toEqual(original)
    select.value = 'touch'; select.dispatchEvent(new Event('change'))
    expect(help.hidden).toBe(false)
    expect(document.querySelectorAll('.mobile-help')).toHaveLength(1)
    f.controls.dispose()
    expect(document.querySelector('.mobile-help')).toBeNull()
    expect(Array.from(panel.childNodes)).toEqual(original)
  })

  it('uses distinct icons and accessible mode labels without visible mode text', () => {
    const f = fixture(), button = element('[data-mobile-action="mode"]')
    expect(button.textContent).toBe('')
    expect(button.dataset.mode).toBe('single')
    expect(button.getAttribute('aria-label')).toContain('松手单发')
    const single = button.querySelector('svg path')!.getAttribute('d')
    button.click()
    expect(button.textContent).toBe('')
    expect(button.dataset.mode).toBe('hold')
    expect(button.getAttribute('aria-label')).toContain('按住连发')
    expect(button.querySelector('svg path')!.getAttribute('d')).not.toBe(single)
    expect(f.onShot).not.toHaveBeenCalled()
  })

  it('keeps ability icons, numeric feedback and full accessible reasons through state changes', () => {
    const f = fixture()
    for (const ability of ['dash', 'shield', 'interact']) {
      const button = element(`[data-mobile-ability="${ability}"]`)
      expect(button.querySelector('svg')).not.toBeNull()
      expect(button.querySelector('.mobile-control-caption')).toBeNull()
      expect(button.querySelector('.mobile-ability-status')?.getAttribute('aria-hidden')).toBe('true')
    }
    const source = element('#skill-shield'), shield = element('[data-mobile-ability="shield"]')
    expect(shield.textContent).toBe('1.23s')
    expect(shield.getAttribute('aria-label')).toBe('护盾 · 1.23s')
    source.dataset.state = 'active'
    source.querySelector('.skill-cd')!.textContent = '开启中'
    f.controls.update()
    expect(shield.textContent).toBe('')
    expect(shield.dataset.state).toBe('active')
    expect(shield.getAttribute('aria-label')).toBe('护盾 · 开启中')
    source.dataset.state = 'off'
    source.querySelector('.skill-cd')!.textContent = '能量低'
    f.controls.update()
    expect(shield.textContent).toBe('')
    expect(shield.getAttribute('aria-label')).toBe('护盾 · 能量低')
    expect(shield.getAttribute('aria-disabled')).toBe('true')
    expect((shield as HTMLButtonElement).disabled).toBe(false)
    element('#skill-uplink').dataset.state = 'active'
    element('#skill-uplink .skill-cd').textContent = '48%'
    f.controls.update()
    expect(element('[data-mobile-ability="interact"]').textContent).toBe('48%')
  })

  it('keeps the home fullscreen control separate from battle touch controls', () => {
    const f = fixture()
    expect(stage.querySelector('[data-mobile-action="fullscreen"]')).toBeNull()
    expect(f.controls.blocked).toBe(false)
  })

  it('omits mobile fullscreen controls while retaining the unsupported-version options action', () => {
    const f = fixture()
    expect(stage.querySelector('[data-mobile-action="fullscreen"]')).toBeNull()
    expect(stage.querySelector('[data-mobile-action="landscape"]')).toBeNull()
    f.controls.setCapability(false)
    expect(element('[data-mobile-gate]').textContent).toContain('版本不兼容')
    element('[data-mobile-gate] [data-mobile-action="menu"]').click()
    expect(f.onMenu).toHaveBeenCalledOnce()
  })

  it('auxiliary actions cancel before callbacks; drawers gate battle and recover with fresh contact', () => {
    const f = fixture()
    pointer(element('[data-mobile-role="move"]'), 'pointerdown', 1, 100, 280)
    pointer(stage, 'pointermove', 1, 160, 280)
    element('[data-mobile-action="upgrades"]').click()
    expect(stage.classList.contains('touch-upgrades-open')).toBe(true)
    expect(f.controls.blocked).toBe(true)
    expect(f.onInput.mock.lastCall?.[0].moveX).toBe(0)
    expect(f.onGateChange).toHaveBeenCalled()
    element('[data-mobile-action="upgrades"]').click()
    expect(f.controls.blocked).toBe(false)
    element('[data-mobile-action="scores"]').click()
    expect(stage.classList.contains('touch-scores-open')).toBe(true)
    expect(f.controls.blocked).toBe(true)
    element('[data-mobile-action="scores"]').click()
    element('[data-mobile-action="assist"]').click()
    element('[data-mobile-action="chat"]').click()
    element('[data-mobile-action="menu"]').click()
    expect(f.onAssist).toHaveBeenCalledOnce()
    expect(f.onChat).toHaveBeenCalledOnce()
    expect(f.onMenu).toHaveBeenCalledOnce()
  })

  it('removes owned DOM, observers and listeners idempotently, leaving shared HUD untouched', () => {
    const f = fixture()
    f.controls.dispose(); f.controls.dispose()
    const count = f.onInput.mock.calls.length
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('blur'))
    pointer(stage, 'pointerdown', 1, 550, 290)
    expect(f.onInput).toHaveBeenCalledTimes(count)
    expect(stage.querySelector('.mobile-controls')).toBeNull()
    expect(document.querySelector('[data-mobile-layout]')).toBeNull()
    expect(element('#skill-dash')).not.toBeNull()
    expect(stage.classList.contains('touch-battle')).toBe(false)
  })
})

describe('mobile CSS boundary', () => {
  const css = readFileSync('client/src/game/mobile-controls.css', 'utf8')

  const rule = (selector: string, source = css): Record<string, string> => {
    const start = source.indexOf(`${selector} {`)
    if (start < 0) throw new Error(`Missing CSS rule: ${selector}`)
    const body = source.slice(source.indexOf('{', start) + 1, source.indexOf('}', start))
    return Object.fromEntries(body.split(';').filter(part => part.includes(':')).map(part => {
      const colon = part.indexOf(':')
      return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()]
    }))
  }

  // Evaluate only the trusted stylesheet's length math, not browser layout. Real
  // browser checks additionally catch font sizing, cascade and hit-test occlusion.
  function length(value: string, basis: number, variables: Record<string, string>, insets: Record<string, number>): number {
    const expression = value
      .replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
        if (variables[name] === undefined) throw new Error(`Missing CSS variable: ${name}`)
        return `(${length(variables[name], basis, variables, insets)})`
      })
      .replace(/var\(--app-safe-(\w+),\s*env\(safe-area-inset-\w+,\s*0px\)\)/g, (_, edge: string) => String(insets[edge] ?? 0))
      .replace(/env\(safe-area-inset-(\w+),\s*0px\)/g, (_, edge: string) => String(insets[edge] ?? 0))
      .replace(/([\d.]+)%/g, (_, percent: string) => String(Number(percent) / 100 * basis))
      .replace(/px\b/g, '').replace(/calc\(/g, '(')
    if (!/^[\d\s.,()+*/-]+$/.test(expression.replace(/min|max/g, ''))) throw new Error(`Unsupported CSS length: ${value}`)
    return Function('min', 'max', `"use strict"; return (${expression})`)(Math.min, Math.max) as number
  }

  it('exposes injectable safe insets shared by controls and HUD with env defaults', () => {
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      expect(css).toContain(`--mobile-safe-${edge}: var(--app-safe-${edge}, env(safe-area-inset-${edge}, 0px))`)
      expect(css.match(new RegExp(`env\\(safe-area-inset-${edge},`, 'g'))).toHaveLength(1)
    }
  })

  it('hides only battlefield help, replay and audio entries while preserving host controls and options audio', () => {
    const hidden = rule('#game-stage.touch-battle .game-help,\n#game-stage.touch-battle #btn-game-replay,\n#game-stage.touch-battle #audio-settings')
    expect(hidden.display).toBe('none')
    expect(css).not.toMatch(/#btn-game-start[^}]*display:\s*none/)
    expect(css).not.toMatch(/\.game-options-audio[^}]*display:\s*none/)
  })

  it('keeps the mobile upgrade drawer compact', () => {
    expect(rule('#game-stage.touch-battle.touch-upgrades-open .hud-upgrades').width)
      .toBe('min(300px, calc(100cqw - 24px))')
  })

  it('keeps the low-use firing mode switch small and close to the right stick', () => {
    expect(rule('.mobile-controls')['--right-cluster-width']).toBe('calc(var(--stick-size) + 96px)')
    const mode = rule(".mobile-controls [data-mobile-action='mode']")
    expect(mode.right).toBe('calc(var(--stick-size) + 48px)')
    expect(mode.width).toBe('44px')
    expect(mode.height).toBe('44px')
  })

  it('anchors phase and countdown to the safe top edge and makes the core-open banner compact', () => {
    expect(rule('#game-stage.touch-battle .hud-top').top).toBe('calc(var(--mobile-safe-top) + 8px)')
    const banner = rule('#game-stage.touch-battle #hud-inner-ring')
    expect(banner.top).toBe('calc(var(--mobile-safe-top) + 60px)')
    expect(banner.padding).toBe('8px 10px')
    expect(rule('#game-stage.touch-battle #hud-inner-ring strong')['font-size']).toBe('16px')
    expect(rule('.mobile-help > summary')['min-height']).toBe('44px')
  })

  it('keeps controls visible under a rotated logical landscape and bounds options help by logical height', () => {
    expect(css).not.toContain('@media (orientation: portrait)')
    expect(css).not.toContain('@media (max-height:')
    expect(css).toContain('var(--app-height, 100dvh)')
    expect(rule('.mobile-help p')['overflow-wrap']).toBe('anywhere')
  })

  for (const [width, height] of [[667, 375], [844, 390], [932, 430], [1024, 768]] as const) {
    for (const safe of [0, 47]) {
      it(`separates all lower touch targets at ${width}x${height} with side inset ${safe}`, () => {
        const insets = { top: 0, left: safe, right: safe, bottom: safe ? 21 : 0 }
        const variables = { ...rule('.mobile-controls') }
        if (css.includes('.touch-battle {')) Object.assign(variables, rule('.touch-battle'))
        let moveRule = rule('.mobile-move-zone')
        if (width <= 760) {
          const compact = css.slice(css.indexOf('@container (max-width: 760px)'))
          Object.assign(variables, rule('.mobile-controls', compact))
          moveRule = { ...moveRule, ...rule('.mobile-move-zone', compact) }
        }
        type Box = { x: number; y: number; width: number; height: number }
        const box = (style: Record<string, string>, parent: Box): Box => {
          const w = length(style.width ?? '0px', parent.width, variables, insets)
          const h = length(style.height ?? style['min-height'] ?? '0px', parent.height, variables, insets)
          return {
            x: parent.x + (style.left === undefined ? parent.width - w - length(style.right ?? '0px', parent.width, variables, insets)
              : length(style.left, parent.width, variables, insets)),
            y: parent.y + (style.top === undefined ? parent.height - h - length(style.bottom ?? '0px', parent.height, variables, insets)
              : length(style.top, parent.height, variables, insets)),
            width: w, height: h,
          }
        }
        const stageBox = { x: 0, y: 0, width, height }
        const cluster = box(rule('.mobile-right-cluster'), stageBox)
        const move = box(moveRule, stageBox)
        const targets: Array<Box & { name: string }> = [
          { ...move, name: 'move' },
          { ...box({ ...rule('.mobile-stick'), ...rule('.mobile-aim-stick') }, cluster), name: 'aim' },
          { ...box(rule(".mobile-controls [data-mobile-action='mode']"), cluster), name: 'mode' },
          ...['dash', 'shield', 'interact'].map(name => ({
            ...box({ ...rule('.mobile-controls .mobile-ability'), ...rule(`.mobile-ability[data-mobile-ability='${name}']`) }, cluster), name,
          })),
        ]
        const stickSize = length(variables['--stick-size']!, width, variables, insets)
        expect(move.width).toBeGreaterThanOrEqual(stickSize)
        expect(move.height).toBeGreaterThanOrEqual(stickSize)
        for (const [i, a] of targets.entries()) {
          expect(a.width, `${a.name} touch width`).toBeGreaterThanOrEqual(44)
          expect(a.height, `${a.name} touch height`).toBeGreaterThanOrEqual(44)
          expect(a.x, `${a.name} left safe edge`).toBeGreaterThanOrEqual(insets.left + 8)
          expect(a.x + a.width, `${a.name} right safe edge`).toBeLessThanOrEqual(width - insets.right - 8)
          expect(a.y + a.height, `${a.name} bottom safe edge`).toBeLessThanOrEqual(height - insets.bottom - 8)
          for (const b of targets.slice(i + 1)) {
            const gapX = Math.max(0, a.x - b.x - b.width, b.x - a.x - a.width)
            const gapY = Math.max(0, a.y - b.y - b.height, b.y - a.y - a.height)
            expect(Math.hypot(gapX, gapY), `${a.name}/${b.name} separation`).toBeGreaterThanOrEqual(8)
          }
        }
      })
    }
  }

  it('scopes gesture suppression, uses safe areas/compact stage layout and does not rotate the document', () => {
    for (const edge of ['top', 'right', 'bottom', 'left']) expect(css).toContain(`safe-area-inset-${edge}`)
    expect(css).toContain('touch-action: none')
    expect(css).toContain('@container')
    expect(css).toContain('touch-upgrades-open')
    expect(css).toContain('touch-scores-open')
    expect(css).not.toMatch(/(?:html|body)\s*\{|rotate\(/)
  })
})
