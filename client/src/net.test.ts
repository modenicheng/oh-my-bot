// RoomSession 自动重连测试：退避增长/封顶/抖动、握手超时、稳定清零、离线暂停、
// close 取消、陈旧消息丢弃、未在线不缓存输入、相同身份重进、join failed 终结。
// 真实 WsTransport + FakeWebSocket 全局桩 + fake timers；window 事件桥到真实 EventTarget。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { toBinary, fromBinary, create } from '@bufbuild/protobuf'
import { RoomSession, type JoinOptions, type SessionState } from './net'
import { frame, ServerMsgSchema, ServerEventSchema, EvSaySchema, EvRoomStateSchema, ClientMsgSchema,
  ClientInputSchema, ResyncRequestSchema, LeaveRoomSchema, encodeClient, EvControlNoticeSchema, EvControlNotice_Code,
  type ServerMsg } from '@omb/protocol'

const CONNECTING = 0
const OPEN = 1

/** 可控 WebSocket：手工驱动 open/error/close/message，记录发送字节。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static CONNECTING = CONNECTING
  static OPEN = OPEN
  static CLOSING = 2
  static CLOSED = 3
  readonly CONNECTING = CONNECTING
  readonly OPEN = OPEN
  readonly CLOSING = 2
  readonly CLOSED = 3
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
    if (this.readyState === CONNECTING || this.readyState === OPEN) this.readyState = 3
  }

  open(): void {
    this.readyState = OPEN
    this.onopen?.()
  }

  error(): void {
    this.onerror?.()
  }

  closeEvent(): void {
    this.readyState = 3
    this.onclose?.()
  }

  message(bytes: number[]): void {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer })
  }

  sentBytes(): number[][] {
    return this.sent.map((b) => Array.from(new Uint8Array(b)))
  }

  /** 上行 ClientMsg 帧（0x02 头）的完整字节。 */
  upFrames(): number[][] {
    return this.sentBytes().filter((b) => b[0] === frame.up)
  }
}

function down(msg: ServerMsg): number[] {
  return [frame.down, ...toBinary(ServerMsgSchema, msg)]
}

function sayFrame(text: string): number[] {
  return down(create(ServerMsgSchema, {
    payload: { case: 'event', value: create(ServerEventSchema, {
      kind: { case: 'say', value: create(EvSaySchema, { robot: 0, text }) },
    }) },
  }))
}

/** X-4：结构化控制通知帧。 */
function controlNoticeFrame(code: EvControlNotice_Code, text: string): number[] {
  return down(create(ServerMsgSchema, {
    payload: { case: 'event', value: create(ServerEventSchema, {
      kind: { case: 'controlNotice', value: create(EvControlNoticeSchema, { code, text }) },
    }) },
  }))
}

function roomStateFrame(): number[] {
  return down(create(ServerMsgSchema, {
    payload: { case: 'event', value: create(ServerEventSchema, {
      kind: { case: 'roomState', value: create(EvRoomStateSchema, {}) },
    }) },
  }))
}

/** Node 下 globalThis 无事件 API：把 window 事件桥接到真实 EventTarget。 */
let evtBus = new EventTarget()

