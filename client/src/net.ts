// 进房连接会话：WsTransport 拨号 + JoinRoom 握手 + 断线自动重连（指数退避）。
// 帧协议见 packages/protocol/src/messages.ts（0x02 上行 / 0x03 下行）。
// 心跳与存活检测完全下沉到 WsTransport；本层负责握手超时、重试节奏与状态上报。
// 断线后以相同 room/nick/color 自动重进；close() 后会话不可复用（重新 joinRoom）。
import { WsTransport, decodeServer, encodeClient,
         JoinRoomSchema, SpectateRoomSchema, ClientMsgSchema, frame, joinRejection,
         type ServerMsg } from '@omb/protocol'
import { create, fromBinary } from '@bufbuild/protobuf'

export interface JoinOptions {
  roomCode: string
  nick: string
  color: string
  spectator?: boolean
  onMessage: (msg: ServerMsg) => void
  /** 已建立的连接断开（socket close / 心跳超时）时回调，每次掉线恰好一次 */
  onDisconnect: (reason: string) => void
  /** 状态迁移回调；reconnecting 时附带下次尝试倒计时 ms（离线暂停期可缺省） */
  onStateChange?: (state: SessionState, retryInMs?: number) => void
}

export type SessionState = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'disconnected'

const HANDSHAKE_TIMEOUT_MS = 8000  // 连接 + 进房确认总超时
const RETRY_BASE_MS = 500
const RETRY_MAX_MS = 15000
const STABLE_RESET_MS = 10000      // 连续在线 10s 后退避清零

/** 浏览器/Node 环境探测：事件挂 globalThis（浏览器 window 上 navigator 非 EventTarget）。 */
function netTarget(): EventTarget | undefined {
  const g = globalThis as unknown as { addEventListener?: unknown }
  return typeof g.addEventListener === 'function' ? (g as EventTarget) : undefined
}

function isOfflineEnv(): boolean {
  const nav = (globalThis as unknown as { navigator?: { onLine?: boolean } }).navigator
  return nav?.onLine === false
}

type VisDoc = { visibilityState?: string }
function visibilityState(): string | undefined {
  return (globalThis as unknown as { document?: VisDoc }).document?.visibilityState
}

/** 仅 roomState / mapBootstrap / snapshot 视为进房确认，不认任意事件。 */
function isJoinAck(msg: ServerMsg): boolean {
  if (msg.payload.case === 'snapshot') return true
  if (msg.payload.case === 'event') {
    const kind = msg.payload.value.kind.case
    return kind === 'roomState' || kind === 'mapBootstrap'
  }
  return false
}

/** 带自动重连的房间会话；一次 connect 起步，断线自动以相同身份重进。 */
export class RoomSession {
  private opts?: JoinOptions
  private transport?: WsTransport
  private gen = 0             // 尝试代号：旧尝试的一切回调一律作废
  private attempts = 0        // 连续失败次数（退避指数）
  private handshakeTimer?: ReturnType<typeof setTimeout>
  private retryTimer?: ReturnType<typeof setTimeout>
  private stableTimer?: ReturnType<typeof setTimeout>
  private retryPaused = false // 离线暂停中，等 online 事件恢复
  private offline = false
  private closed = false
  private netBound = false
  private docTarget?: EventTarget
  state: SessionState = 'idle'

  /** 启动首个连接尝试；立即返回，后续节奏经 onStateChange/onDisconnect 上报。 */
  async connect(opts: JoinOptions): Promise<void> {
    if (this.closed) throw new Error('session closed')
    if (this.opts) throw new Error('session already started')
    this.opts = opts
    this.offline = isOfflineEnv()
    this.bindNetEvents()
    this.startAttempt()
  }

  /** 立即重试：取消挂起的退避定时器马上拨号；connecting/online/离线暂停时 no-op。 */
  retryNow(): void {
    if (this.closed || !this.opts || this.offline) return
    if (this.state === 'connecting' || this.state === 'online') return
    this.startAttempt()
  }

