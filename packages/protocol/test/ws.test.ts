// WsTransport 连接健壮性测试：close-before-open、connecting 取消、error+close 单次回调、
// 心跳/存活定时器清理、发送精确切片。全部使用 FakeWebSocket + fake timers。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WsTransport } from '../src/ws'

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

  constructor(public url: string) {
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

vi.stubGlobal('WebSocket', FakeWebSocket)

describe('WsTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('connect open 后 resolve，转发数据帧', async () => {
    const t = new WsTransport()
    const got: number[][] = []
    t.onMessage((m) => got.push(Array.from(m)))
    const p = t.connect('ws://x/ws')
    FakeWebSocket.instances[0]!.open()
    await p
    FakeWebSocket.instances[0]!.message([3, 1, 2])
    expect(got).toEqual([[3, 1, 2]])
    t.close()
  })

  it('close-before-open：connect reject、定时器清理、不报断开', async () => {
    const t = new WsTransport()
    const disconnects: string[] = []
    t.onClose((r) => disconnects.push(r))
    const p = t.connect('ws://x/ws')
    const ws = FakeWebSocket.instances[0]!
    ws.closeEvent()
    await expect(p).rejects.toThrow('ws closed before open')
    expect(vi.getTimerCount()).toBe(0)
    expect(disconnects).toEqual([]) // 从未连上：不算掉线
    t.close()
  })

  it('open 前 error：reject；随后 close 不重复报断开', async () => {
    const t = new WsTransport()
    const disconnects: string[] = []
    t.onClose((r) => disconnects.push(r))
    const p = t.connect('ws://x/ws')
    const ws = FakeWebSocket.instances[0]!
    ws.error()
    await expect(p).rejects.toThrow('ws connect failed')
    ws.closeEvent() // error 后往往紧跟 close：不得重复
    expect(disconnects).toEqual([])
    t.close()
  })

  it('8s 连接超时：reject、关 socket、摘回调', async () => {
    const t = new WsTransport()
    const p = t.connect('ws://x/ws')
    const ws = FakeWebSocket.instances[0]!
    vi.advanceTimersByTime(8000)
    await expect(p).rejects.toThrow('ws connect timeout')
    expect(ws.closed).toBe(true)
    expect(ws.onclose).toBeNull() // 迟到的 close 不再生效
    ws.closeEvent()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('close() 掐断 CONNECTING：未决 connect 被取消，幂等', async () => {
    const t = new WsTransport()
    const p = t.connect('ws://x/ws')
    const ws = FakeWebSocket.instances[0]!
    t.close()
    await expect(p).rejects.toThrow('ws transport closed')
    expect(ws.closed).toBe(true)
    expect(ws.onclose).toBeNull()
    t.close() // 幂等
  })

  it('closed transport 拒绝再次 connect', async () => {
    const t = new WsTransport()
    t.close()
    await expect(t.connect('ws://x/ws')).rejects.toThrow('ws transport closed')
  })

  it('open 后 error+close 收敛为单次 onClose(reason)', async () => {
    const t = new WsTransport()
    const disconnects: string[] = []
    t.onClose((r) => disconnects.push(r))
    const p = t.connect('ws://x/ws')
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    await p
    ws.error()
    ws.closeEvent()
    expect(disconnects).toEqual(['与服务器的连接已断开'])
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