describe('RoomSession', () => {
  let opts: JoinOptions
  let messages: ServerMsg[]
  let disconnects: string[]
  let states: Array<[SessionState, number | undefined]>
  let navigatorRef: { onLine: boolean }
  let docStub: EventTarget & { visibilityState: string }

  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    messages = []
    disconnects = []
    states = []
    navigatorRef = { onLine: true }
    docStub = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    evtBus = new EventTarget()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' })
    vi.stubGlobal('navigator', navigatorRef) // 普通对象：与真实浏览器 navigator 一致（非 EventTarget）
    vi.stubGlobal('document', docStub)
    vi.stubGlobal('addEventListener', evtBus.addEventListener.bind(evtBus))
    vi.stubGlobal('removeEventListener', evtBus.removeEventListener.bind(evtBus))
    vi.stubGlobal('dispatchEvent', evtBus.dispatchEvent.bind(evtBus))
    opts = {
      roomCode: 'R1', nick: 'cheng', color: '#fff',
      onMessage: (m) => messages.push(m),
      onDisconnect: (r) => disconnects.push(r),
      onStateChange: (s, retryIn) => states.push([s, retryIn]),
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  async function start(): Promise<RoomSession> {
    const s = new RoomSession()
    await s.connect(opts) // 立即返回
    return s
  }

  /** 冲刷微任务（connect promise 的 then 链）。 */
  async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0)
  }

  /** 打开当前 socket、喂 ack、断言 online。 */
  async function ack(s: RoomSession): Promise<FakeWebSocket> {
    const ws = FakeWebSocket.instances.at(-1)!
    ws.open()
    await flush() // join 发送
    ws.message(roomStateFrame())
    expect(s.state).toBe('online')
    return ws
  }

  /** 最近一次带倒计时的 reconnecting 上报。 */
  function lastRetryIn(): number {
    const entry = [...states].reverse().find(([st, r]) => st === 'reconnecting' && r !== undefined)
    if (!entry) throw new Error('no reconnecting delay recorded')
    return entry[1]!
  }

  it('connect 立即返回并进入 connecting；join ack 前保持 connecting', async () => {
    const s = await start()
    expect(s.state).toBe('connecting')
    expect(FakeWebSocket.instances).toHaveLength(1)
    s.close()
  })

  it('roomState/snapshot 均为 ack；say 事件不算 ack', async () => {
    const s = await start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.message(sayFrame('hello'))
    expect(s.state).toBe('connecting')
    ws.message(roomStateFrame())
    expect(s.state).toBe('online')
    s.close()
  })

  it('重进发送相同 room/nick/color 的 join 帧', async () => {
    const s = await start()
    const ws1 = await ack(s)
    ws1.closeEvent()
    await flush()
    await vi.advanceTimersByTimeAsync(1_000) // 首档退避 ≤600ms：新 socket 已建
    const ws2 = FakeWebSocket.instances[1]!
    ws2.open()
    await flush()
    expect(ws2.upFrames()).toHaveLength(1)
    expect(ws2.upFrames()[0]).toEqual(ws1.upFrames()[0]) // 完全一致的身份
    ws2.message(roomStateFrame())
    expect(s.state).toBe('online')
    s.close()
  })

  it('观战握手不带玩家身份；重连保持角色并仅允许 resync/leave 上行', async () => {
    const s = new RoomSession()
    await s.connect({ ...opts, spectator: true })
    const first = await ack(s)
    const handshake = fromBinary(ClientMsgSchema, new Uint8Array(first.upFrames()[0]!).subarray(1))
    expect(handshake.payload).toMatchObject({ case: 'spectate', value: { roomCode: opts.roomCode } })
    const before = first.upFrames().length
    const blocked = [
      create(ClientMsgSchema, { payload: { case: 'input', value: create(ClientInputSchema, { seq: 7, moveX: 1000 }) } }),
      create(ClientMsgSchema, { payload: { case: 'roomAction', value: { kind: 1 } } }),
      create(ClientMsgSchema, { payload: { case: 'scriptSubmit', value: { source: 'function tick() {}' } } }),
      create(ClientMsgSchema, { payload: { case: 'assistToggle', value: {} } }),
      create(ClientMsgSchema, { payload: { case: 'warmupInput', value: { seq: 8, moveX: 1000 } } }),
      create(ClientMsgSchema, { payload: { case: 'aiPrompt', value: { text: 'not allowed' } } }),
      create(ClientMsgSchema, { payload: { case: 'say', value: { text: 'not allowed' } } }),
      create(ClientMsgSchema, { payload: { case: 'join', value: { roomCode: opts.roomCode, nick: 'player' } } }),
      create(ClientMsgSchema, { payload: { case: 'spectate', value: { roomCode: 'ELSE' } } }),
    ]
    for (const message of blocked) s.send(encodeClient(message))
    s.send(new Uint8Array([frame.up, 255]))
    expect(first.upFrames()).toHaveLength(before)
    for (const message of [
      create(ClientMsgSchema, { payload: { case: 'resyncRequest', value: create(ResyncRequestSchema) } }),
      create(ClientMsgSchema, { payload: { case: 'leave', value: create(LeaveRoomSchema) } }),
    ]) s.send(encodeClient(message))
    expect(first.upFrames()).toHaveLength(before + 2)
    first.closeEvent()
    await vi.advanceTimersByTimeAsync(1000)
    const second = FakeWebSocket.instances.at(-1)!
    second.open()
    await flush()
    expect(second.upFrames()).toEqual([first.upFrames()[0]])
    s.close()
  })

  it('掉线：onDisconnect 恰一次、回调时已置 reconnecting（回调内 send 被丢弃）', async () => {
    const seen: Array<{ state: SessionState; drops: string[] }> = []
    const opts2: JoinOptions = {
      ...opts,
      onDisconnect: (r) => {
        seen.push({ state: s2.state, drops: [...drops] })
        s2.send(new Uint8Array([2, 1])) // 回调内 send：必须丢弃不递归
      },
    }
    const drops: string[] = []
    let s2!: RoomSession
    const s = await start()
    await ack(s)
    s2 = new RoomSession()
    await s2.connect({ ...opts2, onDisconnect: (r) => { drops.push(r); opts2.onDisconnect(r) } })
    const ws = FakeWebSocket.instances.at(-1)!
    ws.open()
    await flush()
    ws.message(roomStateFrame())
    ws.closeEvent()
    expect(drops).toEqual(['与服务器的连接已断开'])
    expect(seen[0]!.state).toBe('reconnecting')
    expect(s.state).toBe('online') // 另一会话不受影响
    ws.closeEvent()
    expect(drops).toHaveLength(1) // 迟到的不再追加
    s.close()
    s2.close()
  })

  it('指数退避增长、封顶 15s、抖动界 [0.8,1.2]×base', async () => {
    const s = await start()
    await ack(s)
    let prev = 500
    for (let i = 0; i < 7; i++) {
      FakeWebSocket.instances.at(-1)!.closeEvent()
      await flush()
      const delay = lastRetryIn()
      expect(delay).toBeGreaterThanOrEqual(Math.round(prev * 0.8) - 1)
      expect(delay).toBeLessThanOrEqual(Math.round(prev * 1.2) + 1)
      expect(delay).toBeLessThanOrEqual(15_000)
      prev = Math.min(15_000, prev * 2)
      await vi.advanceTimersByTimeAsync(delay) // 恰好到期：新 socket 建立（CONNECTING）
      expect(FakeWebSocket.instances).toHaveLength(i + 2)
    }
    // 末两档均已封顶：12000..15000
    const delay = lastRetryIn()
    expect(delay).toBeGreaterThanOrEqual(12_000)
    s.close()
  })

  it('连续在线 10s 后退避清零（下一次失败回到 500ms 档）', async () => {
    const s = await start()
    const ws = await ack(s)
    // 稳定期内持续入帧维持活跃，避免真实 liveness 超时先行掉线
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(2_000)
      ws.message([frame.down, 1])
    }
    ws.closeEvent()
    await flush()
    const delay = lastRetryIn()
    expect(delay).toBeGreaterThanOrEqual(400)
    expect(delay).toBeLessThanOrEqual(600)
    s.close()
  })

  it('握手超时（8s 无 ack）转 reconnecting，不上报 onDisconnect', async () => {
    const s = await start()
    FakeWebSocket.instances[0]!.open()
    await flush()
    await vi.advanceTimersByTimeAsync(8_000)
    expect(s.state).toBe('reconnecting')
    expect(disconnects).toEqual([])
    s.close()
  })

  it('握手期断开：只重连不上报', async () => {
    const s = await start()
    FakeWebSocket.instances[0]!.closeEvent()
    await flush()
    expect(s.state).toBe('reconnecting')
    expect(disconnects).toEqual([])
    s.close()
  })

  it('未 online 的 send 丢弃不抛错，不缓存不回放', async () => {
    const s = await start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    await flush() // join 已发
    const joinCount = ws.sent.length
    expect(joinCount).toBe(1)
    expect(() => s.send(new Uint8Array([2, 9, 9]))).not.toThrow()
    expect(ws.sent.length).toBe(joinCount) // 丢弃，不缓存
    ws.message(roomStateFrame()) // ack
    s.send(new Uint8Array([2, 1]))
    expect(ws.sent.length).toBe(joinCount + 1) // 仅 online 后这一条，无回放
    s.close()
  })

  it('陈旧 transport 的消息/断开事件一律忽略', async () => {
    const s = await start()
    const stale = await ack(s)
    stale.closeEvent()
    await flush()
    await vi.advanceTimersByTimeAsync(1_000) // 新尝试已建
    const freshCount = FakeWebSocket.instances.length
    stale.message(roomStateFrame()) // 陈旧消息
    stale.closeEvent()              // 陈旧断开（已被清理，不生效）
    expect(FakeWebSocket.instances).toHaveLength(freshCount)
    expect(messages).toHaveLength(1) // 仅最初 ack 那条
    expect(disconnects).toEqual(['与服务器的连接已断开']) // 仅合法那一次掉线
    s.close()
  })

  it('join failed 终结（旧服务器前缀 say 回退）：透传 onMessage + onDisconnect，不再重试', async () => {
    const s = await start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    await flush()
    ws.message(sayFrame('join failed: room full'))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.payload.case).toBe('event')
    expect(disconnects).toEqual(['进房失败：room full'])
    expect(s.state).toBe('disconnected')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1) // 无重拨
    s.close()
  })

  it('结构化 CN_JOIN_FAILED 通知同样终结（X-4 新路径）', async () => {
    const s = await start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    await flush()
    ws.message(controlNoticeFrame(EvControlNotice_Code.CN_JOIN_FAILED, 'room full'))
    expect(disconnects).toEqual(['进房失败：room full'])
    expect(s.state).toBe('disconnected')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1) // 无重拨
    s.close()
  })

  it('结构化通知 + 兼容 say 成对到达：say 在终结后到达不重拨', async () => {
    const s = await start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    await flush()
    ws.message(controlNoticeFrame(EvControlNotice_Code.CN_JOIN_FAILED, 'room full'))
    ws.message(sayFrame('join failed: room full')) // 成对兼容副本：会话已终结，静默丢弃
    expect(disconnects).toEqual(['进房失败：room full'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    s.close()
  })

  it('CN_READONLY_SPECTATOR 同样终结（观战只读契约拒绝）', async () => {
    const s = await start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    await flush()
    ws.message(controlNoticeFrame(EvControlNotice_Code.CN_READONLY_SPECTATOR, 'readonly spectator connection'))
    expect(disconnects[0]).toContain('readonly spectator connection')
    expect(s.state).toBe('disconnected')
    s.close()
  })

  it('AI 类结构化通知不终结会话（非 join 拒绝）', async () => {
    const s = await start()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    await flush()
    ws.message(roomStateFrame()) // 先 ack 上线
    expect(s.state).toBe('online')
    ws.message(controlNoticeFrame(EvControlNotice_Code.CN_AI_EXPLAIN, 'AI 改动说明：x'))
    expect(s.state).toBe('online')
    expect(disconnects).toEqual([])
    s.close()
  })

  it('close() 取消一切：无残留定时器、迟到事件不生效', async () => {
    const s = await start()
    const ws = await ack(s)
    ws.closeEvent()
    await flush()
    s.close()
    expect(s.state).toBe('idle')
    expect(vi.getTimerCount()).toBe(0)
    ws.message(roomStateFrame())
    ws.closeEvent()
    expect(messages).toHaveLength(1)      // 迟到消息丢弃
    expect(disconnects).toEqual(['与服务器的连接已断开']) // 不追加
  })

  it('retryNow() 立即重拨；connecting/online/离线时 no-op', async () => {
    const s = await start()
    await ack(s)
    FakeWebSocket.instances.at(-1)!.closeEvent()
    await flush()
    expect(s.state).toBe('reconnecting')
    s.retryNow() // reconnecting：立即
    expect(FakeWebSocket.instances).toHaveLength(2)
    s.retryNow() // connecting：no-op
    expect(FakeWebSocket.instances).toHaveLength(2)
    const ws2 = FakeWebSocket.instances.at(-1)!
    ws2.open()
    await flush()
    ws2.message(roomStateFrame())
    s.retryNow() // online：no-op
    expect(FakeWebSocket.instances).toHaveLength(2)
    s.close()
  })

  it('离线暂停：挂起重试、不拨号；online 事件立即恢复', async () => {
    const s = await start()
    await ack(s)
    FakeWebSocket.instances.at(-1)!.closeEvent()
    await flush()
    evtBus.dispatchEvent(new Event('offline'))
    const count = FakeWebSocket.instances.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(FakeWebSocket.instances).toHaveLength(count) // 暂停期不拨号
    navigatorRef.onLine = true
    evtBus.dispatchEvent(new Event('online'))
    expect(FakeWebSocket.instances).toHaveLength(count + 1) // 恢复立即拨
    s.close()
  })

  it('在线转离线立即暂停输入并通知 UI，恢复网络再重连', async () => {
    const s = await start()
    const ws = await ack(s)
    navigatorRef.onLine = false
    evtBus.dispatchEvent(new Event('offline'))
    expect(s.state).toBe('reconnecting')
    expect(states.at(-1)).toEqual(['reconnecting', undefined])
    expect(disconnects).toEqual(['网络已离线'])
    expect(ws.closed).toBe(true)
    s.send(new Uint8Array([2, 9]))
    s.retryNow()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    navigatorRef.onLine = true
    evtBus.dispatchEvent(new Event('online'))
    expect(FakeWebSocket.instances).toHaveLength(2)
    s.close()
  })

  it('机器人普通发言不能伪造进房失败', async () => {
    const s = await start()
    const ws = await ack(s)
    ws.message(down(create(ServerMsgSchema, { payload: { case: 'event', value: create(ServerEventSchema, {
      kind: { case: 'say', value: create(EvSaySchema, { robot: 12, text: 'join failed: joke' }) },
    }) } })))
    expect(s.state).toBe('online')
    expect(disconnects).toHaveLength(0)
    s.close()
  })

  it('离线中 connect/retryNow 不拨号；online 后恢复', async () => {
    navigatorRef.onLine = false
    const s = await start()
    expect(FakeWebSocket.instances).toHaveLength(0) // 离线不拨
    expect(s.state).toBe('connecting') // 意图保留
    s.retryNow()
    expect(FakeWebSocket.instances).toHaveLength(0)
    navigatorRef.onLine = true
    evtBus.dispatchEvent(new Event('online'))
    expect(FakeWebSocket.instances).toHaveLength(1)
    s.close()
  })

  it('回前台且在线：取消挂起退避立即重拨（不重复）', async () => {
    const s = await start()
    await ack(s)
    FakeWebSocket.instances.at(-1)!.closeEvent()
    await flush()
    docStub.visibilityState = 'hidden'
    docStub.dispatchEvent(new Event('visibilitychange')) // 后台：不动作
    expect(FakeWebSocket.instances).toHaveLength(1)
    docStub.visibilityState = 'visible'
    docStub.dispatchEvent(new Event('visibilitychange')) // 回前台：立即重拨
    expect(FakeWebSocket.instances).toHaveLength(2)
    docStub.dispatchEvent(new Event('visibilitychange')) // 重复前台事件：不重复拨
    expect(FakeWebSocket.instances).toHaveLength(2)
    s.close()
  })

  it('onStateChange 全轨迹含 retryInMs', async () => {
    const s = await start()
    await ack(s)
    FakeWebSocket.instances.at(-1)!.closeEvent()
    await flush()
    const seq = states.map(([st]) => st)
    expect(seq).toEqual(['connecting', 'online', 'reconnecting'])
    expect(lastRetryIn()).toBeGreaterThanOrEqual(400)
    s.close()
  })
})
