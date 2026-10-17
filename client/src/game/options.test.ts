// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GameOptions, isOptionsEscape, nextFocusIndex, type OptionsKey } from './options'

vi.mock('../audio', () => ({
  audio: { mutedOf: () => false, volumeOf: () => 0.45, setMuted: vi.fn(), setVolume: vi.fn() },
}))

const escape = (patch: Partial<OptionsKey> = {}): OptionsKey => ({
  code: 'Escape', repeat: false, isComposing: false, keyCode: 27,
  ctrlKey: false, altKey: false, metaKey: false, defaultPrevented: false,
  ...patch,
})

describe('game options keyboard policy', () => {
  it('opens only for a fresh unconsumed Escape key', () => {
    expect(isOptionsEscape(escape())).toBe(true)
    expect(isOptionsEscape(escape({ repeat: true }))).toBe(false)
    expect(isOptionsEscape(escape({ isComposing: true }))).toBe(false)
    expect(isOptionsEscape(escape({ keyCode: 229 }))).toBe(false)
    expect(isOptionsEscape(escape({ defaultPrevented: true }))).toBe(false)
    expect(isOptionsEscape(escape({ ctrlKey: true }))).toBe(false)
    expect(isOptionsEscape(escape({ code: 'Enter' }))).toBe(false)
  })

  it('wraps focus only at the first and last menu controls', () => {
    expect(nextFocusIndex(5, 4, false)).toBe(0)
    expect(nextFocusIndex(5, 0, true)).toBe(4)
    expect(nextFocusIndex(5, 2, false)).toBe(3)
    expect(nextFocusIndex(5, -1, false)).toBe(0)
    expect(nextFocusIndex(0, -1, false)).toBe(-1)
  })
})

function optionsFixture() {
  document.body.innerHTML = `<button id="open-options">选项</button>
    <section id="game-options" role="dialog" aria-modal="true" hidden>
      <div class="game-options-panel">
        <button id="options-continue">继续</button>
        <button id="options-sfx-mute">静音</button><input id="options-sfx-volume" type="range"><output id="options-sfx-value"></output>
        <button id="options-bgm-mute">静音</button><input id="options-bgm-volume" type="range"><output id="options-bgm-value"></output>
        <fieldset id="options-host"><button id="options-pause">暂停</button><button id="options-finish">结算</button></fieldset>
        <button id="options-leave">离开</button><button id="options-logout">注销</button>
      </div>
    </section>`
  const deps = {
    canOpen: () => true, onOpen: vi.fn(), onClose: vi.fn(), onLeave: vi.fn(),
    onLogout: vi.fn(), onPauseToggle: vi.fn(), onFinish: vi.fn(),
  }
  const menu = new GameOptions(deps)
  const trigger = document.getElementById('open-options')!
  trigger.focus()
  expect(menu.open()).toBe(true)
  return {
    menu, deps, trigger, root: document.getElementById('game-options')!,
    panel: document.querySelector<HTMLElement>('.game-options-panel')!,
  }
}

function pointer(target: HTMLElement, type: string, pointerId = 1): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId, button: 0, pointerType: 'touch' }))
}

afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks() })

describe('game options backdrop dismissal', () => {
  it('closes on a completed backdrop click and restores the opening control focus once', () => {
    const { menu, root, trigger, deps } = optionsFixture()
    expect(document.activeElement?.id).toBe('options-continue')
    pointer(root, 'pointerdown')
    pointer(root, 'pointerup')
    expect(menu.isOpen).toBe(true)
    root.click()
    expect(menu.isOpen).toBe(false)
    expect(document.activeElement).toBe(trigger)
    expect(deps.onClose).toHaveBeenCalledOnce()
    root.click()
    expect(deps.onClose).toHaveBeenCalledOnce()
  })

  it.each(['panel click', 'drag from panel', 'drag into panel', 'cancelled pointer', 'different pointer'])(
    'keeps the dialog open after a %s', gesture => {
      const { menu, root, panel, deps } = optionsFixture()
      pointer(gesture === 'panel click' || gesture === 'drag from panel' ? panel : root, 'pointerdown')
      if (gesture === 'cancelled pointer') pointer(root, 'pointercancel')
      else pointer(gesture === 'panel click' || gesture === 'drag into panel' ? panel : root, 'pointerup', gesture === 'different pointer' ? 2 : 1)
      // A drag's click may target the common backdrop ancestor in the browser.
      ;(gesture === 'panel click' ? panel : root).click()
      expect(menu.isOpen).toBe(true)
      expect(deps.onClose).not.toHaveBeenCalled()
    },
  )

  it('clears backdrop gesture state when the dialog is reopened', () => {
    const { menu, root, deps } = optionsFixture()
    pointer(root, 'pointerdown')
    pointer(root, 'pointerup')
    menu.close()
    menu.open()
    root.click()
    expect(menu.isOpen).toBe(true)
    expect(deps.onClose).toHaveBeenCalledOnce()
  })

  it('keeps the existing continue, Escape and leave actions', () => {
    const { menu, trigger, root, deps } = optionsFixture()
    document.getElementById('options-continue')!.click()
    expect(menu.isOpen).toBe(false)
    expect(document.activeElement).toBe(trigger)
    menu.open()
    root.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', code: 'Escape' }))
    expect(menu.isOpen).toBe(false)
    expect(document.activeElement).toBe(trigger)
    expect(deps.onClose).toHaveBeenCalledTimes(2)
    menu.open()
    document.getElementById('options-leave')!.click()
    expect(menu.isOpen).toBe(false)
    expect(deps.onLeave).toHaveBeenCalledOnce()
    expect(deps.onClose).toHaveBeenCalledTimes(2)
  })
})
