// 应用协调入口：玩家会话、路由、对局与工作台；页面呈现由 app/ 模块负责。
// 连接层见 net.ts，游戏视图见 game/，页面样式与职责约定见 client/STYLE.md。
import { create } from '@bufbuild/protobuf'
import { ClientMsgSchema, RoomActionSchema, LeaveRoomSchema,
         RoomAction_Kind, EvRoomState_State, EvControlNotice_Code,
         joinRejection, controlNotice, dedupeControlNoticeSay,
         type ServerMsg, type EvControlNotice } from '@omb/protocol'
import { encodeClient } from '@omb/protocol'
import { RoomSession, type SessionState } from './net'
import { extractSnapshot } from './game/world'
import { GameController } from './game/controls'
import { GameOptions } from './game/options'
import { Workbench } from './workbench/workbench'
import { preloadEditorModule } from './workbench/editor-loader'
import { battleKeyAction } from './game/shortcut'
import { bindHelpToggle } from './game/help-toggle'
import { readRoute, saveProfile, loadProfile, clearProfile, writeRoute, type View, type RouteExtra } from './route'
import { mountIcons } from './icons'
import { audio } from './audio'
import { artReady } from './game/art'
import { bgm } from './music/bgm'
import { Lobby } from './app/lobby'
import { AuxiliaryViews } from './app/auxiliary-views'
import { $ } from './ui/dom'

export const ready = Promise.all([artReady, bgm.preload()])

mountIcons(document)

// ---- DOM ---------------------------------------------------------------

const app = $('app') as HTMLDivElement & { classList: DOMTokenList }
const viewJoin = $<HTMLElement>('view-join')
const viewRoom = $<HTMLElement>('view-room')
const statusText = $<HTMLSpanElement>('status-text')
const btnReconnect = $<HTMLButtonElement>('btn-reconnect')
const connectionNotice = $('connection-notice')
const connectionText = $('connection-text')
const connectionRetry = $<HTMLButtonElement>('connection-retry')
const viewGame = $<HTMLElement>('view-game')
const gameCanvas = $<HTMLCanvasElement>('game-canvas')
const hudRoot = $<HTMLElement>('hud')
const viewManual = $<HTMLElement>('view-manual')
const viewReplays = $<HTMLElement>('view-replays')
const viewReplayPlayer = $<HTMLElement>('view-replay-player')
const viewLive = $<HTMLElement>('view-live')
const audioSettings = $<HTMLDetailsElement>('audio-settings')
viewJoin.appendChild(audioSettings)

// ---- 对局帮助面板：默认折叠，? 展开/收起，Esc 关闭 ------------------------------

const help = bindHelpToggle($<HTMLButtonElement>('btn-game-help'), $('hud-help'))
// 离开游戏视图（回大厅/断线）时复位，避免下次进入残留展开态。
new MutationObserver(() => { if (viewGame.hidden) help.close() })
  .observe(viewGame, { attributes: true, attributeFilter: ['hidden'] })

// ---- 页面模块 ---------------------------------------------------------------

const initialRoute = readRoute()
const lobby = new Lobby({
  selfNick: () => lastJoin?.nick ?? '',
  inGame: isInGame,
  join: profile => { void joinWith(profile.roomCode, profile.nick, profile.color) },
  roomAction: sendRoomAction,
  watchLive: roomCode => screens.openLive(roomCode),
})

const screens = new AuxiliaryViews({
  show: showView,
  hasGame: () => game !== null,
  hasRoom: () => !!(session || lastJoin),
  refreshLobby: () => { lobby.refresh(); syncWorkbench() },
  setRoomCode: roomCode => lobby.setRoomCode(roomCode),
})

