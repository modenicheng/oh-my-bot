import { describe, expect, it } from 'vitest'
import { TouchState, stickVector, type TouchGeometry } from './touch-state'

const geometry: TouchGeometry = {
  left: { left: 10, top: 180, width: 260, height: 180 },
  moveRadius: 60,
  right: { x: 550, y: 290, radius: 60 },
  abilities: {
    dash: { left: 410, top: 290, width: 56, height: 56 },
    shield: { left: 410, top: 226, width: 56, height: 56 },
    interact: { left: 522, top: 160, width: 56, height: 56 },
  },
}

describe('touch stick geometry', () => {
  it('maps the radial dead zone linearly into bounded per-mille movement', () => {
    expect(stickVector(10.8, 0, 60)).toEqual({ x: 0, y: 0 })
    expect(stickVector(35.4, 0, 60)).toEqual({ x: 500, y: 0 })
    expect(stickVector(-600, 0, 60)).toEqual({ x: -1000, y: 0 })
    for (let angle = 0; angle < Math.PI * 2; angle += 0.01) {
      const v = stickVector(Math.cos(angle) * 90, Math.sin(angle) * 90, 60)
      expect(Math.hypot(v.x, v.y)).toBeLessThanOrEqual(1000)
    }
    expect(stickVector(NaN, 1, 60)).toEqual({ x: 0, y: 0 })
  })

  it('clamps the floating origin inside its activation area without subsequent drift', () => {
    const state = new TouchState(geometry)
    expect(state.pointerDown(11, 12, 358)).toBe(true)
    expect(state.left?.origin).toEqual({ x: 70, y: 300 })
    state.pointerMove(11, 260, 180)
    expect(state.left?.origin).toEqual({ x: 70, y: 300 })
    expect(state.snapshot.moveX).toBeGreaterThan(0)
    expect(state.snapshot.moveY).toBeLessThan(0)
    expect(state.pointerUp(11, 260, 180).shot).toBeUndefined()
    expect(state.snapshot).toMatchObject({ moveX: 0, moveY: 0, axisMask: 1 })
  })

  it('uses CSS coordinates, not DPR, camera position or absolute screen aim', () => {
    const state = new TouchState(geometry)
    state.pointerDown(1, 550, 290)
    state.pointerMove(1, 550, 230)
    expect(state.snapshot.aim).toBeCloseTo(-Math.PI / 2)
    const shifted = new TouchState({ ...geometry, right: { x: 1550, y: 790, radius: 120 } })
    shifted.pointerDown(1, 1550, 790)
    shifted.pointerMove(1, 1550, 670)
    expect(shifted.snapshot.aim).toBe(state.snapshot.aim)
  })
})

describe('touch pointer ownership and shot transitions', () => {
  it('owns two independent IDs, ignores extra fingers and cannot change roles at the midpoint', () => {
    const state = new TouchState(geometry)
    state.pointerDown(7, 100, 280)
    state.pointerDown(9, 550, 290)
    expect(state.pointerDown(10, 560, 300)).toBe(false)
    expect(state.pointerDown(7, 550, 290)).toBe(false)
    state.pointerMove(7, 600, 290)
    expect(state.left?.pointerId).toBe(7)
    expect(state.right.pointerId).toBe(9)
    expect(state.snapshot).toMatchObject({ moveX: 999, fire: false })
    expect(state.pointerMove(10, 100, 100)).toBe(false)
  })

  it('does not claim axes for idle center contact, then owns aim/fire while aiming', () => {
    const state = new TouchState(geometry)
    state.pointerDown(1, 550, 290)
    expect(state.right.phase).toBe('tracking')
    expect(state.snapshot.axisMask).toBe(0)
    state.pointerMove(1, 610, 290)
    expect(state.right.phase).toBe('aiming')
    expect(state.snapshot).toMatchObject({ aim: 0, fire: false, axisMask: 6 })
  })

  it('fires once only on normal release, recomputing the final event direction', () => {
    const state = new TouchState(geometry)
    state.pointerDown(1, 550, 290)
    state.pointerMove(1, 610, 290)
    expect(state.snapshot.fire).toBe(false)
    expect(state.pointerUp(1, 550, 350)).toEqual({ handled: true, shot: Math.PI / 2 })
    expect(state.snapshot).toMatchObject({ fire: false, axisMask: 6, aim: Math.PI / 2 })
    expect(state.pointerUp(1, 550, 350)).toEqual({ handled: false })
    expect(state.pointerCancel(1)).toBe(false)
  })

  it('cancels taps and final-center releases, retains facing, and rearms outside again', () => {
    const state = new TouchState(geometry)
    state.pointerDown(1, 550, 290)
    expect(state.pointerUp(1, 550, 290).shot).toBeUndefined()
    state.pointerDown(2, 550, 290)
    state.pointerMove(2, 610, 290)
    state.pointerMove(2, 550, 290)
    expect(state.snapshot.aim).toBe(0)
    expect(state.right.phase).toBe('tracking')
    state.pointerMove(2, 550, 350)
    expect(state.pointerUp(2, 550, 350).shot).toBeCloseTo(Math.PI / 2)
    state.pointerDown(3, 550, 290)
    state.pointerMove(3, 610, 290)
    expect(state.pointerUp(3, 550, 290).shot).toBeUndefined()
  })

  it('keeps the aiming gesture when the final up enters an ability region', () => {
    const state = new TouchState(geometry)
    state.pointerDown(1, 550, 290)
    state.pointerMove(1, 610, 290)
    expect(state.pointerUp(1, 438, 312).shot).toBeCloseTo(Math.atan2(22, -112))
    expect(state.snapshot).toMatchObject({ dash: false, shield: false, interact: false, fire: false })
    expect(state.right.phase).toBe('idle')
  })

  it('holds continuous fire only outside the dead zone and never emits a release shot', () => {
    const state = new TouchState(geometry, 'hold')
    state.pointerDown(1, 600, 290)
    expect(state.snapshot.fire).toBe(false)
    state.pointerMove(1, 610, 290)
    expect(state.snapshot.fire).toBe(true)
    state.pointerMove(1, 550, 290)
    expect(state.snapshot.fire).toBe(false)
    state.pointerMove(1, 610, 290)
    expect(state.pointerUp(1, 610, 290).shot).toBeUndefined()
    expect(state.snapshot.fire).toBe(false)
  })

  it('switching mode cancels only the right role and requires fresh right contact', () => {
    const state = new TouchState(geometry)
    state.pointerDown(1, 100, 280)
    state.pointerMove(1, 160, 280)
    state.pointerDown(2, 550, 290)
    state.pointerMove(2, 610, 290)
    state.setMode('hold')
    expect(state.snapshot).toMatchObject({ moveX: 1000, fire: false, axisMask: 7 })
    expect(state.pointerMove(2, 610, 290)).toBe(false)
    expect(state.pointerUp(2, 610, 290).shot).toBeUndefined()
    state.pointerDown(3, 550, 290)
    state.pointerMove(3, 610, 290)
    expect(state.snapshot.fire).toBe(true)
  })
})

