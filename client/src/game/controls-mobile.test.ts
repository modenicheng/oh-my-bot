// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Camera } from './camera'
import { InputSampler } from './input'
import { ClientMsgSchema, ServerMsgSchema } from '@omb/protocol'
import { create, fromBinary } from '@bufbuild/protobuf'
import { emptyWorld } from './world'
import { TouchState } from './input/touch-state'

let GameController: typeof import('./controls')['GameController']
beforeAll(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('Image', class { src = '' })
  Object.defineProperty(document, 'fonts', { value: { load: () => Promise.resolve([]) }, configurable: true })
  GameController = (await import('./controls')).GameController
})

function controller() {
  const input = new InputSampler()
  const canvas = document.createElement('canvas')
  input.attach(canvas, new Camera())
  input.setTouchMode(true)
  return Object.assign(Object.create(GameController.prototype), {
    input, canvas, inputEnabled: true, active: true, ended: false, map: {},
    world: { initialized: true, tick: 15, self: { robotId: 1 }, robots: new Map([[1, { dead: false }]]) },
    mobile: { touch: true, blocked: false, cancel: vi.fn(), resetTakeover: vi.fn(), setEnabled: vi.fn(), update: vi.fn() },
    sampleAndSend: vi.fn(), stage: { requestDraw: vi.fn() },
    shotSupported: true, inputGeneration: 3, send: vi.fn(),
    pendingShots: new Set<number>(),
  })
}

function lifecycleController() {
  const c = Object.assign(controller(), {
    world: emptyWorld(), resyncAt: -Infinity, requestedInput: true,
    scores: { observe: vi.fn() }, feedback: { snapshot: vi.fn(), pause: vi.fn() },
    preparePresentation: vi.fn(), syncAimGuard: vi.fn(), closeChat: vi.fn(),
  })
  const touch = new TouchState({
    left: { left: 0, top: 0, width: 200, height: 150 }, moveRadius: 50,
    right: { x: 400, y: 100, radius: 50 }, abilities: {},
  })
  Object.assign(c.mobile, {
    resetTakeover: vi.fn(() => touch.resetTakeover()),
    cancel: vi.fn(() => touch.cancel()),
    setCapability: vi.fn(), setBattleVisible: vi.fn(),
    setEnabled: vi.fn((enabled: boolean) => { if (!enabled) touch.cancel() }),
  })
  const snapshot = (tick: number, generation = 3, full = true, baseTick = 0, dead = false) => {
    c.onMessage(create(ServerMsgSchema, { payload: { case: 'snapshot', value: {
      tick, full, baseTick, self: { robotId: 1, inputGeneration: generation },
      robots: [{ base: { id: 1, pos: { x: 0, y: 0 } }, dead }],
    } } }))
  }
  snapshot(15)
  const hold = () => {
    touch.pointerDown(11, 100, 75)
    touch.pointerMove(11, 150, 75)
    touch.pointerDown(22, 400, 100)
    touch.pointerMove(22, 450, 100)
    c.applyMobileInput(touch.snapshot)
  }
  return { c, touch, snapshot, hold }
}