function showView(view: View, extra?: RouteExtra): void {
  const enteringGame = view === 'game' && viewGame.hidden
  game?.setActive(view === 'game' && session?.state === 'online' && !awaitingFull)
  writeRoute(view, view === 'live' ? screens.liveRoom : lastJoin?.roomCode, view === 'game' ? workbench.route : extra)
  viewJoin.hidden = view !== 'join'
  viewRoom.hidden = view !== 'room'
  viewGame.hidden = view !== 'game'
  viewManual.hidden = view !== 'manual'
  viewLive.hidden = view !== 'live'
  const spectatorPlayer = view === 'spectator' && !!extra?.replay
  bgm.setView(view === 'game' ? 'game' : view === 'live' ? 'live'
    : view === 'replay-player' || spectatorPlayer ? 'replay' : 'menu')
  viewReplays.hidden = view !== 'replays' && !(view === 'spectator' && !spectatorPlayer)
  viewReplayPlayer.hidden = view !== 'replay-player' && !spectatorPlayer
  const audioHost = view === 'live' ? viewLive.querySelector('.live-heading')!
    : view === 'game' ? viewGame.querySelector('.game-tools')!
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

function isInGame(): boolean { return game !== null && !viewGame.hidden }

function sendRoomAction(kind: RoomAction_Kind): void {
  if (session?.state !== 'online') return
  session.send(encodeClient(create(ClientMsgSchema, {
    payload: { case: 'roomAction', value: create(RoomActionSchema, { kind }) },
  })))
}

let session: RoomSession | null = null
let lastJoin: { roomCode: string; nick: string; color: string } | null = null
let awaitingFull = false
/** 最近一条结构化控制通知（X-4）：用于成对下发旧 say 的去重。 */
let lastControlNotice: EvControlNotice | undefined

/** join/spectate 被拒（终态）：终结会话与游戏视图，回大厅展示原因。 */
function handleJoinRejected(reason: string): void {
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
  lobby.showError(`无法加入房间：${reason}`)
  lobby.setJoining(false)
}

async function joinWith(roomCode: string, nick: string, color: string): Promise<void> {
  if (session?.state === 'connecting') return
  lobby.beginJoin(roomCode)
  lastJoin = { roomCode, nick, color }
  saveProfile(lastJoin)
  workbench.setIdentity(roomCode, nick)
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
    lobby.setJoining(false)
    setStatus('down', '连接失败')
    lobby.showError(err instanceof Error ? err.message : '连接失败，请重试')
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
  lobby.disconnected()
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
  connectionNotice.hidden = true; lobby.setJoining(false); btnReconnect.hidden = false
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
  send: frame => session?.state === 'online' ? session.send(frame) : false,
  toggleAssist: () => game?.toggleAssist(),
  activateAssist: () => {
    if (!game || viewGame.hidden) {
      showView('game')
    }
    return game?.activateAssist() ?? false
  },
})

const gameOptions = new GameOptions({
  canOpen: () => isInGame(),
  onOpen: () => game?.releaseInput(),
  onClose: syncGameInput,
  onLeave: () => leaveRoom(false),
  onLogout: () => leaveRoom(true),
})

/** 面板可以并排打开，只有战场获得焦点时才接收手操。 */
function syncGameInput(): void {
  game?.setInputEnabled(!gameOptions.isOpen && !viewGame.hidden && !document.hidden && document.hasFocus() && document.activeElement === gameCanvas)
}

gameCanvas.addEventListener('pointerdown', () => gameCanvas.focus({ preventScroll: true }))
document.addEventListener('focusin', syncGameInput)
document.addEventListener('focusout', () => queueMicrotask(syncGameInput))
window.addEventListener('blur', () => game?.setInputEnabled(false))
window.addEventListener('focus', syncGameInput)
document.addEventListener('visibilitychange', syncGameInput)

function syncWorkbench(): void {
  workbench.setAvailability(session?.state === 'online', game !== null && !game.isMatchEndShown() && !awaitingFull &&
    (lobby.state === EvRoomState_State.R_WARMUP || lobby.state === EvRoomState_State.R_RUNNING))
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
  // 瞄准能力信号桥：脚本装载/Snippet 应用即重算 guard（早于服务器回显）。
  workbench.setAssistAimListener(capable => game?.setAssistAimCapable(capable))
  showView('game')
  workbench.activate()
}