describe('exclusive touch abilities and lifecycle', () => {
  for (const [ability, point] of [
    ['dash', [438, 312]], ['shield', [438, 250]], ['interact', [550, 188]],
  ] as const) {
    it(`directly holds ${ability} without stealing the left thumb`, () => {
      const state = new TouchState(geometry)
      state.pointerDown(1, 100, 280)
      state.pointerMove(1, 160, 280)
      state.pointerDown(2, point[0], point[1])
      expect(state.snapshot).toMatchObject({ moveX: 1000, [ability]: true, fire: false, axisMask: 9 })
      state.pointerMove(2, 610, 290)
      expect(state.snapshot[ability]).toBe(true)
      expect(state.pointerUp(2, 610, 290).shot).toBeUndefined()
      expect(state.snapshot).toMatchObject({ moveX: 1000, [ability]: false, axisMask: 9 })
    })
  }

  it('keeps aim and continuous fire while crossing ability targets', () => {
    const state = new TouchState(geometry, 'hold')
    state.pointerDown(1, 550, 290)
    state.pointerMove(1, 610, 290)
    expect(state.snapshot.fire).toBe(true)
    state.pointerMove(1, 438, 312)
    expect(state.snapshot).toMatchObject({ dash: false, shield: false, fire: true, axisMask: 6 })
    expect(state.right.phase).toBe('aiming')
    state.pointerMove(1, 438, 250)
    state.pointerMove(1, 610, 290)
    expect(state.snapshot).toMatchObject({ dash: false, shield: false, fire: true })
    expect(state.pointerUp(1, 610, 290).shot).toBeUndefined()
  })

  it('cancel and geometry replacement clear ownership but preserve operated stop axes and mode', () => {
    const state = new TouchState(geometry, 'hold')
    state.pointerDown(1, 100, 280)
    state.pointerMove(1, 160, 280)
    state.pointerDown(2, 550, 290)
    state.pointerMove(2, 438, 312)
    state.cancel()
    expect(state.snapshot).toMatchObject({ moveX: 0, moveY: 0, fire: false, dash: false, axisMask: 7 })
    expect(state.owners).toEqual([])
    expect(state.mode).toBe('hold')
    expect(state.pointerMove(2, 610, 290)).toBe(false)
    state.pointerDown(3, 550, 290)
    state.pointerMove(3, 610, 290)
    state.setGeometry(geometry)
    expect(state.snapshot.fire).toBe(false)
    expect(state.pointerUp(3, 610, 290).shot).toBeUndefined()
  })

  it('individual cancellation never releases the other role or turns capture loss into a shot', () => {
    const state = new TouchState(geometry)
    state.pointerDown(1, 100, 280)
    state.pointerMove(1, 160, 280)
    state.pointerDown(2, 550, 290)
    state.pointerMove(2, 610, 290)
    state.pointerCancel(2)
    expect(state.snapshot).toMatchObject({ moveX: 1000, fire: false })
    expect(state.owners).toEqual([1])
    expect(state.pointerUp(2, 610, 290).shot).toBeUndefined()
    state.pointerCancel(1)
    expect(state.snapshot).toMatchObject({ moveX: 0, axisMask: 7 })
  })

  it('explicit Assist hand-back forgets sticky axes and facing before the next gesture', () => {
    const state = new TouchState(geometry, 'hold')
    state.pointerDown(1, 550, 290)
    state.pointerMove(1, 610, 290)
    state.pointerMove(1, 438, 312)
    state.cancel()
    expect(state.snapshot.axisMask).toBe(6)
    state.resetTakeover()
    expect(state.snapshot.axisMask).toBe(0)
    expect(state.snapshot.aim).toBeUndefined()
    expect(state.mode).toBe('hold')
    state.pointerDown(2, 100, 280)
    state.pointerMove(2, 160, 280)
    expect(state.snapshot.axisMask).toBe(1)
  })
})
