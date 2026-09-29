// 进房连接会话：WsTransport 拨号 + JoinRoom 握手 + 断线检测。
// 帧协议见 packages/protocol/src/messages.ts（0x02 上行 / 0x03 下行）。
import { WsTransport, decodeServer, encodeClient,
         JoinRoomSchema, ClientMsgSchema,
         type ServerMsg } from '@omb/protocol'
import { create } from '@bufbuild/protobuf'

export interface JoinOptions {
  roomCode: string
  nick: string
  color: string
  onMessage: (msg: ServerMsg) => void
  /** 传输层断开（socket close 或心跳超时）时回调一次 */
  onDisconnect: (reason: string) => void
}

export type SessionState = 'idle' | 'connecting' | 'online' | 'disconnected'

/** 单次连接会话；断开后不可复用，重新 joinRoom() 即可。 */
export class RoomSession {
  private transport = new WsTransport()
  private offMessage?: () => void
  private watchdog?: ReturnType<typeof setInterval>
  private lastPongAt = 0
  state: SessionState = 'idle'

  /** 连接 → 发送 JoinRoom → 等 onMessage 首帧确认在线。 */
  async connect(opts: JoinOptions): Promise<void> {
    this.state = 'connecting'
    let settled = false
    try {
      await this.transport.connect(wsUrl())
    } catch (err) {
      this.state = 'disconnected'
      throw new Error('无法连接服务器（端口 8080）', { cause: err })
    }

    // 心跳看门狗：WsTransport 的 ping/pong 每 2s 一轮，4s 无回包视为断线
    this.lastPongAt = Date.now()
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastPongAt > 4000) {
        this.fail(opts, '心跳超时，连接已断开')
      }
    }, 1000)

    this.offMessage = this.transport.onMessage((data) => {
      this.lastPongAt = Date.now() // pong 帧也会走到 decodeServer 的 null 分支
      const msg = decodeServer(data)
      if (msg) {
        if (!settled) {
          settled = true
          this.state = 'online'
        }
        opts.onMessage(msg)
      }
    })

    // socket 层断开（服务器关闭 / 网络中断）：transport.onClose 立即上报，无需等 4s 看门狗
    this.transport.onClose(() => this.fail(opts, '与服务器的连接已断开'))

    const join = create(JoinRoomSchema, {
      roomCode: opts.roomCode,
      nick: opts.nick,
      color: opts.color,
    })
    this.transport.send(encodeClient(create(ClientMsgSchema, { payload: { case: 'join', value: join } })))
  }

  private fail(opts: JoinOptions, reason: string): void {
    if (this.state === 'disconnected') return
    this.state = 'disconnected'
    opts.onDisconnect(reason)
  }

  send(msg: Parameters<WsTransport['send']>[0]): void {
    this.transport.send(msg)
  }

  get rttMs(): number {
    return this.transport.stats.rttMs
  }

  close(): void {
    if (this.watchdog) clearInterval(this.watchdog)
    this.offMessage?.()
    this.transport.close()
    this.state = 'idle'
  }
}

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.hostname}:8080/ws`
}