  /** 上行发送：返回是否已交给在线 transport；不排队、不回放。 */
  send(msg: Uint8Array): boolean {
    if (this.state !== 'online' || !this.transport) return false
    if (this.opts?.spectator) {
      try {
        if (msg[0] !== frame.up) return false
        const payload = fromBinary(ClientMsgSchema, msg.subarray(1)).payload.case
        if (payload !== 'resyncRequest' && payload !== 'leave') return false
      } catch { return false }
    }
    try {
      this.transport.send(msg)
      return true
    } catch {
      this.loseConnection(this.gen, '连接已中断')
      return false
    }
  }

  get rttMs(): number {
    return this.transport?.stats.rttMs ?? 0
  }

  /** 关闭会话：取消在途回调/定时器/网络监听；幂等。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.gen += 1 // 作废一切在途回调
    this.clearTimers()
    this.unbindNetEvents()
    this.transport?.close()
    this.transport = undefined
    this.retryPaused = false
    this.setState('idle')
  }

  // ---- 内部：单次尝试 ------------------------------------------------------

  private startAttempt(): void {
    if (this.closed || !this.opts) return
    if (this.offline) {
      // 浏览器报离线：不拨号，等 online 事件恢复（连接意图保留）
      this.retryPaused = true
      this.setState('connecting')
      return
    }
    const opts = this.opts
    const gen = ++this.gen
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.retryPaused = false
    this.setState('connecting')

    const t = new WsTransport()
    this.transport = t
    t.onMessage((data) => this.onFrame(gen, data))
    t.onClose((reason) => this.onTransportClosed(gen, reason))
    this.handshakeTimer = setTimeout(() => this.failAttempt(gen), HANDSHAKE_TIMEOUT_MS)

    t.connect(wsUrl()).then(
      () => {
        if (this.closed || gen !== this.gen) return
        try {
          const message = opts.spectator
            ? create(ClientMsgSchema, { payload: { case: 'spectate', value: create(SpectateRoomSchema, { roomCode: opts.roomCode }) } })
            : create(ClientMsgSchema, { payload: { case: 'join', value: create(JoinRoomSchema, {
              roomCode: opts.roomCode, nick: opts.nick, color: opts.color,
            }) } })
          t.send(encodeClient(message))
        } catch {
          this.failAttempt(gen)
        }
      },
      () => this.failAttempt(gen),
    )
  }

  private onFrame(gen: number, data: Uint8Array): void {
    if (this.closed || gen !== this.gen || !this.opts) return
    let msg: ServerMsg | null
    try {
      msg = decodeServer(data)
    } catch {
      return // 畸形帧丢弃
    }
    if (!msg) return
    // X-4：结构化 join 拒绝通知优先；旧服务器回退解析 "join failed:" 前缀 say
    const rejection = joinRejection(msg)
    if (rejection !== undefined) {
      // 进房被拒（房间满/码无效等）：终结会话，原因交上层展示
      this.terminalFail(gen, rejection.reason, msg)
      return
    }
    if (this.state !== 'online' && isJoinAck(msg)) this.confirmOnline()
    this.opts.onMessage(msg)
  }

  private confirmOnline(): void {
    clearTimeout(this.handshakeTimer)
    this.handshakeTimer = undefined
    this.setState('online')
    this.stableTimer = setTimeout(() => {
      this.stableTimer = undefined
      this.attempts = 0 // 连续在线满 10s：退避清零
    }, STABLE_RESET_MS)
  }

  private onTransportClosed(gen: number, reason: string): void {
    if (this.closed || gen !== this.gen) return
    if (this.state === 'online') this.loseConnection(gen, reason)
    else this.failAttempt(gen) // 握手期断开：不算“已连上后掉线”
  }

  /** 已在线连接的丢失：先立 fence（状态/换代/摘 transport）再回调，防 release→send 递归。 */
  private loseConnection(gen: number, reason: string): void {
    if (this.closed || gen !== this.gen || !this.opts) return
    this.gen += 1 // 立即作废本连接的一切后续事件
    this.clearTimers()
    const opts = this.opts
    this.transport?.close()
    this.transport = undefined
    this.state = 'reconnecting' // 静默 fence：回调内 send() 必然丢弃，防 release→send 递归
    opts.onDisconnect(reason)    // 上层可在此安全 close()/retryNow()
    if (this.closed || this.state !== 'reconnecting') return // 回调已 close 或已重拨
    this.scheduleRetry(opts)
  }

