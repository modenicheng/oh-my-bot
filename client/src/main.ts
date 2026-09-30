// 房间页主流程：进房表单 → WS 连接 + JoinRoom → 房间大厅；mapBootstrap 后切游戏视图。
// 样式令牌见 client/STYLE.md；连接层见 client/src/net.ts；游戏视图见 client/src/game/。
import { create } from '@bufbuild/protobuf'
import { ClientMsgSchema, RoomActionSchema,
         RoomAction_Kind, EvRoomState_State,
         type ServerMsg } from '@omb/protocol'
import { encodeClient } from '@omb/protocol'
import { RoomSession, type SessionState } from './net'
import { extractSnapshot } from './game/world'
import { GameController } from './game/controls'
import { ManualView } from './manual/manual'
import { Workbench } from './workbench/workbench'
import { ReplayLibrary } from './replay/library'
import { readRoute, saveProfile, loadProfile, writeRoute, type View, type RouteExtra } from './route'
import { mountIcons } from './icons'
import { audio } from './audio'

mountIcons(document)
audio.installUI()

// ---- 常量 ---------------------------------------------------------------

const PRESET_COLORS = [
  '#22d3ee', '#a3e635', '#f472b6', '#ff5c5c',
  '#fbbf24', '#a78bfa', '#34d399', '#f97316',
] as const

const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/
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
const connectionNotice = $('connection-notice')
const connectionText = $('connection-text')
const connectionRetry = $<HTMLButtonElement>('connection-retry')
const viewGame = $<HTMLElement>('view-game')
const gameCanvas = $<HTMLCanvasElement>('game-canvas')
const hudRoot = $<HTMLElement>('hud')
const viewManual = $<HTMLElement>('view-manual')
const btnManual = $<HTMLButtonElement>('btn-manual')
const btnReplay = $<HTMLButtonElement>('btn-replay')
const viewReplays = $<HTMLElement>('view-replays')
const replayListEl = $<HTMLElement>('replay-list')
const replayErrorEl = $<HTMLElement>('replay-error')
const btnReplaysBack = $<HTMLButtonElement>('btn-replays-back')
const viewReplayPlayer = $<HTMLElement>('view-replay-player')
const replayCanvas = $<HTMLCanvasElement>('replay-canvas')
const audioSettings = $<HTMLDetailsElement>('audio-settings')
viewJoin.appendChild(audioSettings)

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

