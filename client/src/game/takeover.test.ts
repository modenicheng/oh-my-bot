import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Camera } from './camera'
import { AXIS_ABILITY, AXIS_AIM, AXIS_FIRE, AXIS_MOVE, InputSampler } from './input'
import { Target, send } from './test-targets'

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

  it('keeps assist on when Space returns a seized axis, then switches off when unclaimed', () => {
    input.toggleAssist()
    expect(input.assistOn).toBe(true)
    send(win, 'keydown', { code: 'KeyW' })
    input.toggleAssist()
    expect(input.assistOn).toBe(true)
    expect(input.sample(10, 10).msg.axisMask).toBe(0)
    input.toggleAssist()
    expect(input.assistOn).toBe(false)
  })

  it('returns server-retained axes even after focus loss cleared the local mask', () => {
    input.assistOn = true
    input.detach()
    input.toggleAssist(AXIS_AIM | AXIS_FIRE)
    expect(input.assistOn).toBe(true)
    expect(input.sample(10, 10).msg.axisMask).toBe(0)
  })

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

/** 瞄准 guard：脚本控制炮塔时鼠标移动不抢炮塔轴，R 显式夺取。 */
describe('aim guard under script turret control', () => {
  let input: InputSampler, win: Target, canvas: Target, cam: Camera
  beforeEach(() => {
    win = new Target(); canvas = new Target(); cam = new Camera()
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', new Target())
    cam.resize(800, 500, 80); cam.follow(10, 10)
    input = new InputSampler(); input.attach(canvas as unknown as HTMLCanvasElement, cam)
  })
  afterEach(() => { input.detach(); vi.unstubAllGlobals() })

  it('mouse moves do not take the aim axis while the guard is on, but still report pointer', () => {
    input.aimUnderScript = true
    send(canvas, 'mousemove', { clientX: 300, clientY: 200 })
    send(canvas, 'mousemove', { clientX: 400, clientY: 260 })
    expect(input.sample(10, 10).msg.axisMask & AXIS_AIM).toBe(0)
    // guard 只挡抢占，不挡指针更新：R 夺取后 aim 用的是最新坐标而非初始 (0,0)
    input.seizeAim()
    const aim = input.aimAt(10, 10)
    expect(aim).not.toBeUndefined()
    const expectAim = Math.atan2(
      cam.toWorldY((260 - 20) * 500 / 500) - 10,
      cam.toWorldX((400 - 40) * 800 / 800) - 10)
    expect(aim).toBeCloseTo(expectAim, 6)
  })

  it('guarded mouse move fires the onAimGuarded callback exactly once per move event', () => {
    let calls = 0
    input.aimUnderScript = true
    input.onAimGuarded = () => { calls++ }
    send(canvas, 'mousemove', { clientX: 300, clientY: 200 })
    send(canvas, 'mousemove', { clientX: 310, clientY: 210 })
    expect(calls).toBe(2)
    // 坐标未变化的重复事件既不抢占也不提示
    send(canvas, 'mousemove', { clientX: 310, clientY: 210 })
    expect(calls).toBe(2)
  })

  it('left-click still takes the fire axis under the guard; the click micro-move does not leak aim', () => {
    input.aimUnderScript = true
    // 点击必伴随微动：mousedown 里先回放 onMouseMove，再置 fire
    send(canvas, 'mousedown', { button: 0, clientX: 300, clientY: 200 })
    const { msg } = input.sample(10, 10)
    expect(msg.axisMask & AXIS_FIRE).toBe(AXIS_FIRE)
    expect(msg.axisMask & AXIS_AIM).toBe(0)
    expect(msg.fire).toBe(true)
  })

  it('R seizes the aim axis explicitly; guard no longer applies once held', () => {
    input.aimUnderScript = true
    expect(input.seizeAim()).toBe(true)
    send(canvas, 'mousemove', { clientX: 300, clientY: 200 })
    const { msg } = input.sample(10, 10)
    expect(msg.axisMask & AXIS_AIM).toBe(AXIS_AIM)
    // 幂等：已持有时再按 R 不重复提示
    expect(input.seizeAim()).toBe(false)
  })

  it('Space restore clears the held aim axis; the guard re-arms after script turret returns', () => {
    input.aimUnderScript = true
    input.seizeAim()
    expect(input.sample(10, 10).msg.axisMask & AXIS_AIM).toBe(AXIS_AIM)
    // Space 交回辅助（服务端分支 2：把人工轴交回脚本）
    input.toggleAssist()
    input.aimUnderScript = true // 控制器下一帧回写 guard（脚本重新接管炮塔）
    send(canvas, 'mousemove', { clientX: 400, clientY: 260 })
    expect(input.sample(10, 10).msg.axisMask & AXIS_AIM).toBe(0)
    // R 可再次夺取
    expect(input.seizeAim()).toBe(true)
    expect(input.sample(10, 10).msg.axisMask & AXIS_AIM).toBe(AXIS_AIM)
  })

  it('guard off (assist closed or human turret) keeps classic per-frame mouse takeover', () => {
    input.aimUnderScript = false
    send(canvas, 'mousemove', { clientX: 300, clientY: 200 })
    expect(input.sample(10, 10).msg.axisMask & AXIS_AIM).toBe(AXIS_AIM)
  })

  it('detach resets the guard so a fresh attach never starts guarded', () => {
    input.aimUnderScript = true
    input.detach()
    expect(input.aimUnderScript).toBe(false)
  })
})
