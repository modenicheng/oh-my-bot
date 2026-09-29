// WebSocket Transport 实现（默认）。
// 二进制帧（ArrayBuffer），与 protobuf 编解码配合；RTT 用 ping/pong 心跳估计。

import type { Transport, TransportStats } from './transport'

export class WsTransport implements Transport {
  private ws?: WebSocket
  private cb?: (msg: Uint8Array) => void
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
      ws.onerror = () => reject(new Error(`ws connect failed: ${url}`))
      ws.onmessage = (ev) => {
        const buf = new Uint8Array(ev.data as ArrayBuffer)
        if (buf[0] === 1) {
          this.rttMs = performance.now() - this.lastPing // kind 1 = pong
          this.stats.rttMs = this.rttMs
          return
        }
        this.cb?.(buf)
      }
    })
  }

  send(msg: Uint8Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('ws not open')
    this.ws.send(msg.buffer as ArrayBuffer)
  }

  onMessage(cb: (msg: Uint8Array) => void): () => void {
    this.cb = cb
    return () => { this.cb = undefined }
  }

  close(): void {
    clearInterval(this.timer)
    this.ws?.close()
  }
}
