// WebSocket Transport 实现（默认）。
// 二进制帧（ArrayBuffer），与 protobuf 编解码配合；RTT 用 ping/pong 心跳估计。
//
// 所有权约定（客户端连接健壮性）：
// - 一个 WsTransport 只 owns 一个 socket；重连由上层（RoomSession）新建 transport 驱动。
// - connect 超时 8s；open 后每 2s 发 ping，8s 内无任何有效入帧视为断线（liveness）。
// - 断开统一收敛为 onClose(reason) 单次回调；open 后的 error 交给 onclose 收口，不重复上报。
// - close() 幂等：掐断 CONNECTING/OPEN、清空全部定时器、摘除旧 socket 回调、取消未决 connect。
// - send 精确发送视图字节（按 byteOffset/length 切片），不发送底层共享 buffer 的多余内容。

import type { Transport, TransportStats } from './transport'

const CONNECT_TIMEOUT_MS = 8000
const PING_INTERVAL_MS = 2000
const LIVENESS_TIMEOUT_MS = 8000
const LIVENESS_CHECK_MS = 1000
const FRAME_PING = 0x00
const FRAME_PONG = 0x01

export class WsTransport implements Transport {
  private ws?: WebSocket
  private closed = false
  private cb?: (msg: Uint8Array) => void
  private pongCb?: () => void
  private closeCb?: (reason: string) => void
  private lastPingAt = 0
  private lastInboundAt = 0
  private connectTimer?: ReturnType<typeof setTimeout>
  private pingTimer?: ReturnType<typeof setInterval>
  private livenessTimer?: ReturnType<typeof setInterval>
  private rejectConnect?: (err: Error) => void
  readonly stats: TransportStats = { rttMs: 0, lossRate: 0 }

  connect(url: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('ws transport closed'))
    if (this.ws) return Promise.reject(new Error('ws transport already connecting/connected'))
    return new Promise((resolve, reject) => {
      let settled = false
      let opened = false
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      this.ws = ws
      this.rejectConnect = reject

      const settle = (err?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(this.connectTimer)
        this.connectTimer = undefined
        this.rejectConnect = undefined
        if (err) reject(err)
        else resolve()
      }

      this.connectTimer = setTimeout(() => {
        if (this.isCurrent(ws)) this.teardown()
        settle(new Error(`ws connect timeout: ${url}`))
      }, CONNECT_TIMEOUT_MS)

      ws.onopen = () => {
        if (!this.isCurrent(ws)) return
        opened = true
        this.lastInboundAt = Date.now()
        this.startHeartbeat(ws)
        settle()
      }
      ws.onerror = () => {
        if (!this.isCurrent(ws) || opened) return // open 后的 error 由 onclose 统一收口
        this.teardown()
        settle(new Error(`ws connect failed: ${url}`))
      }
      ws.onclose = () => {
        if (!this.isCurrent(ws)) return
        this.teardown()
        if (opened) {
          settle()
          this.closeCb?.('与服务器的连接已断开')
        } else {
          settle(new Error(`ws closed before open: ${url}`))
        }
      }
      ws.onmessage = (ev) => {
        if (!this.isCurrent(ws)) return
        const buf = new Uint8Array(ev.data as ArrayBuffer)
        if (buf.length === 0) return
        this.lastInboundAt = Date.now()
        if (buf[0] === FRAME_PONG) {
          this.stats.rttMs = Math.max(0, Date.now() - this.lastPingAt)
          this.pongCb?.()
          return
        }
        if (buf[0] === FRAME_PING) {
          const reply = new Uint8Array(buf.length)
          reply[0] = FRAME_PONG
          reply.set(buf.subarray(1), 1)
          this.internalSend(ws, reply) // 服务器心跳 ping → 回 pong（回显载荷）
          return
        }
        this.cb?.(buf)
      }
    })
  }

  /** 订阅 pong 心跳（业务层按需观测）。 */
  onPong(cb: () => void): void {
    this.pongCb = cb
  }

  /** 业务发送：异常原样上抛，由上层（RoomSession）决定转入重连。 */
  send(msg: Uint8Array): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('ws not open')
    ws.send(slice(msg))
  }

  onMessage(cb: (msg: Uint8Array) => void): () => void {
    this.cb = cb
    return () => { this.cb = undefined }
  }

  /** socket 断开回调（close-after-open / 心跳超时），每次连接至多一次。 */
  onClose(cb: (reason: string) => void): void {
    this.closeCb = cb
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.teardown()
    this.cb = undefined
    this.pongCb = undefined
    this.closeCb = undefined
    this.rejectConnect?.(new Error('ws transport closed')) // 取消未决 connect
    this.rejectConnect = undefined
  }

  private isCurrent(ws: WebSocket): boolean {
    return !this.closed && this.ws === ws
  }

  private startHeartbeat(ws: WebSocket): void {
    if (this.pingTimer !== undefined || this.livenessTimer !== undefined) return // 防重复
    this.pingTimer = setInterval(() => {
      this.lastPingAt = Date.now()
      this.internalSend(ws, new Uint8Array([FRAME_PING]))
    }, PING_INTERVAL_MS)
    this.livenessTimer = setInterval(() => {
      if (Date.now() - this.lastInboundAt > LIVENESS_TIMEOUT_MS) {
        this.teardown()
        this.closeCb?.('心跳超时，连接已断开')
      }
    }, LIVENESS_CHECK_MS)
  }

  /** 摘除当前 socket：清回调、清定时器、关闭 CONNECTING/OPEN。 */
  private teardown(): void {
    const ws = this.ws
    this.ws = undefined
    clearTimeout(this.connectTimer)
    this.connectTimer = undefined
    clearInterval(this.pingTimer)
    this.pingTimer = undefined
    clearInterval(this.livenessTimer)
    this.livenessTimer = undefined
    if (!ws) return
    ws.onopen = null
    ws.onerror = null
    ws.onclose = null
    ws.onmessage = null
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close()
  }

  /** 内部发送（心跳类）：失败视为连接已死，立即收敛为单次 onClose。 */
  private internalSend(ws: WebSocket, msg: Uint8Array): void {
    try {
      ws.send(slice(msg))
    } catch {
      this.teardown()
      this.closeCb?.('连接发送失败，已断开')
    }
  }
}

/** 精确切片视图字节：忽略底层 buffer 中视图之外的内容。 */
function slice(msg: Uint8Array): ArrayBuffer {
  return msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength) as ArrayBuffer
}
