import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocketMetrics } from '@omb/protocol'
import { DebugSampler, readHeapMiB } from './sampler'

function fixture() {
  const network: WebSocketMetrics = { receivedBytes: 1000, sentBytes: 500,
    receivedMessages: 10, sentMessages: 5, connections: 1, rttMs: null }
  const read = vi.fn((target?: WebSocketMetrics) => Object.assign(target ?? {}, network))
  const memory = vi.fn(() => 32)
  return { sampler: new DebugSampler(read, memory), network, read, memory }
}

afterEach(() => vi.unstubAllGlobals())

describe('debug sampler', () => {
  it('does no network/memory reads between samples and divides traffic by actual elapsed time', () => {
    const { sampler, network, read, memory } = fixture()
    sampler.resume(0)
    for (let time = 50; time < 250; time += 50) expect(sampler.frame(time)).toBeUndefined()
    expect(read).toHaveBeenCalledTimes(1)
    expect(memory).not.toHaveBeenCalled()
    network.receivedBytes += 2048
    network.sentBytes += 1024
    network.receivedMessages += 5
    network.sentMessages += 2
    network.rttMs = 35
    expect(sampler.frame(250)).toEqual({
      time: 250, fps: 20, heapMiB: 32, receivedKiB: 8, sentKiB: 4,
      receivedMessages: 20, sentMessages: 8, connections: 1, rttMs: 35,
    })
    // A delayed callback must not extrapolate the nominal 250 ms interval.
    network.receivedBytes += 2048
    expect(sampler.frame(1250)?.receivedKiB).toBe(2)
    expect(sampler.latest?.fps).toBe(1)
    expect(sampler.history.valueAt(0, 'fps')).toBe(20)
    expect(sampler.history.valueAt(1, 'fps')).toBe(1)
  })

  it('resumes with a fresh baseline and excludes traffic received in a background tab', () => {
    const { sampler, network } = fixture()
    sampler.resume(0)
    sampler.frame(250)
    network.receivedBytes += 100_000
    sampler.resume(31_000)
    expect(sampler.history.size).toBe(0)
    expect(sampler.latest).toBeUndefined()
    network.receivedBytes += 1024
    expect(sampler.frame(31_250)?.receivedKiB).toBe(4)
    expect(sampler.latest?.fps).toBe(4)
    expect(sampler.history.size).toBe(1)
  })

  it('reuses its reading and two network snapshots without overwriting retained history', () => {
    const { sampler, read } = fixture()
    sampler.resume(0)
    const first = sampler.frame(250)
    const second = sampler.frame(500)
    expect(first).toBe(second)
    expect(read.mock.calls[0]![0]).toBe(read.mock.calls[2]![0])
    expect(read.mock.calls[1]![0]).not.toBe(read.mock.calls[0]![0])
    expect(sampler.history.timeAt(0)).toBe(250)
    expect(sampler.history.timeAt(1)).toBe(500)
    sampler.clear()
    expect(sampler.history.size).toBe(0)
    expect(sampler.latest).toBeUndefined()
  })
})

describe('optional JS heap estimate', () => {
  it('handles unsupported browsers, invalid readings and zero without inventing data', () => {
    vi.stubGlobal('performance', {})
    expect(readHeapMiB()).toBeNull()
    vi.stubGlobal('performance', { memory: { usedJSHeapSize: 8 * 1024 ** 2 } })
    expect(readHeapMiB()).toBe(8)
    vi.stubGlobal('performance', { memory: { usedJSHeapSize: 0 } })
    expect(readHeapMiB()).toBe(0)
    vi.stubGlobal('performance', { memory: { usedJSHeapSize: NaN } })
    expect(readHeapMiB()).toBeNull()
  })
})
