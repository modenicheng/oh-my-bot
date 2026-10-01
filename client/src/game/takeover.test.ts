import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Camera } from './camera'
import { AXIS_ABILITY, AXIS_AIM, AXIS_FIRE, AXIS_MOVE, InputSampler } from './input'

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

/** 细粒度人工接管：Space 三分支 + 边沿触发 + 恢复不重抢（ADR-0009）。 */
describe('fine-grained manual takeover', () => {
  let input: InputSampler, win: Target, canvas: Target, cam: Camera
  beforeEach(() => {
    win = new Target(); canvas = new Target(); cam = new Camera()
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', new Target())
    cam.resize(800, 500, 80); cam.follow(10, 10)
    input = new InputSampler(); input.attach(canvas as unknown as HTMLCanvasElement, cam)
  })
  afterEach(() => { input.detach(); vi.unstubAllGlobals() })

  it('per-axis takeover is independent; untouched axes stay unmasked', () => {
    send(win, 'keydown', { code: 'KeyW' })
    const { msg } = input.sample(10, 10)
    expect(msg.axisMask).toBe(AXIS_MOVE)
    expect(msg.axisMask & AXIS_AIM).toBe(0)
    expect(msg.axisMask & AXIS_FIRE).toBe(0)
    expect(msg.axisMask & AXIS_ABILITY).toBe(0)
  })

  it('mixed takeover reports each operated axis', () => {
    send(win, 'keydown', { code: 'KeyW' })
    send(canvas, 'mousemove', { clientX: 300, clientY: 200 })
    send(canvas, 'mousedown', { button: 0, clientX: 300, clientY: 200 })
    const { msg } = input.sample(10, 10)
    expect(msg.axisMask & AXIS_MOVE).toBe(AXIS_MOVE)
    expect(msg.axisMask & AXIS_AIM).toBe(AXIS_AIM)
    expect(msg.axisMask & AXIS_FIRE).toBe(AXIS_FIRE)
    expect(msg.axisMask & AXIS_ABILITY).toBe(0)
  })

  it('zero-output takeover: released keys keep axis manual with zero move output', () => {
    send(win, 'keydown', { code: 'KeyW' })
    input.sample(10, 10)
    send(win, 'keyup', { code: 'KeyW' })
    const { msg } = input.sample(10, 10)
    expect(msg.axisMask & AXIS_MOVE).toBe(AXIS_MOVE)
    expect(msg.moveX).toBe(0)
    expect(msg.moveY).toBe(0)
  })

  it('system auto-repeat keydown does not re-takeover after Space restore', () => {
    send(win, 'keydown', { code: 'KeyW' })
    input.sample(10, 10)
    // Space：交回辅助（本地镜像翻转 + 清 sticky/keys）
    input.toggleAssist()
    input.sample(10, 10)
    // 仍按住 W：系统 repeat 帧（repeat=true）不得重新抢占
    send(win, 'keydown', { code: 'KeyW', repeat: true })
    const { msg } = input.sample(10, 10)
    expect(msg.axisMask & AXIS_MOVE).toBe(0)
  })

  it('held keys after Space restore send unmasked frames until real new keydown', () => {
    send(win, 'keydown', { code: 'KeyW' })
    input.sample(10, 10)
    input.toggleAssist() // 交回辅助
    for (let i = 0; i < 5; i++) {
      const { msg } = input.sample(10, 10)
      expect(msg.axisMask & AXIS_MOVE).toBe(0)
    }
    // 真实新的 keydown（松开后再按）可再次接管
    send(win, 'keyup', { code: 'KeyW' })
    send(win, 'keydown', { code: 'KeyW' })
    const { msg } = input.sample(10, 10)
    expect(msg.axisMask & AXIS_MOVE).toBe(AXIS_MOVE)
  })

  it('held mouse button does not re-takeover fire after Space restore', () => {
    send(canvas, 'mousedown', { button: 0, clientX: 300, clientY: 200 })
    expect(input.sample(10, 10).msg.axisMask & AXIS_FIRE).toBe(AXIS_FIRE)
    input.toggleAssist() // 交回辅助（清 sticky + mouseDown）
    const { msg } = input.sample(10, 10)
    expect(msg.axisMask & AXIS_FIRE).toBe(0)
    // 仍按着的左键不会凭 mousemove 重新抢占 fire
    send(canvas, 'mousemove', { clientX: 400, clientY: 250 })
    expect(input.sample(10, 10).msg.axisMask & AXIS_FIRE).toBe(0)
    // 真实新的 mousedown 可再次接管
    send(canvas, 'mousedown', { button: 0, clientX: 400, clientY: 250 })
    expect(input.sample(10, 10).msg.axisMask & AXIS_FIRE).toBe(AXIS_FIRE)
  })

  it('blur releases held axes with one stop frame (reconnect/full snapshot path)', () => {
    send(win, 'keydown', { code: 'KeyW' })
    send(canvas, 'mousedown', { button: 0, clientX: 300, clientY: 200 })
    input.sample(10, 10)
    send(win, 'blur')
    const { msg, active } = input.sample(10, 10)
    // 停止帧仍带已操作轴 mask（服务端收到 zero 输出 + 保留轴归属）
    expect(msg.axisMask).toBe(AXIS_MOVE | AXIS_AIM | AXIS_FIRE)
    expect(active).toBe(true) // 释放帧本身是活跃帧
    // 后续帧无键无鼠标：不再抢占
    const next = input.sample(10, 10)
    expect(next.msg.axisMask).toBe(0)
    expect(next.active).toBe(false)
  })
})
