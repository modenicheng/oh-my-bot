// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

let GameController: typeof import('./controls')['GameController']
let ReplayPlayer: typeof import('../replay/player')['ReplayPlayer']
let LiveSpectator: typeof import('../live')['LiveSpectator']

beforeAll(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('Image', class { src = '' })
  Object.defineProperty(document, 'fonts', { value: { load: () => Promise.resolve([]) }, configurable: true })
  const modules = await Promise.all([import('./controls'), import('../replay/player'), import('../live')])
  GameController = modules[0].GameController
  ReplayPlayer = modules[1].ReplayPlayer
  LiveSpectator = modules[2].LiveSpectator
}, 15000)

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('game drawing boundary', () => {
  it('renders the terminal replay frame before stopping playback', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setInterval', 'clearInterval'] })
    let running = true
    const rendered: number[] = []
    const player = Object.assign(Object.create(ReplayPlayer.prototype), {
      playing: true, tick: 59, tickF: 59, speed: 1, lastFrameTime: 0,
      index: { endTick: 60 }, el: {}, clock: undefined,
      stage: { stop: () => { running = false }, requestDraw: () => { if (running) rendered.push(player.tick) } },
      prepareFrame: vi.fn(),
      renderPreparedFrame: () => rendered.push(player.tick),
    })
    vi.advanceTimersByTime(50)
    player.pump()
    expect(player.tick).toBe(60)
    expect(player.playing).toBe(false)
    expect(rendered).toContain(60)
  })

  it('expires spectator speech without waiting for another snapshot', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
    const stage = { requestDraw: vi.fn(), dispose: vi.fn() }
    const spectator = Object.assign(Object.create(LiveSpectator.prototype), {
      bubbles: [], ended: false, disposed: false, stage,
      requestDraw: vi.fn(), session: { close() {} }, events: new AbortController(),
    })
    const say = (robot: number, text: string) => spectator.onMessage({
      payload: { case: 'event', value: { kind: { case: 'say', value: { robot, text } } } },
    })
    say(1, 'first')
    vi.advanceTimersByTime(1000)
    say(2, 'second')
    vi.advanceTimersByTime(3001)
    expect(spectator.bubbles.map((bubble: { text: string }) => bubble.text)).toEqual(['second'])
    vi.advanceTimersByTime(1000)
    expect(spectator.bubbles).toHaveLength(0)
    expect(stage.requestDraw).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    say(1, 'discard on exit')
    spectator.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('publishes prepared speech to the next draw immediately', async () => {
    const controller = Object.assign(Object.create(GameController.prototype), {
      world: {}, map: {}, active: true, ended: false, sayTicks: new Map(),
      bubbles: [], extras: { bubbles: [] }, cam: {},
      feedback: { event() {} }, renderer: { prepareBubbles: vi.fn() },
      stage: { requestDraw: vi.fn() },
    })
    controller.onMessage({
      payload: { case: 'event', value: { tick: 1, kind: { case: 'say', value: { robot: 7, text: 'hello' } } } },
    })
    expect(controller.extras.bubbles).toEqual([expect.objectContaining({ robotId: 7, text: 'hello' })])
    expect(controller.stage.requestDraw).toHaveBeenCalledOnce()
  })

  it('replay drawing also consumes a prepared frame without rebuilding its index or HUD', async () => {
    const render = vi.fn(), frame = { tick: 1 }, map = {}, cam = {}
    const player = Object.assign(Object.create(ReplayPlayer.prototype), {
      preparedFrame: frame, disposed: false, renderer: { render }, map, cam, followRobotId: 7,
      index: { frameAt: () => { throw new Error('replay indexing reached drawing') } },
      updateHud: () => { throw new Error('replay HUD reached drawing') },
    })
    player.renderPreparedFrame()
    expect(render).toHaveBeenCalledExactlyOnceWith(frame, map, cam, 7)
  })

  it('draws the prepared state without updating HUD, audio, input, or measuring layout', async () => {
    const renderer = { render: vi.fn() }
    const guard = () => { throw new Error('state preparation reached the draw callback') }
    const controller = Object.assign(Object.create(GameController.prototype), {
      map: {}, active: true, renderer, world: {}, cam: {}, extras: { bubbles: [] },
      input: { aimAt: guard, resetTakeover: guard },
      hud: { update: guard, setAssist: guard },
      upgrades: { update: guard },
      feedback: { ambience: guard },
      syncAimGuard: guard, selfHacking: guard, flashUpgradeGains: guard,
    })
    const mutation = new MutationObserver(guard)
    mutation.observe(document.body, { subtree: true, childList: true, attributes: true })
    try {
      controller.drawFrame()
      expect(renderer.render).toHaveBeenCalledExactlyOnceWith(controller.world, controller.map, controller.cam, controller.extras)
      expect(mutation.takeRecords()).toHaveLength(0)
    } finally { mutation.disconnect() }
  })
})
