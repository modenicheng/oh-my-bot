import { describe, expect, it } from 'vitest'
import { advanceProgress, asciiProgress, loadingDots, progressPercent, progressTarget } from './startup-progress'

const pending = progressTarget(['done', 'done', 'done', 'done', 'loading'])
const complete = progressTarget(['done', 'done', 'done', 'done', 'done'])

describe('startup progress', () => {
  it('computes real milestones without calling failed or absent resources loaded', () => {
    expect(pending).toEqual({ real: 80, cap: 95, complete: false, pending: 1, failed: 0 })
    expect(complete).toEqual({ real: 100, cap: 100, complete: true, pending: 0, failed: 0 })
    expect(progressTarget(['done', 'error', 'loading'])).toMatchObject({ complete: false, pending: 1, failed: 1 })
    expect(progressTarget(['done', 'error']).real).toBe(50)
    expect(progressTarget([])).toEqual({ real: 0, cap: 75, complete: false, pending: 0, failed: 0 })
  })

  it('advances between fixed milestones asymptotically without reaching its cap or 100', () => {
    let value = 80
    for (let i = 0; i < 100; i++) {
      const next = advanceProgress(value, pending, 100)
      expect(next).toBeGreaterThan(value)
      expect(next).toBeLessThan(pending.cap)
      expect(progressPercent(next)).toBeLessThan(100)
      value = next
    }
    for (let i = 0; i < 10000; i++) value = advanceProgress(value, pending, 1000)
    expect(value).toBeLessThanOrEqual(95)
    expect(value).toBeLessThan(100)
  })

  it('never regresses when targets or motion preferences change', () => {
    let value = 0
    for (const real of [pending, progressTarget(['loading']), pending, complete]) {
      for (let i = 0; i < 6; i++) {
        const next = advanceProgress(value, real, 100)
        expect(next).toBeGreaterThanOrEqual(value)
        value = next
      }
    }
    expect(advanceProgress(90, pending, 100, true)).toBe(90)
  })

  it('quickly and smoothly catches up to newly completed real milestones', () => {
    const first = advanceProgress(10, pending, 16)
    expect(first).toBeGreaterThan(10)
    expect(first).toBeLessThan(80)
    let value = first
    for (let i = 0; i < 20; i++) value = advanceProgress(value, pending, 16)
    expect(value).toBeGreaterThan(78)
    expect(value).toBeLessThan(95)
  })

  it('finishes exactly at 100 in at most 100ms only with real readiness', () => {
    expect(advanceProgress(0, complete, 50)).toBe(50)
    expect(advanceProgress(50, complete, 50)).toBe(100)
    expect(advanceProgress(95, complete, 16)).toBe(100)
    expect(advanceProgress(95, pending, 1000)).toBe(95)
    expect(advanceProgress(100, complete, 1000)).toBe(100)
    expect(progressPercent(99.99999)).toBe(99)
  })

  it('does not invent movement after settled failures', () => {
    const degraded = progressTarget(['done', 'done', 'done', 'done', 'error'])
    expect(advanceProgress(90, degraded, 1000)).toBe(90)
    expect(advanceProgress(70, degraded, 1000)).toBeLessThanOrEqual(80)
  })

  it('snaps to actual milestones and keeps characters still with reduced motion', () => {
    expect(advanceProgress(0, pending, 0, true)).toBe(80)
    expect(advanceProgress(80, pending, 999, true)).toBe(80)
    expect(advanceProgress(80, complete, 0, true)).toBe(100)
    expect(asciiProgress(80, 0, 28, true)).toBe(asciiProgress(80, 97, 28, true))
  })

  it('sanitizes invalid progress, timing, width and animation frame inputs', () => {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(Number.isFinite(advanceProgress(invalid, pending, 100))).toBe(true)
      expect(advanceProgress(25, pending, invalid)).toBe(25)
      expect(asciiProgress(invalid, invalid, invalid)).toHaveLength(30)
      expect(loadingDots(invalid)).toBe('.')
    }
    expect(advanceProgress(20, pending, -100)).toBe(20)
    expect(advanceProgress(NaN, { ...pending, real: NaN, cap: Infinity }, 100)).toBe(0)
    expect(advanceProgress(1000, pending, 100)).toBe(98)
    expect(asciiProgress(-100, 0, -5)).toHaveLength(26)
    expect(asciiProgress(500, 0, 10000)).toBe(`[${'#'.repeat(32)}]`)
    expect(progressPercent(NaN)).toBe(0)
  })

  it('animates deterministic head frames within a stable 28-cell ASCII track', () => {
    const frames = [0, 1, 2, 3].map(frame => asciiProgress(50, frame))
    expect(new Set(frames).size).toBe(4)
    for (const [frame, bar] of frames.entries()) {
      expect(bar).toHaveLength(30)
      expect(bar).toMatch(/^\[[#=+>.]{28}\]$/)
      expect(bar).toBe(asciiProgress(50, frame))
    }
    expect(asciiProgress(100, 18)).toBe(`[${'#'.repeat(28)}]`)
    expect(asciiProgress(99.999, 0)).not.toBe(asciiProgress(100, 0))
    expect([0, 1, 2, 3, 4, 5].map(loadingDots)).toEqual(['.', '..', '...', '.', '..', '...'])
  })
})