  private terminalFail(gen: number, reason: string, msg: ServerMsg): void {
    if (this.closed || gen !== this.gen || !this.opts) return
    this.gen += 1
    this.clearTimers()
    const opts = this.opts
    this.opts = undefined // 终结：不再重试
    this.unbindNetEvents()
    this.transport?.close()
    this.transport = undefined
    this.state = 'disconnected'
    opts.onStateChange?.('disconnected')
    opts.onMessage(msg) // join failed 透传，由上层收口 UI
    opts.onDisconnect(`进房失败：${reason}`)
  }

  private failAttempt(gen: number): void {
    if (this.closed || gen !== this.gen || !this.opts) return
    this.gen += 1 // 本次尝试终结：在途回调全部作废，防重复 schedule
    this.clearTimers()
    this.transport?.close()
    this.transport = undefined
    this.scheduleRetry(this.opts)
  }

  private scheduleRetry(opts: JoinOptions): void {
    if (this.closed || !opts) return
    const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.attempts)
    this.attempts += 1
    if (this.offline) {
      this.retryPaused = true // 离线：不排定时器、不发倒计时，等 online 事件立即恢复
      this.setState('reconnecting')
      return
    }
    const delay = Math.min(RETRY_MAX_MS, Math.round(base * (0.8 + Math.random() * 0.4)))
    this.setState('reconnecting', delay)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.startAttempt()
    }, delay)
  }

  private clearTimers(): void {
    clearTimeout(this.handshakeTimer)
    clearTimeout(this.retryTimer)
    clearTimeout(this.stableTimer)
    this.handshakeTimer = this.retryTimer = this.stableTimer = undefined
  }

  private setState(state: SessionState, retryInMs?: number): void {
    this.state = state
    this.opts?.onStateChange?.(state, retryInMs)
  }

  // ---- 内部：离线暂停 / 前台恢复 -------------------------------------------

  private bindNetEvents(): void {
    if (this.netBound) return
    const target = netTarget()
    if (!target) return
    this.netBound = true
    // navigator 在浏览器里不是 EventTarget：online/offline 挂 window（=globalThis）
    target.addEventListener('offline', this.handleOffline)
    target.addEventListener('online', this.handleOnline)
    // visibilitychange 只在 document 上触发（不冒泡到 window）
    const d = (globalThis as unknown as { document?: EventTarget & { visibilityState?: string } }).document
    if (d && typeof d.addEventListener === 'function') {
      this.docTarget = d
      d.addEventListener('visibilitychange', this.handleVisibility)
    }
  }

  private unbindNetEvents(): void {
    if (!this.netBound) return
    this.netBound = false
    const target = netTarget()
    target?.removeEventListener('offline', this.handleOffline)
    target?.removeEventListener('online', this.handleOnline)
    this.docTarget?.removeEventListener('visibilitychange', this.handleVisibility)
    this.docTarget = undefined
  }

  private handleOffline = (): void => {
    this.offline = true
    if (this.state === 'online') {
      this.loseConnection(this.gen, '网络已离线')
      return
    }
    if (this.state === 'connecting' && this.transport) {
      this.failAttempt(this.gen)
      return
    }
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
      this.retryPaused = true
      this.setState('reconnecting')
    }
  }

  private handleOnline = (): void => {
    this.offline = false
    if (this.retryPaused) {
      this.retryPaused = false
      this.startAttempt() // 网络恢复：立即拨号
    }
  }

  private handleVisibility = (): void => {
    // 回前台且在线：立刻重试，不等退避走完；connecting 中不重复触发
    if (visibilityState() !== 'visible' || this.offline) return
    if (this.state === 'reconnecting' && this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
      this.startAttempt()
    }
  }
}

function wsUrl(): string {
  // 同源端口（服务器 embed 前端，HTTP/WS 同端口）；vite dev 由 proxy 转发
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
}
