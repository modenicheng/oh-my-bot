import { describe, expect, it } from 'vitest'
import { DebugHistory, HISTORY_MS, SAMPLE_MS, scaleCeiling, type DebugSample } from './history'

function sample(time: number, fps = 60): DebugSample {
  return { time, fps, heapMiB: 32, receivedKiB: 2, sentKiB: 1,
    receivedMessages: 20, sentMessages: 10, connections: 1, rttMs: 25 }
}

describe('debug history', () => {
  it('wraps repeatedly while retaining only the most recent 30 seconds in order', () => {
    const history = new DebugHistory()
    for (let time = 0; time <= 120_000; time += SAMPLE_MS) history.push(sample(time, time))
    expect(history.size).toBe(121)
    expect(history.size).toBe(history.capacity)
    for (let i = 0; i < history.size; i++) {
      expect(history.timeAt(i)).toBe(90_000 + i * SAMPLE_MS)
      expect(history.valueAt(i, 'fps')).toBe(90_000 + i * SAMPLE_MS)
    }
  })

  it('copies reused sample objects and represents unavailable readings as gaps', () => {
    const history = new DebugHistory()
    const reading = sample(0)
    history.push(reading)
    reading.time = 250
    reading.fps = 30
    reading.heapMiB = null
    reading.rttMs = null
    history.push(reading)
    expect(history.valueAt(0, 'fps')).toBe(60)
    expect(history.valueAt(0, 'heapMiB')).toBe(32)
    expect(history.valueAt(1, 'fps')).toBe(30)
    expect(history.valueAt(1, 'heapMiB')).toBeNaN()
    expect(history.valueAt(1, 'rttMs')).toBeNaN()
  })

  it('expires by wall time after a long suspension, including without new samples', () => {
    const history = new DebugHistory()
    history.push(sample(0))
    history.push(sample(250))
    history.prune(HISTORY_MS)
    expect(history.size).toBe(2)
    history.prune(HISTORY_MS + 1)
    expect(history.size).toBe(1)
    expect(history.timeAt(0)).toBe(250)
    history.prune(HISTORY_MS + 251)
    expect(history.size).toBe(0)
    history.push(sample(60_000))
    expect(history.timeAt(0)).toBe(60_000)
    history.clear()
    expect(history.size).toBe(0)
    history.push(sample(90_000))
    expect(history.timeAt(0)).toBe(90_000)
  })

  it('caps storage independently of time when writes exceed the expected sampling rate', () => {
    const history = new DebugHistory(3)
    for (let time = 0; time < 10; time++) history.push(sample(time))
    expect(history.size).toBe(3)
    expect([0, 1, 2].map(i => history.timeAt(i))).toEqual([7, 8, 9])
  })

  it('rescales downward when a spike expires, with nonzero axes for empty data', () => {
    const history = new DebugHistory()
    history.push(sample(0, 1000))
    history.push(sample(250, 60))
    expect(scaleCeiling(Math.max(history.valueAt(0, 'fps'), history.valueAt(1, 'fps')), 30)).toBe(2000)
    history.prune(HISTORY_MS + 1)
    expect(scaleCeiling(history.valueAt(0, 'fps'), 30)).toBe(100)
    expect(scaleCeiling(0)).toBe(1)
    expect(scaleCeiling(NaN, 10)).toBe(10)
  })
})
