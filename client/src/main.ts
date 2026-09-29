// 房间页主流程：进房表单 → WS 连接 + JoinRoom → 房间大厅；mapBootstrap 后切游戏视图。
// 样式令牌见 client/STYLE.md；连接层见 client/src/net.ts；游戏视图见 client/src/game/。
import { create } from '@bufbuild/protobuf'
import { ClientMsgSchema, LeaveRoomSchema, RoomActionSchema,
         RoomAction_Kind, EvRoomState_State,
         type ServerMsg } from '@omb/protocol'
import { encodeClient } from '@omb/protocol'
import { RoomSession } from './net'
import { extractSnapshot } from './game/world'
import { GameController } from './game/controls'

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
const btnStart = $<HTMLButtonElement>('btn-start')
const btnWarmup = $<HTMLButtonElement>('btn-warmup')
const roomNotice = $<HTMLDivElement>('room-notice')
const statusText = $<HTMLSpanElement>('status-text')
const btnReconnect = $<HTMLButtonElement>('btn-reconnect')
const viewGame = $<HTMLElement>('view-game')
const gameCanvas = $<HTMLCanvasElement>('game-canvas')
const hudRoot = $<HTMLElement>('hud')

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

function showView(view: 'join' | 'room' | 'game'): void {
  viewJoin.hidden = view !== 'join'
  viewRoom.hidden = view !== 'room'
  viewGame.hidden = view !== 'game'
}

function setStatus(kind: 'ok' | 'down' | 'off', text: string): void {
  app.classList.toggle('ok', kind === 'ok')
  app.classList.toggle('down', kind === 'down')
  statusText.textContent = text
}

function showFormError(msg: string): void {
  formError.textContent = msg
}

// ---- 大厅状态（roomState / 快照 full 帧驱动） --------------------------------

/** 房间状态缓存：hostNick 判定房主视角，lastRoster 补成员昵称。 */
const room = {
  hostNick: '',
  robotsOnline: 0,
  state: -1 as number,
  /** 最近一次对局 full 快照的 robots[].nick/color（对局名单，离场后标暗） */
  lastRoster: [] as Array<{ nick: string; color: string }>,
}

function isInGame(): boolean {
  return game !== null && !viewGame.hidden
}

/** 发送 RoomAction（仅房主按钮；服务器二次鉴权）。 */
function sendRoomAction(kind: RoomAction_Kind): void {
  if (session?.state !== 'online') return
  session.send(encodeClient(create(ClientMsgSchema, {
    payload: { case: 'roomAction', value: create(RoomActionSchema, { kind }) },
  })))
}

/** EvRoomState 驱动：状态行、操作栏可见性、成员列表。 */
function onRoomState(state: number, hostNick: string, robotsOnline: number): void {
  room.hostNick = hostNick
  room.robotsOnline = robotsOnline
  room.state = state

  const stateName = ['空闲', '热身中', '对局中', '已结束'][state] ?? `状态${state}`
  roomStateEl.textContent = `房间 ${stateName} · 房主 ${hostNick || '—'} · 机器人 ${robotsOnline}`

  const isHost = hostNick !== '' && hostNick === selfNick()
  const idleLike = state === EvRoomState_State.R_IDLE || state === EvRoomState_State.R_WARMUP
  btnStart.hidden = !(isHost && idleLike && !isInGame())
  btnWarmup.hidden = !(isHost && state === EvRoomState_State.R_ENDED && !isInGame())
  if (btnStart.hidden && btnWarmup.hidden) {
    roomNotice.hidden = false
    roomNotice.textContent = state === EvRoomState_State.R_RUNNING ? '对局进行中' : (isHost ? '等待开始' : '等待房主开始')
  } else {
    roomNotice.hidden = true
  }

  renderMembers()
}

function selfNick(): string {
  return lastJoin?.nick ?? ''
}

/** 大厅成员列表：自己 + 房主 + 最近对局名单（真实数据源，不造名单）。 */
function renderMembers(): void {
  membersEl.innerHTML = ''
  const online = room.robotsOnline

  const self = selfNick()
  const selfKnown = self !== ''
  const rows: Array<{ nick: string; color: string; tag: string; stale: boolean }> = []

  if (selfKnown) {
    rows.push({ nick: self, color: lastJoin?.color ?? '', tag: room.hostNick === self ? '房主' : '你', stale: false })
  }
  if (room.hostNick && room.hostNick !== self) {
    rows.push({ nick: room.hostNick, color: '', tag: '房主', stale: false })
  }
  for (const m of room.lastRoster) {
    if (m.nick === self || m.nick === room.hostNick || !m.nick) continue
    rows.push({ nick: m.nick, color: m.color, tag: '', stale: true })
  }

  for (const r of rows) {
    const li = document.createElement('li')
    li.className = 'm-row' + (r.stale ? ' stale' : '')
    if (r.color) li.style.setProperty('--c', r.color)
    const dot = document.createElement('span')
    dot.className = 'm-dot'
    const name = document.createElement('span')
    name.className = 'm-name'
    name.textContent = r.nick
    li.append(dot, name)
    if (r.tag) {
      const tag = document.createElement('span')
      tag.className = 'm-tag'
      tag.textContent = r.tag
      li.appendChild(tag)
    }
    membersEl.appendChild(li)
  }

  const count = document.createElement('li')
  count.className = 'm-count'
  count.textContent = `${online} 台机器人在线`
  membersEl.appendChild(count)
}