describe('mobile controller boundary', () => {
  it('samples touch control through the shared input facade', () => {
    const c = controller()
    c.applyMobileInput({ moveX: 500, moveY: 0, aim: 1, fire: false, dash: false, shield: false, interact: false, axisMask: 7 })
    expect(c.input.sample(0, 0).msg).toMatchObject({ moveX: 500, aim: 1, fire: false, axisMask: 7 })
    expect(c.sampleAndSend).toHaveBeenCalledOnce()
    c.input.detach()
  })

  it('rejects new touch holds when input is gated', () => {
    const c = controller()
    c.inputEnabled = false
    c.applyMobileInput({ moveX: 1000, moveY: 0, fire: true, dash: true, shield: false, interact: false, axisMask: 15 })
    expect(c.input.sample(0, 0).active).toBe(false)
    expect(c.sampleAndSend).not.toHaveBeenCalled()
    c.input.detach()
  })

  it('rejects touches while dead even before the next presentation refresh', () => {
    const c = controller()
    c.world.robots.get(1).dead = true
    c.applyMobileInput({ moveX: 1000, moveY: 0, fire: true, dash: true, shield: false, interact: false, axisMask: 15 })
    expect(c.input.sample(0, 0).active).toBe(false)
    expect(c.sampleAndSend).not.toHaveBeenCalled()
    c.input.detach()
  })

  it('cancels physical pointer state before handing axes back to Assist', () => {
    const c = controller()
    c.input.assistOn = true
    c.world.self.manualAxesMask = 7
    c.syncAimGuard = vi.fn()
    c.send = vi.fn()
    c.hud = { setAssist: vi.fn(), flashMsg: vi.fn() }
    c.toggleAssist()
    expect(c.mobile.resetTakeover).toHaveBeenCalledOnce()
    expect(c.input.sample(0, 0).active).toBe(false)
    c.input.detach()
  })

  it('sends one discrete release atomically with neutral held fire and captured heading', () => {
    const c = controller()
    c.input.applyTouch({ moveX: 500, moveY: 0, aim: -1, fire: true, dash: false, shield: false, interact: false, axisMask: 7 })
    c.submitMobileShot(1.2)
    expect(c.send).toHaveBeenCalledOnce()
    const payload = fromBinary(ClientMsgSchema, c.send.mock.calls[0][0].subarray(1)).payload
    expect(payload.case).toBe('input')
    expect(payload.value).toMatchObject({ seq: 1, moveX: 500, aim: 1.2, fire: false, axisMask: 7,
      singleShot: { aim: 1.2, observedTick: 15, generation: 3 } })
    expect(c.input.sample(0, 0).msg.fire).toBe(false)
    c.input.detach()
  })

  it('does not pulse fire or submit a release with missing capability or a closed gate', () => {
    for (const patch of [{ shotSupported: false }, { inputGeneration: 0 }, { inputEnabled: false }, { active: false }, { ended: true }]) {
      const c = Object.assign(controller(), patch)
      c.submitMobileShot(0.5)
      expect(c.send).not.toHaveBeenCalled()
      c.input.detach()
    }
  })

  it('cannot submit a shot while the server pause overlay is shown', () => {
    const c = Object.assign(controller(), { paused: true })
    c.submitMobileShot(0.5)
    expect(c.send).not.toHaveBeenCalled()
    c.input.detach()
  })

  it('clears held sampling state before the server pause so resume cannot restart firing', () => {
    const c = Object.assign(controller(), { pausedOverlay: document.createElement('div'), pausedNote: document.createElement('p') })
    c.input.applyTouch({ moveX: 1000, moveY: 0, aim: 0.4, fire: true, dash: true, shield: false, interact: false, axisMask: 15 })
    c.setPaused(true, true)
    expect(c.input.sample(0, 0).msg).toMatchObject({ moveX: 0, fire: false, dash: false })
    c.setPaused(false, true)
    expect(c.input.sample(0, 0).msg.fire).toBe(false)
    c.input.detach()
  })

  it('blocks touch while a workbench overlay is open, not just when its text has focus', () => {
    const c = Object.assign(controller(), { panelBlocked: true })
    c.applyMobileInput({ moveX: 1000, moveY: 0, fire: true, dash: false, shield: false, interact: false, axisMask: 7 })
    c.submitMobileShot(0.5)
    expect(c.input.sample(0, 0).active).toBe(false)
    expect(c.send).not.toHaveBeenCalled()
    c.input.detach()
  })

  it('rotates the shot generation from a real full snapshot and never rearms old contacts', () => {
    const f = lifecycleController()
    f.hold()
    f.c.submitMobileShot(0)
    expect(f.c.pendingShots.size).toBe(1)
    f.snapshot(16, 4)
    expect(f.c.pendingShots.size).toBe(0)
    expect(f.c.mobile.resetTakeover).toHaveBeenCalledOnce()
    expect(f.touch.owners).toEqual([])
    expect(f.touch.pointerMove(22, 450, 100)).toBe(false)
    expect(f.touch.pointerUp(22, 450, 100)).toEqual({ handled: false })
    expect(f.c.input.sample(0, 0).active).toBe(false)
    f.hold()
    f.c.submitMobileShot(f.touch.pointerUp(22, 450, 100).shot!)
    const last = f.c.send.mock.lastCall![0]
    const payload = fromBinary(ClientMsgSchema, last.subarray(1)).payload
    expect(payload.value).toMatchObject({ singleShot: { generation: 4, observedTick: 16 } })
    f.c.input.detach()
  })

  it('neutralizes and gates a snapshot gap until a full snapshot, without releasing a shot', () => {
    const f = lifecycleController()
    f.touch.setMode('hold')
    f.hold()
    expect(f.c.input.sample(0, 0).msg.fire).toBe(true)
    f.snapshot(17, 3, false, 16)
    expect(f.c.world.initialized).toBe(false)
    expect(f.c.input.sample(0, 0).msg).toMatchObject({ moveX: 0, fire: false })
    expect(f.touch.owners).toEqual([])
    const sent = f.c.send.mock.calls.length
    f.c.submitMobileShot(0)
    expect(f.c.send.mock.calls.length).toBe(sent)
    expect(fromBinary(ClientMsgSchema, f.c.send.mock.lastCall![0].subarray(1)).payload.case).toBe('resyncRequest')
    f.snapshot(18, 4)
    expect(f.c.world.initialized).toBe(true)
    expect(f.touch.pointerUp(22, 450, 100).handled).toBe(false)
    expect(f.c.input.sample(0, 0).msg.fire).toBe(false)
    f.c.input.detach()
  })

  it('disconnect cancellation drops captured gestures and clears sampled holds before detaching', () => {
    const f = lifecycleController()
    f.touch.setMode('hold')
    f.hold()
    expect(f.touch.snapshot.fire).toBe(true)
    f.c.setActive(false)
    expect(f.c.active).toBe(false)
    expect(f.c.mobile.setBattleVisible).toHaveBeenCalledWith(false)
    expect(f.c.input.sample(0, 0).active).toBe(false)
    expect(f.touch.owners).toEqual([])
    expect(f.touch.pointerUp(22, 450, 100)).toEqual({ handled: false })
    f.c.submitMobileShot(0)
    expect(f.c.send).not.toHaveBeenCalled()
    f.c.input.detach()
  })

  it('death snapshots cancel both thumbs and respawn cannot reuse the old release', () => {
    const f = lifecycleController()
    Object.assign(f.c, {
      cam: new Camera(), extras: {}, bubbles: [], chat: { hidden: true },
      renderer: { prepare: vi.fn() }, upgrades: { update: vi.fn() },
      updateHud: vi.fn(), flashUpgradeGains: vi.fn(), hud: { setAssist: vi.fn() },
      preparePresentation: GameController.prototype['preparePresentation'],
    })
    f.c.feedback.cameraZoom = vi.fn(() => 1)
    f.touch.setMode('hold')
    f.hold()
    f.c.pendingShots.add(12)
    f.snapshot(16, 4, true, 0, true)
    expect(f.c.mobile.setEnabled).toHaveBeenLastCalledWith(false)
    expect(f.c.pendingShots.size).toBe(0)
    expect(f.touch.owners).toEqual([])
    expect(f.c.input.sample(0, 0).active).toBe(false)
    f.snapshot(17, 5)
    expect(f.c.mobile.setEnabled).toHaveBeenLastCalledWith(true)
    expect(f.touch.pointerMove(22, 450, 100)).toBe(false)
    expect(f.touch.pointerUp(22, 450, 100)).toEqual({ handled: false })
    expect(f.c.input.sample(0, 0).msg.fire).toBe(false)
    f.c.input.detach()
  })

  it('uses only a correlated terminal result for failure feedback, not generic input acknowledgement', () => {
    const f = lifecycleController()
    f.c.feedback.event = vi.fn()
    f.c.hud = { flashMsg: vi.fn() }
    f.c.pendingShots.add(20)
    const result = (robot: number, seq: number, outcome: string) => {
      f.c.onMessage(create(ServerMsgSchema, { payload: { case: 'event', value: { kind: {
        case: 'singleShotResult', value: { robot, seq, outcome },
      } } } }))
    }
    f.snapshot(16)
    expect(f.c.pendingShots.has(20)).toBe(true)
    expect(f.c.hud.flashMsg).not.toHaveBeenCalled()
    result(2, 20, 'cooldown')
    result(1, 19, 'energy')
    expect(f.c.hud.flashMsg).not.toHaveBeenCalled()
    result(1, 20, 'cooldown')
    expect(f.c.hud.flashMsg).toHaveBeenCalledOnce()
    expect(f.c.pendingShots.size).toBe(0)
    result(1, 20, 'energy')
    expect(f.c.hud.flashMsg).toHaveBeenCalledOnce()
    f.c.pendingShots.add(21)
    result(1, 21, 'fired')
    expect(f.c.hud.flashMsg).toHaveBeenCalledOnce()
    expect(f.c.pendingShots.size).toBe(0)
    f.c.input.detach()
  })
})
