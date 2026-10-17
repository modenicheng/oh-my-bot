import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Camera } from './camera'
import { AXIS_ABILITY, AXIS_AIM, AXIS_FIRE, AXIS_MOVE, InputSampler } from './input'
import { Target, send } from './test-targets'

describe('human input continuity', () => {
  let input: InputSampler, win: Target, canvas: Target, cam: Camera
  beforeEach(() => {
    win = new Target(); canvas = new Target(); cam = new Camera()
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', new Target())
    cam.resize(800, 500, 80); cam.follow(10, 10)
    input = new InputSampler(); input.attach(canvas as unknown as HTMLCanvasElement, cam)
  })
  afterEach(() => { input.detach(); vi.unstubAllGlobals() })

  it('holds Uplink interaction through many samples and releases either key correctly', () => {
    expect(input.assistOn).toBe(false)
    send(win, 'keydown', { code: 'KeyE' })
    for (let i = 0; i < 500; i++) {
      const { msg } = input.sample(10, 10)
      expect(msg.interact).toBe(true)
      expect(msg.axisMask & AXIS_ABILITY).toBe(AXIS_ABILITY)
    }
    send(win, 'keydown', { code: 'KeyF' })
    send(win, 'keyup', { code: 'KeyE' })
    expect(input.sample(10, 10).msg.interact).toBe(true)
    send(win, 'keyup', { code: 'KeyF' })
    const release = input.sample(10, 10).msg
    expect(release.interact).toBe(false)
    expect(release.axisMask & AXIS_ABILITY).toBe(AXIS_ABILITY)
  })

  it('keeps dash held by either Shift key or right mouse button', () => {
    send(win, 'keydown', { code: 'ShiftLeft' })
    expect(input.sample(10, 10).msg.dash).toBe(true)
    send(win, 'keyup', { code: 'ShiftLeft' })
    expect(input.sample(10, 10).msg.dash).toBe(false)

    send(win, 'keydown', { code: 'ShiftRight' })
    send(win, 'keydown', { code: 'ShiftLeft' })
    send(win, 'keyup', { code: 'ShiftLeft' })
    expect(input.sample(10, 10).msg.dash).toBe(true)
    send(canvas, 'mousedown', { button: 2 })
    send(win, 'keyup', { code: 'ShiftRight' })
    expect(input.sample(10, 10).msg.dash).toBe(true)
    send(win, 'mouseup', { button: 2 })
    const release = input.sample(10, 10).msg
    expect(release.dash).toBe(false)
    expect(release.axisMask & AXIS_ABILITY).toBe(AXIS_ABILITY)
  })

  it('does not rebuild released controls from browser key repeat after reattach', () => {
    send(win, 'keydown', { code: 'ShiftLeft', repeat: false })
    expect(input.sample(10, 10).msg.dash).toBe(true)
    input.detach()
    input.attach(canvas as unknown as HTMLCanvasElement, cam)
    send(win, 'keydown', { code: 'ShiftLeft', repeat: true })
    send(win, 'keydown', { code: 'KeyW', repeat: true })
    const repeated = input.sample(10, 10)
    expect(repeated.msg.dash).toBe(false)
    expect(repeated.msg.moveY).toBe(0)
    expect(repeated.active).toBe(false)
    send(win, 'keydown', { code: 'ShiftLeft', repeat: false })
    expect(input.sample(10, 10).msg.dash).toBe(true)
  })

  it('reprojects a stationary pointer with camera movement and CSS resize', () => {
    send(canvas, 'mousemove', { clientX: 640, clientY: 320 })
    const expected = () => Math.atan2(cam.toWorldY((320 - canvas.rect.top) * cam.ch / canvas.rect.height) - 10,
      cam.toWorldX((640 - canvas.rect.left) * cam.cw / canvas.rect.width) - 10)
    expect(input.aimAt(10, 10)).toBeCloseTo(expected())
    cam.follow(50, 20)
    expect(input.sample(10, 10).msg.aim).toBeCloseTo(expected())
    canvas.rect = { left: 15, top: 10, width: 1200, height: 750 }
    cam.resize(1200, 750, 80)
    input.refreshBounds()
    expect(input.aimAt(10, 10)).toBeCloseTo(expected())
    expect(input.sample(10, 10).msg.aim).toBeCloseTo(input.aimAt(10, 10)!)
  })

  it('reads canvas layout on geometry changes, never while sampling or projecting aim', () => {
    const bounds = vi.spyOn(canvas, 'getBoundingClientRect')
    send(canvas, 'mousemove', { clientX: 640, clientY: 320 })
    for (let i = 0; i < 100; i++) { input.aimAt(10, 10); input.sample(10, 10) }
    expect(bounds).not.toHaveBeenCalled()
    send(win, 'resize')
    expect(bounds).toHaveBeenCalledOnce()
  })

  it('takes aim from the first click, and blur sends one explicit stop', () => {
    send(canvas, 'mousedown', { button: 0, clientX: 440, clientY: 420 })
    const start = input.sample(10, 10).msg
    expect(start.aim).toBeCloseTo(Math.PI / 2)
    expect(start.axisMask & AXIS_AIM).toBe(AXIS_AIM)
    send(win, 'keydown', { code: 'KeyE' })
    send(win, 'blur')
    const stop = input.sample(10, 10)
    expect(stop.active).toBe(true)
    expect(stop.msg.fire).toBe(false)
    expect(stop.msg.interact).toBe(false)
    expect(stop.msg.aim).toBeCloseTo(Math.PI / 2)
    expect(input.sample(10, 10).active).toBe(false)
    expect(input.aimAt(10, 10)).toBeUndefined()
  })

  it('samples analog touch movement and directional aim without camera projection', () => {
    input.setTouchMode(true)
    input.applyTouch({ moveX: 300, moveY: -400, aim: 1.2, fire: false,
      dash: false, shield: false, interact: false, axisMask: AXIS_MOVE | AXIS_AIM | AXIS_FIRE })
    cam.follow(50, -30)
    const frame = input.sample(-10, 40)
    expect(frame.msg).toMatchObject({ moveX: 300, moveY: -400, aim: 1.2, fire: false, axisMask: 7 })
    expect(input.aimAt(-10, 40)).toBe(1.2)
    expect(input.holdsAim()).toBe(true)
  })

  it('prevents compatibility mouse events from firing or bending touch aim', () => {
    input.setTouchMode(true)
    input.aimUnderScript = true
    input.applyTouch({ moveX: 0, moveY: 0, aim: 0.7, fire: false,
      dash: false, shield: false, interact: false, axisMask: AXIS_AIM | AXIS_FIRE })
    send(canvas, 'mousedown', { button: 0, clientX: 640, clientY: 320 })
    send(canvas, 'mousemove', { clientX: 440, clientY: 420 })
    expect(input.sample(10, 10).msg).toMatchObject({ aim: 0.7, fire: false, axisMask: AXIS_AIM | AXIS_FIRE })
    expect(input.aimUnderScript).toBe(true)
  })

  it('releases every touch hold without giving operated axes back to scripts', () => {
    input.setTouchMode(true)
    input.applyTouch({ moveX: 1000, moveY: 0, aim: 0.3, fire: true,
      dash: true, shield: false, interact: false, axisMask: 15 })
    input.release()
    expect(input.sample(0, 0).msg).toMatchObject({ moveX: 0, moveY: 0, fire: false, dash: false, axisMask: 15 })
    input.resetTakeover()
    expect(input.sample(0, 0).active).toBe(false)
    send(win, 'keydown', { code: 'KeyW', repeat: true })
    expect(input.sample(0, 0).active).toBe(false)
  })

  it('cancels the previous source when changing input layouts', () => {
    send(canvas, 'mousedown', { button: 0, clientX: 640, clientY: 320 })
    expect(input.sample(10, 10).msg.fire).toBe(true)
    input.setTouchMode(true)
    expect(input.sample(10, 10).msg.fire).toBe(false)
    input.applyTouch({ moveX: 0, moveY: 0, fire: false,
      dash: false, shield: true, interact: false, axisMask: AXIS_ABILITY })
    input.setTouchMode(false)
    expect(input.sample(10, 10).msg.shield).toBe(false)
  })

  it('prepares one release snapshot without overwriting the other thumb movement', () => {
    input.setTouchMode(true)
    input.applyTouch({ moveX: 500, moveY: -200, fire: true,
      dash: false, shield: false, interact: false, axisMask: AXIS_MOVE | AXIS_FIRE })
    input.prepareSingleShot(0.8)
    expect(input.sample(10, 10).msg).toMatchObject({ moveX: 500, moveY: -200, aim: 0.8, fire: false, axisMask: 7 })
    expect(input.sample(10, 10).msg.fire).toBe(false)
  })
})