// ?room=CODE 完整链接解析（自动大写、最多 8 位）
const initialRoute = readRoute()
const params = new URLSearchParams(location.search)
const fromLink = (params.get('room') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
if (fromLink) inRoom.value = fromLink

/** 输入即时规范化：房间码大写、仅 A-Z0-9；昵称截断 16 字。 */
function normalize(): void {
  const pos = inRoom.selectionStart
  inRoom.value = inRoom.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  if (pos !== null) inRoom.setSelectionRange(pos, pos)
  inNick.value = inNick.value.slice(0, 16)
}

inRoom.addEventListener('input', () => { normalize(); showFormError('') })
inNick.addEventListener('input', () => { normalize(); showFormError('') })

function validate(): string | null {
  if (!ROOM_CODE_RE.test(inRoom.value)) return '房间码需为 4–8 位字母/数字'
  const nick = inNick.value.trim()
  if (!NICK_RE.test(nick)) return '昵称需为 1-16 个字符'
  return null
}

// ---- 视图切换与状态行 ----------------------------------------------------------

function showView(view: View, extra?: RouteExtra): void {
  const enteringGame = view === 'game' && viewGame.hidden
  game?.setActive(view === 'game' && session?.state === 'online' && !awaitingFull)
  writeRoute(view, lastJoin?.roomCode, view === 'game' ? workbench.route : extra)
  viewJoin.hidden = view !== 'join'
  viewRoom.hidden = view !== 'room'
  viewGame.hidden = view !== 'game'
  viewManual.hidden = view !== 'manual'
  const spectatorPlayer = view === 'spectator' && !!extra?.replay
  viewReplays.hidden = view !== 'replays' && !(view === 'spectator' && !spectatorPlayer)
  viewReplayPlayer.hidden = view !== 'replay-player' && !spectatorPlayer
  const audioHost = view === 'game' ? viewGame.querySelector('.game-tools')!
    : view === 'manual' ? viewManual.querySelector('.manual-top')!
    : view === 'replay-player' || spectatorPlayer ? viewReplayPlayer.querySelector('.rp-buttons')!
    : view === 'room' ? viewRoom : view === 'replays' || view === 'spectator' ? viewReplays : viewJoin
  if (audioSettings.parentElement !== audioHost) { audioSettings.open = false; audioHost.appendChild(audioSettings) }
  if (enteringGame) {
    if (workbench.isOpen && matchMedia('(max-width: 760px)').matches) workbench.activate()
    else gameCanvas.focus({ preventScroll: true })
  }
  syncGameInput()
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
  $('btn-game-start').hidden = !(isHost && state === EvRoomState_State.R_WARMUP)
  const idleLike = state === EvRoomState_State.R_IDLE || state === EvRoomState_State.R_WARMUP
  btnStart.hidden = !(isHost && idleLike && !isInGame())
  // 热身场：Idle（开局前练习）与 Ended（下局前重整）都可用（room 状态机两态均合法）
  btnWarmup.hidden = !(isHost && (state === EvRoomState_State.R_IDLE || state === EvRoomState_State.R_ENDED) && !isInGame())
  if (btnStart.hidden && btnWarmup.hidden) {
    roomNotice.hidden = false
    roomNotice.textContent = state === EvRoomState_State.R_RUNNING ? '对局进行中' : (isHost ? '等待开始' : '等待房主开始')
  } else {
    roomNotice.hidden = true
  }

  syncWorkbench()
  renderMembers()
}

function selfNick(): string {
  return lastJoin?.nick ?? ''
}

/** 大厅成员列表：自己 + 房主 + 最近对局名单（真实数据源，不造名单）。 */
function renderMembers(): void {
  const n = room.robotsOnline
  const me = selfNick()
  const items = [
    room.hostNick ? `房主：${room.hostNick}` : '',
    me && me !== room.hostNick ? `你：${me}` : '',
    n > 0 ? `在线：${n} 人` : '',
  ]
  membersEl.replaceChildren(...items.filter(Boolean).map((text) => {
    const li = document.createElement('li')
    li.textContent = text
    return li
  }))
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

// ---- 手册视图（v1 手册基建：不依赖 WS，大厅随时可进） -------------------------

let manualView: ManualView | null = null
let manualReturnView: View = 'join'
let lastManualPath = 'index.md'

function closeManual(): void {
  lastManualPath = readRoute().doc ?? 'index.md'
  manualView?.close()
  showView(game ? 'game' : manualReturnView === 'game' ? 'room' : manualReturnView)
  if (session || lastJoin) onRoomState(room.state, room.hostNick, room.robotsOnline)
}

function openManual(path = lastManualPath): void {
  if (!viewManual.hidden) return
  manualReturnView = !viewGame.hidden ? 'game' : !viewRoom.hidden ? 'room' : 'join'
  if (!manualView) {
    manualView = new ManualView({
      root: viewManual,
      breadcrumb: $<HTMLElement>('manual-breadcrumb'),
      sidebar: $<HTMLElement>('manual-sidebar'),
      content: $<HTMLElement>('manual-content'),
      status: $<HTMLElement>('manual-status'),
      onExit: closeManual,
    })
  }
  showView('manual', { doc: path })
  void manualView.open(path)
}

btnManual.addEventListener('click', () => openManual())
$('btn-game-start').addEventListener('click', () => sendRoomAction(RoomAction_Kind.START))

// ---- 回放库（对局列表 ⇄ 回放器；同源 HTTP，不依赖 WS） --------------------

let replayLibrary: ReplayLibrary | null = null
let spectatorMode = false

function openReplays(replayId?: string, spectator = false): void {
  if (spectatorMode !== spectator) {
    replayLibrary?.exit()
    replayLibrary = null
  }
  spectatorMode = spectator
  viewReplayPlayer.toggleAttribute('data-spectator', spectator)
  for (const element of viewReplayPlayer.querySelectorAll<HTMLElement>('.spectator-heading, .spectator-camera')) element.hidden = !spectator
  $('spectator-library-note').hidden = !spectator
  $('replay-library-title').textContent = spectator ? '只读观战 · 选择录像' : '回放库'
  replayCanvas.setAttribute('aria-label', spectator ? '只读录像地图；方向键平移，加减缩放，Home 全图' : '录像战场')
  if (spectator) replayCanvas.setAttribute('aria-describedby', 'spectator-help spectator-source')
  else replayCanvas.removeAttribute('aria-describedby')
  if (!replayLibrary) {
    replayLibrary = new ReplayLibrary({
      listRoot: replayListEl,
      errorEl: replayErrorEl,
      playerRoot: viewReplayPlayer,
      canvas: replayCanvas,
      spectator,
      onExitToList: () => showView(spectator ? 'spectator' : 'replays'),
      showPlayer: matchId => {
        $('spectator-source').textContent = `录像 ${matchId} · 按已有回放记录重建，非实时；不发送游戏输入。`
        showView(spectator ? 'spectator' : 'replay-player', { replay: matchId })
        if (spectator) $('rp-return').focus({ preventScroll: true })
      },
      showList: () => {
        showView(spectator ? 'spectator' : 'replays')
        if (spectator) btnReplaysBack.focus({ preventScroll: true })
      },
    })
  }
  showView(spectator ? 'spectator' : 'replays')
  void replayLibrary.open(replayId)
}

function closeReplays(): void {
  replayLibrary?.exit()
  replayLibrary = null
  showView(game ? 'game' : session || lastJoin ? 'room' : 'join')
  if (spectatorMode && !game) $(session || lastJoin ? 'btn-room-spectator' : 'btn-spectator').focus({ preventScroll: true })
}

$('btn-spectator').addEventListener('click', () => openReplays(undefined, true))
$('btn-room-spectator').addEventListener('click', () => openReplays(undefined, true))
viewReplays.addEventListener('keydown', e => {
  if (spectatorMode && e.key === 'Escape') { e.preventDefault(); closeReplays() }
})
btnReplay.addEventListener('click', () => openReplays())
$('btn-game-replay').addEventListener('click', () => openReplays())
btnReplaysBack.addEventListener('click', closeReplays)

// ---- 连接会话 ---------------------------------------------------------------

let session: RoomSession | null = null
let lastJoin: { roomCode: string; nick: string; color: string } | null = null
let awaitingFull = false

async function join(): Promise<void> {
  showFormError('')
  const invalid = validate()
  if (invalid) return showFormError(invalid)

  void joinWith(inRoom.value, inNick.value.trim(), selectedColor)
}

async function joinWith(roomCode: string, nick: string, color: string): Promise<void> {
  if (session?.state === 'connecting') return
  btnJoin.disabled = true
  lastJoin = { roomCode, nick, color }
  saveProfile(lastJoin)
  workbench.setIdentity(roomCode, nick)
  roomCodeEl.textContent = roomCode
  resetLobby()
  showView('room')
  setStatus('off', '连接中…')

  session?.close()
  const s = new RoomSession()
  session = s

  try {
    await s.connect({
      roomCode,
      nick,
      color,
      onMessage: (msg) => { if (session === s) onServerMsg(roomCode, msg) },
      onDisconnect: (reason) => { if (session === s) onDisconnected(reason) },
      onStateChange: (state, retryInMs) => { if (session === s) onConnectionState(state, retryInMs) },
    })
    if (session !== s) { s.close(); return }
  } catch (err) {
    s.close()
    if (session !== s) return
    session = null
    btnJoin.disabled = false
    setStatus('down', '连接失败')
    showFormError(err instanceof Error ? err.message : '连接失败，请重试')
    btnReconnect.hidden = false
    showView('join')
    return
  }

  startRttLoop(s)
}

function onDisconnected(reason: string): void {
  workbench.setAvailability(false, false)
  awaitingFull = game !== null
  game?.setActive(false)
  setStatus('down', reason)
  btnStart.hidden = true
  btnWarmup.hidden = true
  $('btn-game-start').hidden = true
  roomNotice.hidden = false
  roomNotice.textContent = '正在恢复连接，房间与昵称已保留'
}

function onConnectionState(state: SessionState, retryInMs = 0): void {
  syncWorkbench()
  const online = state === 'online'
  connectionNotice.hidden = online && !awaitingFull || state === 'idle'
  connectionRetry.disabled = state === 'connecting' || online
  btnReconnect.hidden = online || state === 'connecting'
  if (online) {
    connectionText.textContent = awaitingFull ? '已连接，正在同步对局…' : ''
    setStatus('ok', '已连接')
  } else if (state !== 'idle') {
    const text = state === 'connecting' ? '正在连接房间…'
      : navigator.onLine === false ? '网络已离线，恢复后自动重连'
      : retryInMs > 0 ? `连接中断，${(retryInMs / 1000).toFixed(1)} 秒后重试` : '正在恢复连接…'
    connectionText.textContent = text
    setStatus('down', text)
  }
}

function cancelConnection(): void {
  session?.close(); session = null
  stopRttLoop(); game?.exit(); game = null; awaitingFull = false
  workbench.resetMatch()
  syncWorkbench()
  connectionNotice.hidden = true; btnJoin.disabled = false; btnReconnect.hidden = false
  setStatus('off', '连接已取消'); showView('join')
}
$('connection-cancel').addEventListener('click', cancelConnection)
connectionRetry.addEventListener('click', () => session?.retryNow())

// ---- 游戏态切换 -------------------------------------------------------------

let game: GameController | null = null
let restoredView = false

const workbench = new Workbench({
  root: $('workbench'),
  gameView: viewGame,
  docsButton: $<HTMLButtonElement>('btn-game-manual'),
  editorButton: $<HTMLButtonElement>('btn-game-editor'),
  initial: initialRoute,
  onLayout: () => { if (!viewGame.hidden) writeRoute('game', lastJoin?.roomCode, workbench.route) },
  send: frame => { if (session?.state === 'online') session.send(frame) },
  toggleAssist: () => game?.toggleAssist(),
})

/** 面板可以并排打开，只有战场获得焦点时才接收手操。 */
function syncGameInput(): void {
  game?.setInputEnabled(!viewGame.hidden && !document.hidden && document.hasFocus() && document.activeElement === gameCanvas)
}

gameCanvas.addEventListener('pointerdown', () => gameCanvas.focus({ preventScroll: true }))
document.addEventListener('focusin', syncGameInput)
document.addEventListener('focusout', () => queueMicrotask(syncGameInput))
window.addEventListener('blur', () => game?.setInputEnabled(false))
window.addEventListener('focus', syncGameInput)
document.addEventListener('visibilitychange', syncGameInput)

function syncWorkbench(): void {
  workbench.setAvailability(session?.state === 'online', game !== null && !game.isMatchEndShown() && !awaitingFull &&
    (room.state === EvRoomState_State.R_WARMUP || room.state === EvRoomState_State.R_RUNNING))
}

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
  workbench.activate()
}

function exitGame(): void {
  game?.exit()
  game = null
  workbench.resetMatch()
  showView('room')
  // 用缓存状态立即刷新操作栏，下一次 roomState 会覆盖
  onRoomState(room.state, room.hostNick, room.robotsOnline)
}

function onServerMsg(roomCode: string, msg: ServerMsg): void {
  if (session && roomCode) setStatus('ok', 'connected')
  if (msg.payload.case === 'event') {
    const ev = msg.payload.value
    if (ev.kind.case === 'scriptResult') { workbench.acceptResult(ev.kind.value); return }
    if (ev.kind.case === 'matchEnd') workbench.resetMatch()
    if (ev.kind.case === 'say' && ev.kind.value.robot === 0 && ev.kind.value.text.startsWith('join failed:')) {
      connectionNotice.hidden = true
      awaitingFull = false
      stopRttLoop()
      session?.close()
      session = null
      game?.exit()
      game = null
      workbench.resetMatch()
      syncWorkbench()
      setStatus('down', '进房失败')
      showView('join')
      showFormError(`无法加入房间：${ev.kind.value.text.slice('join failed:'.length).trim()}`)
      btnJoin.disabled = false
      return
    }
    if (ev.kind.case === 'mapBootstrap') {
      workbench.resetMatch()
      // 服务器下发地图：切游戏视图（解析失败留在大厅）
      const utilityView = !viewManual.hidden ? 'manual' : !viewReplays.hidden ? (spectatorMode ? 'spectator' : 'replays')
        : !viewReplayPlayer.hidden ? (spectatorMode ? 'spectator' : 'replay-player') : null
      const utilityRoute = readRoute()
      if (!game) enterGame()
      awaitingFull = true
      game?.setActive(false)
      const ok = game?.onMapBootstrap(ev.kind.value.mapJson) ?? false
      syncWorkbench()
      if (ok && !utilityView) showView('game')
      if (ok && utilityView) showView(utilityView, utilityRoute)
      if (!ok) {
        game?.exit()
        game = null
        awaitingFull = false
        connectionNotice.hidden = true
        showView('room')
        roomStateEl.textContent = '地图数据异常，无法进入对局'
      }
      return
    }
    if (ev.kind.case === 'roomState') {
      const rs = ev.kind.value
      // 对局结束回大厅（服务器状态机回 idle/warmup）；结算覆盖层在场时保留游戏视图
      if (rs.state === EvRoomState_State.R_IDLE) {
        awaitingFull = false
        connectionNotice.hidden = true
        if (game && !game.isMatchEndShown()) {
          if (!viewGame.hidden) exitGame()
          else { game.exit(); game = null; workbench.resetMatch() }
        }
      }
      onRoomState(rs.state, rs.hostNick, rs.robotsOnline)
      if (!restoredView) {
        restoredView = true
        if (initialRoute.view === 'manual') openManual(initialRoute.doc)
        else if (initialRoute.view === 'replays' || initialRoute.view === 'replay-player') openReplays(initialRoute.replay)
      }
      return
    }
    // 其余事件转给游戏视图（say/kill/phaseChange/matchEnd…）
    game?.onMessage(msg)
  } else {
    // 快照帧转给游戏视图；full 帧落地后同步大厅成员名单（真实数据源）
    game?.onMessage(msg)
    const snap = extractSnapshot(msg)
    if (snap?.self?.assistOn !== undefined) workbench.setAssist(snap.self.assistOn)
    if (snap?.full && game) {
      awaitingFull = false
      connectionNotice.hidden = true
      syncGameInput()
      game.setActive(!viewGame.hidden && session?.state === 'online')
      syncWorkbench()
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
  if (session) { session.retryNow(); return }
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

// M / C 切换侧栏；编辑、输入法和浏览器组合键保留原行为。
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return
  const target = e.target as HTMLElement | null
  if (target?.closest('input, textarea, select, [contenteditable], [role="textbox"], .monaco-editor')) return
  if (e.code === 'KeyC' && !viewGame.hidden) {
    e.preventDefault(); workbench.toggle('editor')
  } else if (e.code === 'KeyM') {
    if (!viewManual.hidden) { e.preventDefault(); closeManual() }
    else if (!viewGame.hidden) { e.preventDefault(); workbench.toggle('docs') }
    else if (!viewRoom.hidden) { e.preventDefault(); openManual() }
  } else if (game && !viewGame.hidden && document.activeElement === gameCanvas) {
    if (e.code === 'Space') { e.preventDefault(); game.toggleAssist() }
    else if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); game.openChat() }
  }
})

// 刷新仅断开传输；保留房间身份以恢复原机器人。
window.addEventListener('pagehide', () => {
  game?.setActive(false)
  workbench.setAvailability(false, false)
  session?.close()
})
window.addEventListener('pageshow', e => {
  if (e.persisted && lastJoin) void joinWith(lastJoin.roomCode, lastJoin.nick, lastJoin.color)
})

const profile = loadProfile(initialRoute.roomCode)
// A direct spectator URL must never restore a player session or join a room.
if (initialRoute.view === 'spectator') {
  openReplays(initialRoute.replay, true)
} else if (profile) {
  inRoom.value = profile.roomCode
  inNick.value = profile.nick
  selectedColor = profile.color
  for (const el of swatches.children) el.classList.toggle('sel', (el as HTMLElement).style.getPropertyValue('--sw') === selectedColor)
  void joinWith(profile.roomCode, profile.nick, profile.color)
} else if (initialRoute.view === 'manual') {
  openManual(initialRoute.doc)
} else if (initialRoute.view === 'replays' || initialRoute.view === 'replay-player') {
  openReplays(initialRoute.replay)
}