function resetLobby(): void {
  room.hostNick = ''
  room.robotsOnline = 0
  room.state = -1
  room.lastRoster = []
  membersEl.innerHTML = ''
  btnStart.hidden = true
  btnWarmup.hidden = true
  roomNotice.hidden = true
  roomStateEl.textContent = '已发送进房请求，等待服务器…'
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
  resetLobby()
  showView('room')
  startRttLoop(s)
}

function onDisconnected(reason: string): void {
  stopRttLoop()
  game?.exit()
  game = null
  session?.close()
  session = null
  btnJoin.disabled = false // 修复：无论从哪个阶段断开，恢复进房按钮
  setStatus('down', reason)
  roomStateEl.textContent = '离线'
  btnStart.hidden = true
  btnWarmup.hidden = true
  roomNotice.hidden = false
  roomNotice.textContent = '已离线，重新连接后可继续'
  btnReconnect.hidden = false
  showView('room')
}

// ---- 游戏态切换 -------------------------------------------------------------

let game: GameController | null = null

function enterGame(): void {
  if (!session) return
  game?.exit()
  game = new GameController({
    canvas: gameCanvas,
    hudRoot,
    send: (data) => session?.state === 'online' && session.send(data),
    onExitToRoom: exitGame,
  })
  showView('game')
}

function exitGame(): void {
  game?.exit()
  game = null
  showView('room')
  // 用缓存状态立即刷新操作栏，下一次 roomState 会覆盖
  onRoomState(room.state, room.hostNick, room.robotsOnline)
}

function onServerMsg(roomCode: string, msg: ServerMsg): void {
  if (session && roomCode) setStatus('ok', 'connected')
  if (msg.payload.case === 'event') {
    const ev = msg.payload.value
    if (ev.kind.case === 'mapBootstrap') {
      // 服务器下发地图：切游戏视图（解析失败留在大厅）
      if (!game) enterGame()
      const ok = game?.onMapBootstrap(ev.kind.value.mapJson) ?? false
      if (!ok) {
        game?.exit()
        game = null
        showView('room')
        roomStateEl.textContent = '地图数据异常，无法进入对局'
      }
      return
    }
    if (ev.kind.case === 'roomState') {
      const rs = ev.kind.value
      // 对局结束回大厅（服务器状态机回 idle/warmup）；结算覆盖层在场时保留游戏视图
      if ((rs.state === EvRoomState_State.R_IDLE || rs.state === EvRoomState_State.R_WARMUP)
          && !viewGame.hidden && !game?.isMatchEndShown()) {
        exitGame()
      }
      onRoomState(rs.state, rs.hostNick, rs.robotsOnline)
      return
    }
    // 其余事件转给游戏视图（say/kill/phaseChange/matchEnd…）
    game?.onMessage(msg)
  } else {
    // 快照帧转给游戏视图；full 帧落地后同步大厅成员名单（真实数据源）
    game?.onMessage(msg)
    const snap = extractSnapshot(msg)
    if (snap?.full && game) {
      room.lastRoster = game.lastRoster()
      if (!viewGame.hidden) renderMembers()
    }
  }
}

btnJoin.addEventListener('click', () => void join())
inRoom.addEventListener('keydown', (e) => { if (e.key === 'Enter') void join() })
inNick.addEventListener('keydown', (e) => { if (e.key === 'Enter') void join() })

btnStart.addEventListener('click', () => sendRoomAction(RoomAction_Kind.START))
btnWarmup.addEventListener('click', () => sendRoomAction(RoomAction_Kind.WARMUP))

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

// Space assist 开关（游戏态下全局拦截，避免页面滚动）
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && game && !e.repeat) {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
    e.preventDefault()
    game.toggleAssist()
  }
})

// 离开页面时通知服务器
window.addEventListener('beforeunload', () => {
  if (session?.state === 'online') {
    try {
      session.send(encodeClient(create(ClientMsgSchema, { payload: { case: 'leave', value: create(LeaveRoomSchema, {}) } })))
    } catch { /* socket 已关则忽略 */ }
  }
  session?.close()
})
