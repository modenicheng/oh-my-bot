// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { ServerMsgSchema } from '@omb/protocol'
import type { GameController as GameControllerInstance } from './controls'
import { InputSampler } from './input'
import { Camera } from './camera'

vi.mock('./render', () => ({
  Renderer: class {
    prepare = vi.fn()
    resize = vi.fn()
    dispose = vi.fn()
    prepareBubbles = vi.fn()
  },
  phaseName: () => 'phase',
}))
vi.mock('./canvas-stage', () => ({
  CanvasStage: class {
    dpr = 1
    start() {}
    stop() {}
    requestDraw() {}
    syncSize() {}
  },
}))
vi.mock('./feedback', () => ({
  GameFeedback: class {
    reset() {}
    pause() {}
    snapshot() {}
    event() {}
    cameraZoom() { return 1 }
    delayedHealth(_id: number, health: number) { return health / 10 }
    ambience() {}
  },
}))
vi.mock('./art', () => ({ artReady: Promise.resolve(), prepareArt() {} }))

let GameController: typeof import('./controls')['GameController']
const html = readFileSync('client/index.html', 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
const controllers: GameControllerInstance[] = []
const mapJson = JSON.stringify({
  arena_radius: 80,
  walls: [{ id: 1, min: { X: -1, Y: -1 }, max: { X: 1, Y: 1 } }],
  uplinks: [{ id: 1, pos: { X: 5, Y: 5 } }],
})

beforeAll(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  GameController = (await import('./controls')).GameController
})

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.exit()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

function fixture(host = true) {
  vi.useFakeTimers()
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/)![1]!
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement
  const hudRoot = document.getElementById('hud')!
  const send = vi.fn(), onNextRound = vi.fn()
  const controller = new GameController({
    canvas, hudRoot, send, hostSpectator: () => true, canStartNextRound: () => host, onNextRound,
  })
  controllers.push(controller)
  expect(controller.onMapBootstrap(mapJson)).toBe(true)
  controller.onMessage(create(ServerMsgSchema, { payload: { case: 'snapshot', value: {
    tick: 1, full: true, phase: 1, timeLeftS: 10,
    robots: [{ base: { id: 7, pos: { x: 70, y: 60 } }, nick: 'player', hpX10: 1000, energyX10: 1000 }],
  } } }))
  return { controller, canvas, hudRoot, send, onNextRound }
}

describe('host spectator controller', () => {
  it('never attaches or samples player input, even when focus and keyboard actions are requested', () => {
    const attach = vi.spyOn(InputSampler.prototype, 'attach'), sample = vi.spyOn(InputSampler.prototype, 'sample')
    const { controller, canvas, send } = fixture()
    controller.setInputEnabled(true)
    controller.setActive(false)
    controller.setActive(true)
    canvas.focus()
    canvas.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }))
    canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }))
    controller.buyUpgrade(1)
    controller.toggleAssist()
    controller.seizeAim()
    expect(controller.activateAssist()).toBe(false)
    controller.openChat()
    const chat = document.getElementById('game-chat') as HTMLFormElement
    // A forced form submit is also fenced, independently of visibility.
    chat.hidden = false
    ;(document.getElementById('game-chat-input') as HTMLInputElement).value = 'blocked'
    chat.dispatchEvent(new Event('submit', { cancelable: true }))
    vi.advanceTimersByTime(250)
    expect(attach).not.toHaveBeenCalled()
    expect(sample).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(document.querySelector('.mobile-controls')).toBeNull()
  })

  it('accepts full-world snapshots without self and keeps the global scores renderable', () => {
    const { controller, hudRoot } = fixture()
    controller.onMessage(create(ServerMsgSchema, { payload: { case: 'event', value: { kind: {
      case: 'scoreboard', value: { tick: 1, rows: [{ robot: 7, nick: 'player', score: 20 }] },
    } } } }))
    expect(hudRoot.dataset.hostSpectator).toBe('true')
    expect(hudRoot.querySelector('.score-name')?.textContent).toBe('player')
    expect(hudRoot.querySelector('.score-value')?.textContent).toBe('20')
    expect(hudRoot.querySelector<HTMLElement>('.hud-upgrades')!.hidden).toBe(true)
    expect(hudRoot.querySelector<HTMLElement>('.hud-death')!.hidden).toBe(true)
    expect(hudRoot.querySelector('#hud-time')?.textContent).toBe('0:10')
  })

  it('offers the next round only to the host and clears results only on a new server map', () => {
    const { controller, hudRoot, onNextRound } = fixture()
    controller.onMessage(create(ServerMsgSchema, { payload: { case: 'event', value: { kind: {
      case: 'matchEnd', value: { scores: [{ robot: 7, nick: 'player', score: 20 }] },
    } } } }))
    const next = hudRoot.querySelector<HTMLButtonElement>('.end-next')!
    next.click()
    next.click()
    expect(onNextRound).toHaveBeenCalledOnce()
    expect(controller.isMatchEndShown()).toBe(true)
    expect(hudRoot.querySelector('.end-personal')).toBeNull()
    expect(controller.onMapBootstrap(mapJson)).toBe(true)
    expect(controller.isMatchEndShown()).toBe(false)
    expect(hudRoot.querySelector('.end-overlay')).toBeNull()
  })

  it('does not expose host settlement actions to a non-host connection', () => {
    const { controller, hudRoot } = fixture(false)
    controller.onMessage(create(ServerMsgSchema, { payload: { case: 'event', value: { kind: { case: 'matchEnd', value: {} } } } }))
    expect(hudRoot.querySelector('.end-next')).toBeNull()
    expect(hudRoot.querySelector('.end-back')).not.toBeNull()
  })

  it('fits the full arena at desktop and mobile canvas sizes', () => {
    const camera = new Camera()
    for (const [width, height] of [[1280, 800], [844, 390], [390, 844]]) {
      camera.resize(width!, height!, 80)
      camera.follow(70, 60)
      camera.fitWorld()
      expect(camera.cx).toBe(0)
      expect(camera.cy).toBe(0)
      expect(camera.toPxX(-80)).toBeGreaterThanOrEqual(0)
      expect(camera.toPxX(80)).toBeLessThanOrEqual(width!)
      expect(camera.toPxY(-80)).toBeGreaterThanOrEqual(0)
      expect(camera.toPxY(80)).toBeLessThanOrEqual(height!)
    }
  })
})
