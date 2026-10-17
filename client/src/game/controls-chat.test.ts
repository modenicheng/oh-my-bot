// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GameController } from './controls'

vi.mock('./render', () => ({ Renderer: class {} }))
vi.mock('./canvas-stage', () => ({ CanvasStage: class {} }))
vi.mock('./hud', () => ({ Hud: class {} }))
vi.mock('./upgrades', () => ({ UpgradePanel: class {} }))
vi.mock('./feedback', () => ({ GameFeedback: class {} }))
vi.mock('./art', () => ({ artReady: Promise.resolve() }))
vi.mock('./mobile-controls', () => ({ MobileControls: class {
  touch = false
  setEnabled(): void {}
} }))

const controllers: GameController[] = []

function fixture() {
  document.body.innerHTML = `<section><canvas tabindex="0"></canvas><div id="hud"></div>
    <form id="game-chat"><input id="game-chat-input"><output id="game-chat-count"></output>
      <button type="submit">Send</button><button type="button" id="game-chat-cancel">Cancel</button>
    </form></section>`
  const send = vi.fn()
  const controller = new GameController({
    canvas: document.querySelector('canvas')!, hudRoot: document.getElementById('hud')!, send,
  })
  Object.assign(controller, {
    chatReadyTick: 0,
    world: { initialized: true, tick: 15, self: { robotId: 1 }, robots: new Map([[1, { dead: false }]]) },
  })
  controllers.push(controller)
  const form = document.querySelector('form')!
  const input = document.querySelector('input')!
  input.value = 'Ready'
  return { send, form, input }
}

function enter(target: Element): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

afterEach(() => {
  // These tests exercise constructor-installed DOM handlers, not the rendering lifecycle.
  for (const controller of controllers.splice(0)) {
    const c = controller as unknown as { releaseOnBlur: EventListener; releaseWhenHidden: EventListener }
    window.removeEventListener('blur', c.releaseOnBlur)
    document.removeEventListener('visibilitychange', c.releaseWhenHidden)
  }
  document.body.replaceChildren()
})

describe('battle chat keyboard actions', () => {
  it('keeps Enter in the text field as a send shortcut', () => {
    const f = fixture()
    expect(enter(f.input).defaultPrevented).toBe(true)
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.form.hidden).toBe(true)
  })

  it.each(['button[type="submit"]', '#game-chat-cancel'])('preserves native Enter activation for %s', selector => {
    const f = fixture()
    expect(enter(document.querySelector(selector)!).defaultPrevented).toBe(false)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.form.hidden).toBe(false)
  })

  it('cancels without sending when the Cancel button is activated', () => {
    const f = fixture()
    document.getElementById('game-chat-cancel')!.click()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.form.hidden).toBe(true)
  })
})
