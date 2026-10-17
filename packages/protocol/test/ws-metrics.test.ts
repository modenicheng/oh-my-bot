import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WsTransport } from '../src/ws'
import { readWebSocketMetrics } from '../src/ws-metrics'

class Socket {
  static CONNECTING = 0
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 0
  binaryType = ''
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null
  send = vi.fn((_data: ArrayBuffer) => {})
  constructor(_url: string) { Socket.instances.push(this) }
  open(): void { this.readyState = 1; this.onopen?.() }
  close(): void { this.readyState = 3 }
  disconnect(): void { this.close(); this.onclose?.() }
  message(bytes: number[]): void { this.onmessage?.({ data: new Uint8Array(bytes).buffer }) }
}

const transports: WsTransport[] = []
function connect() {
  const transport = new WsTransport()
  transports.push(transport)
  const promise = transport.connect('ws://test/ws')
  return { transport, promise, socket: Socket.instances.at(-1)! }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', Socket)
  Socket.instances = []
})
afterEach(() => {
  for (const transport of transports) transport.close()
  transports.length = 0
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('application WS diagnostics', () => {
  it('counts open connections only, removes measured RTT on disconnect and supports concurrent sockets', async () => {
    expect(readWebSocketMetrics().connections).toBe(0)
    const first = connect()
    const second = connect()
    expect(readWebSocketMetrics().connections).toBe(0)
    first.socket.open()
    second.socket.open()
    await Promise.all([first.promise, second.promise])
    expect(readWebSocketMetrics()).toMatchObject({ connections: 2, rttMs: null })
    vi.advanceTimersByTime(2000)
    vi.advanceTimersByTime(35)
    first.socket.message([1])
    vi.advanceTimersByTime(25)
    second.socket.message([1])
    expect(readWebSocketMetrics()).toMatchObject({ connections: 2, rttMs: 60 })
    second.socket.disconnect()
    expect(readWebSocketMetrics()).toMatchObject({ connections: 1, rttMs: 35 })
    second.transport.close()
    expect(readWebSocketMetrics().connections).toBe(1)
    first.transport.close()
    expect(readWebSocketMetrics()).toMatchObject({ connections: 0, rttMs: null })
  })

  it('counts exact payload bytes, all message types and heartbeat traffic without retaining frames', async () => {
    const before = readWebSocketMetrics()
    const { transport, socket, promise } = connect()
    socket.open()
    await promise
    transport.send(new Uint8Array([99, 2, 4, 6, 99]).subarray(1, 4))
    socket.message([3, 8, 9, 10])
    socket.message([0, 7, 7]) // Server ping generates a three-byte pong.
    socket.message([])
    vi.advanceTimersByTime(2000) // Client ping adds one outbound byte.
    vi.advanceTimersByTime(20)
    socket.message([1])
    const after = readWebSocketMetrics()
    expect(after.receivedBytes - before.receivedBytes).toBe(8)
    expect(after.sentBytes - before.sentBytes).toBe(7)
    expect(after.receivedMessages - before.receivedMessages).toBe(4)
    expect(after.sentMessages - before.sentMessages).toBe(3)
    const target = { ...after }
    expect(readWebSocketMetrics(target)).toBe(target)
    expect(target).toEqual(after)
  })

  it('excludes failed sends and stale callbacks and keeps cumulative totals over reconnects', async () => {
    const before = readWebSocketMetrics()
    const first = connect()
    first.socket.open()
    await first.promise
    const staleMessage = first.socket.onmessage!
    first.socket.send.mockImplementation(() => { throw new Error('closed') })
    expect(() => first.transport.send(new Uint8Array([2, 5]))).toThrow('closed')
    vi.advanceTimersByTime(2000) // Failed internal ping tears the connection down.
    expect(readWebSocketMetrics().connections).toBe(0)
    staleMessage({ data: new Uint8Array([3, 1, 2]).buffer })
    const second = connect()
    second.socket.open()
    await second.promise
    second.transport.send(new Uint8Array([2, 1]))
    const after = readWebSocketMetrics()
    expect(after.sentBytes - before.sentBytes).toBe(2)
    expect(after.sentMessages - before.sentMessages).toBe(1)
    expect(after.receivedMessages).toBe(before.receivedMessages)
    second.transport.close()
    expect(readWebSocketMetrics().sentBytes).toBe(after.sentBytes)
  })

  it('does not report unsolicited pongs as measured RTT and drops timed-out connections', async () => {
    const { socket, promise } = connect()
    socket.open()
    await promise
    socket.message([1])
    expect(readWebSocketMetrics().rttMs).toBeNull()
    vi.advanceTimersByTime(9100)
    expect(readWebSocketMetrics()).toMatchObject({ connections: 0, rttMs: null })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not leak a connection when a pending connect is cancelled', async () => {
    const { transport, promise } = connect()
    transport.close()
    await expect(promise).rejects.toThrow('closed')
    expect(readWebSocketMetrics().connections).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
