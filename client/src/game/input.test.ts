import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Camera } from './camera'
import { AXIS_ABILITY, AXIS_AIM, InputSampler } from './input'

class Target extends EventTarget {
  closest(): null { return null }
  rect = { left: 40, top: 20, width: 800, height: 500 }
  getBoundingClientRect() { return this.rect }
}
function send(target: EventTarget, type: string, props: Record<string, unknown> = {}) {
  const event = new Event(type, { cancelable: true })
  for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value })
  target.dispatchEvent(event)
}

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

  it('reprojects a stationary pointer with camera movement and CSS resize', () => {
    send(canvas, 'mousemove', { clientX: 640, clientY: 320 })
    const expected = () => Math.atan2(cam.toWorldY((320 - canvas.rect.top) * cam.ch / canvas.rect.height) - 10,
      cam.toWorldX((640 - canvas.rect.left) * cam.cw / canvas.rect.width) - 10)
    expect(input.aimAt(10, 10)).toBeCloseTo(expected())
    cam.follow(50, 20)
    expect(input.sample(10, 10).msg.aim).toBeCloseTo(expected())
    canvas.rect = { left: 15, top: 10, width: 1200, height: 750 }
    cam.resize(1200, 750, 80)
    expect(input.aimAt(10, 10)).toBeCloseTo(expected())
    expect(input.sample(10, 10).msg.aim).toBeCloseTo(input.aimAt(10, 10)!)
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
})
