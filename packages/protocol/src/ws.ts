// WebSocket Transport 实现（默认）。
// 二进制帧（ArrayBuffer），与 protobuf 编解码配合；RTT 用 ping/pong 心跳估计。

import type { Transport, TransportStats } from './transport'

export class WsTransport implements Transport {
  private ws?: WebSocket
  private cb?: (msg: Uint8Array) => void
  private pongCb?: () => void
  private closeCb?: () => void
  private rttMs = 0
  private lastPing = 0
  private timer?: ReturnType<typeof setInterval>
  readonly stats: TransportStats = { rttMs: 0, lossRate: 0 }

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => {
        this.ws = ws
        this.timer = setInterval(() => {
          this.lastPing = performance.now()
          ws.send(new Uint8Array([0]).buffer) // frame kind 0 = ping
        }, 2000)
        resolve()
      }
      ws.onerror = () => {
        if (this.ws === undefined) reject(new Error(`ws connect failed: ${url}`))
        this.closeCb?.()
      }
      ws.onclose = () => this.closeCb?.() // socket 断开（服务器关闭/网络中断）
      ws.onmessage = (ev) => {
        const buf = new Uint8Array(ev.data as ArrayBuffer)
        if (buf[0] === 1) {
          this.rttMs = performance.now() - this.lastPing // kind 1 = pong
          this.stats.rttMs = this.rttMs
          this.pongCb?.() // 业务层看门狗计时刷新（同时保留内部消费）
          return
        }
        if (buf[0] === 0) {
          ws.send(new Uint8Array([1, ...buf.slice(1)])) // 服务器心跳 ping → 回 pong
          return
        }
        this.cb?.(buf)
      }
    })
  }

  /** 订阅 pong 心跳（业务层看门狗计时刷新）。 */
  onPong(cb: () => void): void {
    this.pongCb = cb
  }

  send(msg: Uint8Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('ws not open')
    this.ws.send(msg.buffer as ArrayBuffer)
  }

  onMessage(cb: (msg: Uint8Array) => void): () => void {
    this.cb = cb
    return () => { this.cb = undefined }
  }

  /** socket 断开回调（onclose/onerror-after-open）。 */
  onClose(cb: () => void): void {
    this.closeCb = cb
  }

  close(): void {
    clearInterval(this.timer)
    this.closeCb = undefined
    this.ws?.close()
  }
}
