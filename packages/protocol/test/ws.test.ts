// WsTransport 连接健壮性测试：close-before-open、connecting 取消、error+close 单次回调、
// 心跳/存活定时器清理、发送精确切片。全部使用 FakeWebSocket + fake timers。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WsTransport } from '../src/ws'
import { readWebSocketMetrics } from '../src/ws-metrics'

const CONNECTING = 0
const OPEN = 1
const CLOSED = 3

/** 可控 WebSocket：手工触发 open/error/close/message，记录发送字节。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static CONNECTING = CONNECTING
  static OPEN = OPEN
  static CLOSING = 2
  static CLOSED = CLOSED
  readonly CONNECTING = CONNECTING
  readonly OPEN = OPEN
  readonly CLOSING = 2
  readonly CLOSED = CLOSED
  binaryType = 'blob'
  readyState = CONNECTING
  sent: ArrayBuffer[] = []
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null

  constructor(public url: string, public protocols?: string | string[]) {
    FakeWebSocket.instances.push(this)
  }

  send(buf: ArrayBuffer): void {
    this.sent.push(buf)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.readyState === CONNECTING || this.readyState === OPEN) this.readyState = CLOSED
  }

  // ---- 测试驱动 ----
  open(): void {
    this.readyState = OPEN
    this.onopen?.()
  }

  error(): void {
    this.onerror?.()
  }

  closeEvent(): void {
    this.readyState = CLOSED
    this.onclose?.()
  }

  message(bytes: number[]): void {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer })
  }

  sentBytes(): number[][] {
    return this.sent.map((b) => Array.from(new Uint8Array(b)))
  }
}

describe('WsTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    FakeWebSocket.instances = []
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('connect open 后 resolve，转发数据帧', async () => {
    const t = new WsTransport()
    const got: number[][] = []
    t.onMessage((m) => got.push(Array.from(m)))
    const p = t.connect('ws://x/ws')
    expect(FakeWebSocket.instances[0]!.protocols).toEqual(['omb.binary.v1'])
    FakeWebSocket.instances[0]!.open()
    await p
    expect(FakeWebSocket.instances).toHaveLength(1)
    FakeWebSocket.instances[0]!.message([3, 1, 2])
    expect(got).toEqual([[3, 1, 2]])
    t.close()
  })

  it.each(['error', 'closeEvent'] as const)('retries a pre-open %s once without a subprotocol for an old server', async (failure) => {
    const t = new WsTransport()
    const disconnects: string[] = []
    const resolved = vi.fn()
    const rejected = vi.fn()
    const received: number[][] = []
    t.onClose((r) => disconnects.push(r))
    t.onMessage((m) => received.push(Array.from(m)))
    const url = 'ws://x/ws?token=keep-auth'
    const p = t.connect(url)
    void p.then(resolved, rejected)
    vi.advanceTimersByTime(7500)
    const first = FakeWebSocket.instances[0]!
    first[failure]()
    expect(FakeWebSocket.instances).toHaveLength(2)
    const fallback = FakeWebSocket.instances[1]!
    expect(fallback.url).toBe(url)
    expect(fallback.protocols).toBeUndefined()
    expect(fallback.binaryType).toBe('arraybuffer')
    expect(first.onopen).toBeNull()
    expect(first.onmessage).toBeNull()
    expect(first.onerror).toBeNull()
    expect(first.onclose).toBeNull()
    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled()
    expect(rejected).not.toHaveBeenCalled()
    fallback.open()
    await p
    fallback.message([3, 1, 2])
    expect(received).toEqual([[3, 1, 2]])
    vi.advanceTimersByTime(1000) // Opening the fallback cancels the original deadline.
    expect(resolved).toHaveBeenCalledTimes(1)
    expect(rejected).not.toHaveBeenCalled()
    expect(disconnects).toEqual([])
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(2)
    t.close()
  })

  it.each(['error', 'closeEvent'] as const)('rejects a failed fallback %s once without a third socket', async (failure) => {
    const t = new WsTransport()
    const disconnects: string[] = []
    const resolved = vi.fn()
    const rejected = vi.fn()
    t.onClose((r) => disconnects.push(r))
    const p = t.connect('ws://x/ws')
    void p.then(resolved, rejected)
    const first = FakeWebSocket.instances[0]!
    first.error()
    expect(FakeWebSocket.instances).toHaveLength(2)
    const fallback = FakeWebSocket.instances[1]!
    const staleError = fallback.onerror!
    const staleClose = fallback.onclose!
    fallback[failure]()
    await expect(p).rejects.toThrow(failure === 'error' ? 'ws connect failed' : 'ws closed before open')
    staleError()
    staleClose()
    first.closeEvent()
    vi.advanceTimersByTime(8000)
    expect(resolved).not.toHaveBeenCalled()
    expect(rejected).toHaveBeenCalledTimes(1)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(disconnects).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(readWebSocketMetrics().connections).toBe(0)
    t.close()
  })

  it('ignores stale compact callbacks without corrupting fallback metrics or messages', async () => {
    const t = new WsTransport()
    const received = vi.fn()
    const disconnected = vi.fn()
    t.onMessage(received)
    t.onClose(disconnected)
    const p = t.connect('ws://x/ws')
    void p.catch(() => {})
    const first = FakeWebSocket.instances[0]!
    const stale = { open: first.onopen!, error: first.onerror!, close: first.onclose!, message: first.onmessage! }
    const initial = readWebSocketMetrics()
    first.error()
    expect(FakeWebSocket.instances).toHaveLength(2)
    const fallback = FakeWebSocket.instances[1]!
    stale.open()
    stale.error()
    stale.close()
    stale.message({ data: new Uint8Array([3, 99]).buffer })
    expect(readWebSocketMetrics()).toEqual(initial)
    expect(vi.getTimerCount()).toBe(1)
    fallback.open()
    await p
    const online = readWebSocketMetrics()
    expect(online.connections).toBe(initial.connections + 1)
    stale.open()
    stale.error()
    stale.close()
    stale.message({ data: new Uint8Array([3, 99]).buffer })
    expect(readWebSocketMetrics()).toEqual(online)
    expect(received).not.toHaveBeenCalled()
    expect(disconnected).not.toHaveBeenCalled()
    fallback.message([3, 1])
    t.send(new Uint8Array([2, 1, 2]))
    const traffic = readWebSocketMetrics()
    expect(traffic.receivedMessages - online.receivedMessages).toBe(1)
    expect(traffic.receivedBytes - online.receivedBytes).toBe(2)
    expect(traffic.sentMessages - online.sentMessages).toBe(1)
    expect(traffic.sentBytes - online.sentBytes).toBe(3)
    expect(received).toHaveBeenCalledExactlyOnceWith(new Uint8Array([3, 1]))
    t.close()
    expect(readWebSocketMetrics().connections).toBe(initial.connections)
  })

  it('keeps the original connect deadline while the fallback is pending', async () => {
    const t = new WsTransport()
    const rejected = vi.fn()
    const disconnected = vi.fn()
    t.onClose(disconnected)
    const p = t.connect('ws://x/ws')
    void p.catch(rejected)
    vi.advanceTimersByTime(7500)
    FakeWebSocket.instances[0]!.error()
    expect(FakeWebSocket.instances).toHaveLength(2)
    const fallback = FakeWebSocket.instances[1]!
    const staleOpen = fallback.onopen!
    const staleError = fallback.onerror!
    vi.advanceTimersByTime(499)
    expect(rejected).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    await expect(p).rejects.toThrow('ws connect timeout')
    expect(fallback.closed).toBe(true)
    expect(fallback.onopen).toBeNull()
    staleOpen()
    staleError()
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(rejected).toHaveBeenCalledTimes(1)
    expect(disconnected).not.toHaveBeenCalled()
    expect(readWebSocketMetrics().connections).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    t.close()
  })

  it('cancels a pending fallback and fences all of its late callbacks', async () => {
    const t = new WsTransport()
    const rejected = vi.fn()
    const received = vi.fn()
    const disconnected = vi.fn()
    t.onMessage(received)
    t.onClose(disconnected)
    const p = t.connect('ws://x/ws')
    void p.catch(rejected)
    FakeWebSocket.instances[0]!.error()
    expect(FakeWebSocket.instances).toHaveLength(2)
    const fallback = FakeWebSocket.instances[1]!
    const stale = { open: fallback.onopen!, error: fallback.onerror!, close: fallback.onclose!, message: fallback.onmessage! }
    await expect(t.connect('ws://x/ws')).rejects.toThrow('already connecting/connected')
    t.close()
    await expect(p).rejects.toThrow('ws transport closed')
    expect(fallback.closed).toBe(true)
    stale.open()
    stale.error()
    stale.close()
    stale.message({ data: new Uint8Array([3, 99]).buffer })
    vi.advanceTimersByTime(8000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(rejected).toHaveBeenCalledTimes(1)
    expect(received).not.toHaveBeenCalled()
    expect(disconnected).not.toHaveBeenCalled()
    expect(readWebSocketMetrics().connections).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects and clears the deadline if constructing the fallback throws', async () => {
    vi.stubGlobal('WebSocket', class extends FakeWebSocket {
      constructor(url: string, protocols?: string | string[]) {
        if (protocols === undefined) throw new Error('legacy construction blocked')
        super(url, protocols)
      }
    })
    const t = new WsTransport()
    const rejected = vi.fn()
    const disconnected = vi.fn()
    t.onClose(disconnected)
    const p = t.connect('ws://x/ws')
    void p.catch(rejected)
    const first = FakeWebSocket.instances[0]!
    expect(() => first.error()).not.toThrow()
    await expect(p).rejects.toThrow('legacy construction blocked')
    first.closeEvent()
    expect(rejected).toHaveBeenCalledTimes(1)
    expect(disconnected).not.toHaveBeenCalled()
    expect(readWebSocketMetrics().connections).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    t.close()
  })

  it('rejects a synchronous initial construction failure without fallback or a leaked deadline', async () => {
    const construct = vi.fn()
    vi.stubGlobal('WebSocket', class extends FakeWebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols)
        construct()
        throw new Error('socket construction blocked')
      }
    })
    const t = new WsTransport()
    await expect(t.connect('ws://x/ws')).rejects.toThrow('socket construction blocked')
    expect(construct).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(readWebSocketMetrics().connections).toBe(0)
    t.close()
  })

  it('8s 连接超时：reject、关 socket、摘回调', async () => {
    const t = new WsTransport()
    const p = t.connect('ws://x/ws')
    const ws = FakeWebSocket.instances[0]!
    const staleError = ws.onerror!
    const staleClose = ws.onclose!
    vi.advanceTimersByTime(8000)
    await expect(p).rejects.toThrow('ws connect timeout')
    expect(ws.closed).toBe(true)
    expect(ws.onclose).toBeNull() // 迟到的 close 不再生效
    staleError()
    staleClose()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('close() 掐断 CONNECTING：未决 connect 被取消，幂等', async () => {
    const t = new WsTransport()
    const p = t.connect('ws://x/ws')
    const ws = FakeWebSocket.instances[0]!
    const staleError = ws.onerror!
    const staleClose = ws.onclose!
    t.close()
    await expect(p).rejects.toThrow('ws transport closed')
    expect(ws.closed).toBe(true)
    expect(ws.onclose).toBeNull()
    staleError()
    staleClose()
    expect(FakeWebSocket.instances).toHaveLength(1)
    t.close() // 幂等
  })

  it('closed transport 拒绝再次 connect', async () => {
    const t = new WsTransport()
    t.close()
    await expect(t.connect('ws://x/ws')).rejects.toThrow('ws transport closed')
  })

  it.each([false, true])('does not fall back after open (legacy fallback=%s)', async (legacy) => {
    const t = new WsTransport()
    const disconnects: string[] = []
    t.onClose((r) => disconnects.push(r))
    const p = t.connect('ws://x/ws')
    if (legacy) FakeWebSocket.instances[0]!.error()
    const ws = FakeWebSocket.instances.at(-1)!
    ws.open()
    await p
    ws.error()
    expect(disconnects).toEqual([])
    expect(readWebSocketMetrics().connections).toBe(1)
    ws.closeEvent()
    expect(disconnects).toEqual(['与服务器的连接已断开'])
    expect(FakeWebSocket.instances).toHaveLength(legacy ? 2 : 1)
    expect(readWebSocketMetrics().connections).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ping 每 2s；8s 无入帧触发存活超时（单次断开）', async () => {
    const t = new WsTransport()
    const disconnects: string[] = []
    t.onClose((r) => disconnects.push(r))
    const p = t.connect('ws://x/ws')
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    await p
    vi.advanceTimersByTime(2000)
    expect(ws.sentBytes().at(-1)).toEqual([0]) // ping 帧
    ws.message([1, 9, 9]) // pong 刷新 liveness
    vi.advanceTimersByTime(2000 * 4 + 1100) // 超过 8s 无入帧
    const pings = ws.sent.filter((b) => new Uint8Array(b)[0] === 0).length
    expect(pings).toBeGreaterThanOrEqual(4)
    expect(disconnects).toEqual(['心跳超时，连接已断开'])
    expect(vi.getTimerCount()).toBe(0) // 超时后定时器全清
    t.close()
  })

  it('持续入帧不误报存活超时', async () => {
    const t = new WsTransport()
    const disconnects: string[] = []
    t.onClose((r) => disconnects.push(r))
    const p = t.connect('ws://x/ws')
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    await p
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(3000)
      ws.message([3, 1]) // 任意有效入帧都算活跃
    }
    expect(disconnects).toEqual([])
    t.close()
    expect(ws.closed).toBe(true)
  })

  it('pong 通知 + rtt 统计；服务器 ping 回 pong 并回显载荷', async () => {
    const t = new WsTransport()
    const pongs: number[] = []
    t.onPong(() => pongs.push(1))
    const p = t.connect('ws://x/ws')
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    await p
    vi.advanceTimersByTime(2000) // 发 ping，记 lastPingAt
    ws.message([1]) // pong
    expect(pongs).toHaveLength(1)
    expect(t.stats.rttMs).toBeGreaterThanOrEqual(0)
    ws.message([0, 7, 7, 7]) // 服务器 ping → 回 [1,7,7,7]
    expect(ws.sentBytes().at(-1)).toEqual([1, 7, 7, 7])
    t.close()
  })

  it('send 精确发送视图字节（带 offset 的 subarray）', async () => {
    const t = new WsTransport()
    const p = t.connect('ws://x/ws')
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    await p
    const backing = new Uint8Array([9, 9, 2, 4, 6, 8, 9])
    t.send(backing.subarray(2, 5)) // 只能发 [2,4,6]
    expect(ws.sentBytes().at(-1)).toEqual([2, 4, 6])
    t.close()
  })

  it('send 未 open 抛错', () => {
    const t = new WsTransport()
    expect(() => t.send(new Uint8Array([2]))).toThrow('ws not open')
  })

  it('close() 清空全部定时器且不触发 onClose', async () => {
    const t = new WsTransport()
    const disconnects: string[] = []
    t.onClose((r) => disconnects.push(r))
    const p = t.connect('ws://x/ws')
    FakeWebSocket.instances[0]!.open()
    await p
    expect(vi.getTimerCount()).toBe(2) // ping + liveness
    t.close()
    expect(vi.getTimerCount()).toBe(0)
    expect(disconnects).toEqual([]) // 主动关闭不上报断开
  })
})