function exitGame(): void {
  gameOptions.close(false, false)
  game?.exit()
  game = null
  workbench.resetMatch()
  showView('room')
  // 用缓存状态立即刷新操作栏，下一次 roomState 会覆盖
  lobby.refresh(); syncWorkbench()
}

function onServerMsg(roomCode: string, msg: ServerMsg): void {
  if (session && roomCode) setStatus('ok', 'connected')
  if (msg.payload.case === 'event') {
    const ev = msg.payload.value
    if (ev.kind.case === 'scriptResult') { workbench.acceptResult(ev.kind.value); return }
    if (ev.kind.case === 'snippetResult') { workbench.acceptSnippetResult(ev.kind.value); return }
    if (ev.kind.case === 'scriptVersions') { workbench.acceptScriptVersions(ev.kind.value); return }
    if (ev.kind.case === 'scriptRollbackResult') { workbench.acceptScriptRollbackResult(ev.kind.value); return }
    if (ev.kind.case === 'aiQuota') { workbench.acceptAiQuota(ev.kind.value); return }
    if (ev.kind.case === 'aiStream') { workbench.acceptAiStream(ev.kind.value); return }
    if (ev.kind.case === 'aiUsage') workbench.acceptAiUsage(ev.kind.value)
    if (ev.kind.case === 'scriptLog') { workbench.acceptScriptLog(ev.kind.value); return }
    if (ev.kind.case === 'matchEnd') workbench.resetMatch()
    // X-4：结构化控制通知优先；过渡期服务器成对下发同文 say，去重后旧前缀路径只作旧服务器回退
    const notice = controlNotice(msg)
    if (notice) {
      if (notice.code === EvControlNotice_Code.CN_JOIN_FAILED) {
        handleJoinRejected(notice.text)
        return
      }
      // 仅记住已消费的 notice：未知 code 不吞兼容 say（文案仍对用户可见）
      if (workbench.consumeControlNotice(notice)) { lastControlNotice = notice; return }
    }
    if (ev.kind.case === 'say' && ev.kind.value.robot === 0) {
      if (dedupeControlNoticeSay(msg, lastControlNotice)) { lastControlNotice = undefined; return }
      if (workbench.consumeAiDirectedSay(ev.kind.value.text)) return
    }
    const joinFailed = joinRejection(msg)
    if (joinFailed !== undefined) {
      handleJoinRejected(joinFailed.reason)
      return
    }
    if (ev.kind.case === 'mapBootstrap') {
      workbench.resetMatch()
      // 服务器下发地图：切游戏视图（解析失败留在大厅）
      const utilityView = screens.currentUtilityView()
      const utilityRoute = readRoute()
      if (!game) enterGame()
      awaitingFull = true
      game?.setActive(false)
      const ok = game?.onMapBootstrap(ev.kind.value.mapJson, ev.kind.value.tuning) ?? false
      syncWorkbench()
      if (ok && !utilityView) showView('game')
      if (ok && utilityView) showView(utilityView, utilityRoute)
      if (!ok) {
        game?.exit()
        game = null
        awaitingFull = false
        connectionNotice.hidden = true
        showView('room')
        lobby.mapFailed()
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
      lobby.update(rs.state, rs.hostNick, rs.robotsOnline, rs.soloBots)
      syncWorkbench()
      if (!restoredView) {
        restoredView = true
        if (initialRoute.view === 'manual') screens.openManual(initialRoute.doc)
        else if (initialRoute.view === 'replays' || initialRoute.view === 'replay-player') screens.openReplays(initialRoute.replay)
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
    if (snap?.self) workbench.acceptSelfAiQuota(snap.self.aiRoundsLeft, snap.self.aiTokensLeftK)
    if (snap?.full && game) {
      awaitingFull = false
      connectionNotice.hidden = true
      syncGameInput()
      game.setActive(!viewGame.hidden && session?.state === 'online')
      syncWorkbench()
      if (!viewGame.hidden) lobby.renderMembers()
    }
  }
}

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

$('btn-leave').addEventListener('click', () => leaveRoom(false))

function leaveRoom(logout: boolean): void {
  const current = session
  if (current?.state === 'online') {
    current.send(encodeClient(create(ClientMsgSchema, {
      payload: { case: 'leave', value: create(LeaveRoomSchema, {}) },
    })))
  }
  session = null
  current?.close()
  stopRttLoop()
  gameOptions.close(false, false)
  game?.exit()
  game = null
  awaitingFull = false
  lastJoin = null
  clearProfile()
  workbench.clearIdentity()
  workbench.setAvailability(false, false)
  connectionNotice.hidden = true
  btnReconnect.hidden = true
  lobby.setJoining(false)
  setStatus('off', logout ? '本地身份已清除' : '已离开房间')
  showView('join')
  if (logout) lobby.clearIdentity()
}

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
  if (!viewLive.hidden) return
  if (gameOptions.handleGlobalKey(e)) return
  if (e.repeat || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return
  const target = e.target as HTMLElement | null
  if (target?.closest('input, textarea, select, [contenteditable], [role="textbox"], .monaco-editor')) return
  if (e.code === 'KeyC' && !viewGame.hidden) {
    e.preventDefault(); workbench.toggle('editor')
  } else if (e.code === 'KeyM') {
    if (!viewManual.hidden) { e.preventDefault(); screens.closeManual() }
    else if (!viewGame.hidden) { e.preventDefault(); workbench.toggle('docs') }
    else if (!viewRoom.hidden) { e.preventDefault(); screens.openManual() }
  } else if (game && !viewGame.hidden && document.activeElement === gameCanvas) {
    const action = battleKeyAction(e.code)
    if (action === 'assist') { e.preventDefault(); game.toggleAssist() }
    else if (action === 'chat') { e.preventDefault(); game.openChat() }
    else if (action === 'aim') { e.preventDefault(); game.seizeAim() }
  }
})

// 刷新仅断开传输；保留房间身份以恢复原机器人。
window.addEventListener('pagehide', () => {
  game?.setActive(false)
  workbench.setAvailability(false, false)
  session?.close()
  screens.disposeLive()
})
window.addEventListener('pageshow', e => {
  if (!e.persisted) return
  if (!viewLive.hidden && screens.liveRoom) screens.openLive(screens.liveRoom)
  else if (lastJoin) void joinWith(lastJoin.roomCode, lastJoin.nick, lastJoin.color)
})

let started = false

/** 由首屏可信点击或按键同步调用；解锁音频之前不可 await。 */
export function start(): void {
  if (started) return
  started = true
  audio.unlock()
  audio.installUI()
  restoreInitialRoute()
  // 编辑器预取：启动手势后立刻在幕后加载 Monaco，游戏连接/首帧不被等待
  // （fire-and-forget，拒绝转告警）。玩家展开编辑器时若已就绪则零延迟。
  preloadEditorModule()
}

function restoreInitialRoute(): void {
  const profile = loadProfile(initialRoute.roomCode)
  // 观战直达链接不能恢复玩家会话；必须先于 profile 分支判断。
  if (initialRoute.view === 'live') {
    if (initialRoute.roomCode) screens.openLive(initialRoute.roomCode)
    else { showView('join'); lobby.showError('请输入要观战的房间码') }
  } else if (initialRoute.view === 'spectator') {
    screens.openReplays(initialRoute.replay, true)
  } else if (profile) {
    lobby.restore(profile)
    void joinWith(profile.roomCode, profile.nick, profile.color)
  } else if (initialRoute.view === 'manual') {
    screens.openManual(initialRoute.doc)
  } else if (initialRoute.view === 'replays' || initialRoute.view === 'replay-player') {
    screens.openReplays(initialRoute.replay)
  }
}
