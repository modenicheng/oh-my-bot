// 房间页主流程：进房表单 → WS 连接 + JoinRoom → 房间大厅。
// 样式令牌见 client/STYLE.md；连接层见 client/src/net.ts。
import { create } from '@bufbuild/protobuf'
import { ClientMsgSchema, LeaveRoomSchema,
         type ServerMsg } from '@omb/protocol'
import { encodeClient } from '@omb/protocol'
import { RoomSession } from './net'

// ---- 常量 ---------------------------------------------------------------

const PRESET_COLORS = [
  '#22d3ee', '#a3e635', '#f472b6', '#ff5c5c',
  '#fbbf24', '#a78bfa', '#34d399', '#f97316',
] as const

const ROOM_CODE_RE = /^[A-Z0-9]{6}$/
const NICK_RE = /^.{1,16}$/

// ---- DOM ----------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const app = $('app') as HTMLDivElement & { classList: DOMTokenList }
const viewJoin = $<HTMLElement>('view-join')
const viewRoom = $<HTMLElement>('view-room')
const inRoom = $<HTMLInputElement>('in-room')
const inNick = $<HTMLInputElement>('in-nick')
const swatches = $<HTMLDivElement>('swatches')
const btnJoin = $<HTMLButtonElement>('btn-join')
const formError = $<HTMLDivElement>('form-error')
const roomCodeEl = $<HTMLDivElement>('room-code')
const membersEl = $<HTMLUListElement>('members')
const roomStateEl = $<HTMLDivElement>('room-state')
const statusText = $<HTMLSpanElement>('status-text')
const btnReconnect = $<HTMLButtonElement>('btn-reconnect')

// ---- 进房表单 ---------------------------------------------------------------

let selectedColor: string = PRESET_COLORS[0]!

for (const color of PRESET_COLORS) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'swatch' + (color === selectedColor ? ' sel' : '')
  b.style.setProperty('--sw', color)
  b.title = color
  b.setAttribute('aria-label', `颜色 ${color}`)
  b.addEventListener('click', () => {
    selectedColor = color
    for (const el of swatches.children) el.classList.toggle('sel', el === b)
  })
  swatches.appendChild(b)
}

// ?room=CODE 完整链接解析（自动大写、截断到 6 位）
const params = new URLSearchParams(location.search)
const fromLink = (params.get('room') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
if (fromLink) inRoom.value = fromLink

/** 输入即时规范化：房间码大写、仅 A-Z0-9；昵称截断 16 字。 */
function normalize(): void {
  const pos = inRoom.selectionStart
  inRoom.value = inRoom.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
  if (pos !== null) inRoom.setSelectionRange(pos, pos)
  inNick.value = inNick.value.slice(0, 16)
}

inRoom.addEventListener('input', () => { normalize(); showFormError('') })
inNick.addEventListener('input', () => { normalize(); showFormError('') })

function validate(): string | null {
  if (!ROOM_CODE_RE.test(inRoom.value)) return '房间码需为 6 位字母/数字'
  const nick = inNick.value.trim()
  if (!NICK_RE.test(nick)) return '昵称需为 1-16 个字符'
  return null
}

// ---- 视图切换与状态行 ----------------------------------------------------------

function showView(view: 'join' | 'room'): void {
  viewJoin.hidden = view === 'room'
  viewRoom.hidden = view === 'join'
}

function setStatus(kind: 'ok' | 'down' | 'off', text: string): void {
  app.classList.toggle('ok', kind === 'ok')
  app.classList.toggle('down', kind === 'down')
  statusText.textContent = text
}

function showFormError(msg: string): void {
  formError.textContent = msg
}

// ---- 连接会话 ---------------------------------------------------------------

let session: RoomSession | null = null
let lastJoin: { roomCode: string; nick: string; color: string } | null = null

async function join(): Promise<void> {
  showFormError('')
  const invalid = validate()
  if (invalid) return showFormError(invalid)

  void joinWith(inRoom.value, inNick.value.trim(), selectedColor)
}

async function joinWith(roomCode: string, nick: string, color: string): Promise<void> {
  btnJoin.disabled = true
  setStatus('off', 'connecting…')

  session?.close()
  const s = new RoomSession()
  session = s

  try {
    await s.connect({
      roomCode,
      nick,
      color,
      onMessage: (msg) => onServerMsg(roomCode, msg),
      onDisconnect: (reason) => onDisconnected(reason),
    })
    lastJoin = { roomCode, nick, color }
  } catch (err) {
    s.close()
    session = null
    btnJoin.disabled = false
    setStatus('down', '连接失败')
    showFormError(err instanceof Error ? err.message : '连接失败，请重试')
    return
  }

  // 连接 + JoinRoom 已发出；进入大厅，等服务器首帧回包确认
  roomCodeEl.textContent = roomCode
  roomStateEl.textContent = '已发送进房请求，等待服务器…'
  showView('room')
  startRttLoop(s)
}

function onDisconnected(reason: string): void {
  stopRttLoop()
  session?.close()
  session = null
  btnJoin.disabled = false // 修复：无论从哪个阶段断开，恢复进房按钮
  setStatus('down', reason)
  roomStateEl.textContent = '离线'
  btnReconnect.hidden = false
}

function onServerMsg(roomCode: string, msg: ServerMsg): void {
  if (session && roomCode) setStatus('ok', 'connected')
  if (msg.payload.case === 'event') {
    const ev = msg.payload.value
    if (ev.kind.case === 'roomState') {
      const rs = ev.kind.value
      const stateName = ['空闲', '热身中', '对局中', '已结束'][rs.state] ?? `状态${rs.state}`
      roomStateEl.textContent = `房间 ${stateName} · 房主 ${rs.hostNick || '—'} · 机器人 ${rs.robotsOnline}`
    }
  }
}

btnJoin.addEventListener('click', () => void join())
inRoom.addEventListener('keydown', (e) => { if (e.key === 'Enter') void join() })
inNick.addEventListener('keydown', (e) => { if (e.key === 'Enter') void join() })

btnReconnect.addEventListener('click', () => {
  btnReconnect.hidden = true
  if (!lastJoin) { // 无历史参数（理论不可达）：退回表单
    showView('join')
    setStatus('off', 'idle')
    return
  }
  // 用上次成功参数直接重试：重连是恢复动作，不该让用户重新填表
  setStatus('off', '重连中…')
  void joinWith(lastJoin.roomCode, lastJoin.nick, lastJoin.color)
})

// ---- 心跳 RTT 状态行（沿用探针逻辑） ----------------------------------

let rttTimer: ReturnType<typeof setInterval> | undefined

function startRttLoop(s: RoomSession): void {
  stopRttLoop()
  rttTimer = setInterval(() => {
    if (session === s && s.state === 'online') {
      setStatus('ok', `connected · rtt ${s.rttMs.toFixed(0)}ms`)
    }
  }, 1000)
}

function stopRttLoop(): void {
  if (rttTimer) clearInterval(rttTimer)
  rttTimer = undefined
}

// 离开页面时通知服务器
window.addEventListener('beforeunload', () => {
  if (session?.state === 'online') {
    try {
      session.send(encodeClient(create(ClientMsgSchema, { payload: { case: 'leave', value: create(LeaveRoomSchema, {}) } })))
    } catch { /* socket 已关则忽略 */ }
  }
  session?.close()
})
