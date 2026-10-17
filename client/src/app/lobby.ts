import { EvRoomState_State, RoomAction_Kind } from '@omb/protocol'
import type { JoinProfile } from '../route'
import { clearToken, loginHref, type AuthClaims } from '../auth'
import { $ } from '../ui/dom'

const COLORS = ['#22d3ee', '#a3e635', '#f472b6', '#ff5c5c', '#fbbf24', '#a78bfa', '#34d399', '#f97316']
const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/

interface LobbyDeps {
  selfNick: () => string
  inGame: () => boolean
  join: (profile: JoinProfile) => void
  roomAction: (kind: RoomAction_Kind) => void
  watchLive: (roomCode: string) => void
}

/** 表单与大厅呈现的唯一所有者；连接/对局生命周期仍由入口协调。 */
export class Lobby {
  state = -1
  private hostNick = ''
  private robotsOnline = 0
  private soloBots = 0
  private hostSpectator = false
  private pausedState = false
  private color = COLORS[0]!
  // OIDC 认证态（服务端 auth.* 开启时）：未登录阻止进房，已登录昵称锁定为
  // 认证名——服务端门禁（cmd/omb sessionHandler）与昵称接管（handleJoin）
  // 是权威，这里只是提前给出可读的错误与 UI 状态。
  private authEnabled = false
  private authClaims: AuthClaims | null = null
  private roomInput = $<HTMLInputElement>('in-room')
  private nickInput = $<HTMLInputElement>('in-nick')
  private matchInput = $<HTMLSelectElement>('in-match-min')
  private coreInput = $<HTMLSelectElement>('in-core-min')
  private spectatorModeInput = $<HTMLInputElement>('in-spectator-mode')
  private swatches = $('swatches')
  private joinButton = $<HTMLButtonElement>('btn-join')
  private startButton = $<HTMLButtonElement>('btn-start')
  private warmupButton = $<HTMLButtonElement>('btn-warmup')
  private botsButton = $<HTMLButtonElement>('btn-solo-bots')

  constructor(private deps: LobbyDeps) {
    for (const color of COLORS) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'swatch' + (color === this.color ? ' sel' : '')
      button.style.setProperty('--sw', color)
      button.title = color
      button.setAttribute('aria-label', `颜色 ${color}`)
      button.addEventListener('click', () => { this.color = color; this.renderColor() })
      this.swatches.appendChild(button)
    }
    this.setRoomCode(new URLSearchParams(location.search).get('room') ?? '')
    for (const input of [this.roomInput, this.nickInput]) {
      input.addEventListener('input', () => { this.normalize(); this.showError('') })
      input.addEventListener('keydown', e => { if (e.key === 'Enter') this.join() })
    }
    // 游玩时长变化时收紧核心区开放的可选项（必须早于终局）。
    this.matchInput.addEventListener('change', () => this.constrainCoreOptions())
    this.constrainCoreOptions()
    this.joinButton.addEventListener('click', () => this.join())
    $('auth-login').addEventListener('click', e => {
      // 点击时带上当前房码：IdP 往返回来后表单自动恢复。
      e.preventDefault()
      location.href = loginHref(this.roomInput.value)
    })
    $('auth-logout').addEventListener('click', () => {
      clearToken()
      this.setAuth(this.authEnabled, null)
    })
    this.startButton.addEventListener('click', () => deps.roomAction(RoomAction_Kind.START))
    this.warmupButton.addEventListener('click', () => deps.roomAction(RoomAction_Kind.WARMUP))
    this.botsButton.addEventListener('click', () => deps.roomAction(RoomAction_Kind.SOLO_BOTS))
    $('btn-game-start').addEventListener('click', () => deps.roomAction(RoomAction_Kind.START))
    $('btn-live').addEventListener('click', () => {
      this.normalize()
      if (!ROOM_CODE_RE.test(this.roomInput.value)) { this.showError('房间码需为 4–8 位字母/数字'); return }
      this.showError('')
      deps.watchLive(this.roomInput.value)
    })
  }

  private normalize(): void {
    const position = this.roomInput.selectionStart
    this.setRoomCode(this.roomInput.value)
    if (position !== null) this.roomInput.setSelectionRange(position, position)
    this.nickInput.value = this.nickInput.value.slice(0, 16)
  }

  private join(): void {
    this.showError('')
    if (!ROOM_CODE_RE.test(this.roomInput.value)) return this.showError('房间码需为 4–8 位字母/数字')
    const nick = this.nickInput.value.trim()
    if (!/^.{1,16}$/.test(nick)) return this.showError('昵称需为 1-16 个字符')
    if (this.authEnabled && !this.authClaims) return this.showError('需要先通过 OIDC 登录（认证后昵称自动取认证身份）')
    const { matchMinutes, coreOpenMinutes } = this.selectedDurations()
    if (coreOpenMinutes >= matchMinutes) return this.showError('核心区开放时间需早于游玩时长')
    this.deps.join({ roomCode: this.roomInput.value, nick, color: this.color, matchMinutes, coreOpenMinutes,
      spectatorMode: this.spectatorModeInput.checked })
  }

  /** 当前表单时长（分钟）。 */
  selectedDurations(): { matchMinutes: number; coreOpenMinutes: number } {
    return {
      matchMinutes: Number(this.matchInput.value),
      coreOpenMinutes: Number(this.coreInput.value),
    }
  }

  /** 核心区开放选项必须早于终局：隐藏越界项，当前选中越界时回退到最大合法项。 */
  private constrainCoreOptions(): void {
    const match = Number(this.matchInput.value)
    const options = Array.from(this.coreInput.options)
    for (const option of options) option.hidden = Number(option.value) >= match
    if (Number(this.coreInput.value) >= match) {
      const fallback = options.filter(o => !o.hidden).at(-1)
      if (fallback) this.coreInput.value = fallback.value
    }
  }

  setRoomCode(value: string): void { this.roomInput.value = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) }
  showError(message: string): void { $('form-error').textContent = message }
  showRoomError(message: string): void {
    $('room-error').textContent = message
    $('room-error').hidden = !message
  }
  setJoining(joining: boolean): void { this.joinButton.disabled = joining }

  /** 同步认证徽章与昵称输入：已登录锁昵称（服务端会强制覆盖），未登录给出登录入口。 */
  setAuth(enabled: boolean, claims: AuthClaims | null): void {
    this.authEnabled = enabled
    this.authClaims = claims
    $('auth-row').hidden = !enabled
    if (!enabled) return
    const login = $<HTMLAnchorElement>('auth-login')
    const logout = $<HTMLButtonElement>('auth-logout')
    $('auth-state').textContent = claims ? `已登录：${claims.name}` : '未登录'
    if (claims) {
      this.nickInput.value = claims.name.slice(0, 16)
      this.nickInput.disabled = true
      login.hidden = true
      logout.hidden = false
    } else {
      this.nickInput.disabled = false
      login.hidden = false
      logout.hidden = true
    }
  }

  restore(profile: JoinProfile): void {
    this.roomInput.value = profile.roomCode
    // 认证锁定昵称时保持认证名：存量 profile 可能是接入认证前的旧昵称。
    if (!this.nickInput.disabled) this.nickInput.value = profile.nick
    this.color = profile.color
    this.spectatorModeInput.checked = profile.spectatorMode === true
    if (profile.matchMinutes && [...this.matchInput.options].some(o => o.value === String(profile.matchMinutes))) {
      this.matchInput.value = String(profile.matchMinutes)
    }
    this.constrainCoreOptions()
    if (profile.coreOpenMinutes && [...this.coreInput.options].some(o => o.value === String(profile.coreOpenMinutes))) {
      this.coreInput.value = String(profile.coreOpenMinutes)
    }
    this.renderColor()
  }

  clearIdentity(): void {
    // 认证锁定时昵称恒定：清空会让禁用输入框过不了进房校验（死锁）。
    this.nickInput.value = this.authClaims ? this.authClaims.name.slice(0, 16) : ''
    this.showError('')
    this.spectatorModeInput.checked = false
    this.setJoining(false)
    if (!this.nickInput.disabled) this.nickInput.focus({ preventScroll: true })
  }

  private renderColor(): void {
    for (const element of this.swatches.children) {
      element.classList.toggle('sel', (element as HTMLElement).style.getPropertyValue('--sw') === this.color)
    }
  }

  beginJoin(roomCode: string): void {
    this.setJoining(true)
    this.showRoomError('')
    $('room-code').textContent = roomCode
    $<HTMLAnchorElement>('room-live').href = `?view=live&room=${encodeURIComponent(roomCode)}`
    this.hostNick = ''; this.robotsOnline = 0; this.state = -1; this.soloBots = 0; this.pausedState = false; this.hostSpectator = false
    $('members').replaceChildren()
    this.startButton.hidden = this.warmupButton.hidden = this.botsButton.hidden = true
    $('room-notice').hidden = true
    $('room-state').textContent = '已发送进房请求，等待服务器…'
  }

  update(state: number, hostNick: string, robotsOnline: number, soloBots: number, paused: boolean, hostSpectator = false): void {
    this.state = state; this.hostNick = hostNick; this.robotsOnline = robotsOnline; this.soloBots = soloBots
    this.hostSpectator = hostSpectator
    this.pausedState = paused
    this.refresh()
  }

  /** 本机是否房主（由房间状态广播的 host_nick 与本机昵称对齐判定）。 */
  get isHost(): boolean { return this.hostNick !== '' && this.hostNick === this.deps.selfNick() }

  /** Final room mode from the server, scoped to the local host identity. */
  get isHostSpectator(): boolean { return this.isHost && this.hostSpectator }

  /** 房主是否已暂停正式对局（EvRoomState.paused）。 */
  get paused(): boolean { return this.pausedState }

  refresh(): void {
    const { state, hostNick, robotsOnline } = this
    const stateName = ['空闲', '热身中', this.pausedState ? '对局中（已暂停）' : '对局中', '已结束'][state] ?? `状态${state}`
    $('room-state').textContent = `房间 ${stateName} · 房主 ${hostNick || '—'} · 真人 ${robotsOnline}`
      + (this.hostSpectator ? ' · 观战主持' : '')
      + (this.soloBots ? ` · 自动 Bot 上限 ${this.soloBots}（开场补满空位）` : '')
    const isHost = this.isHost
    // 正式局可直接从 Ended 连开（不必先回热身）：canStart 与服务端
    // room.HostCommand 的 START 合法集（Idle/Warmup/Ended）一致。
    const canStart = state === EvRoomState_State.R_IDLE || state === EvRoomState_State.R_WARMUP || state === EvRoomState_State.R_ENDED
    $('btn-game-start').hidden = !(isHost && (state === EvRoomState_State.R_WARMUP || state === EvRoomState_State.R_ENDED))
    this.startButton.hidden = !(isHost && canStart && !this.deps.inGame())
    this.warmupButton.hidden = !(isHost && (state === EvRoomState_State.R_IDLE || state === EvRoomState_State.R_ENDED) && !this.deps.inGame())
    this.botsButton.hidden = !(isHost && canStart && !this.deps.inGame())
    if (!this.startButton.hidden) this.startButton.querySelector('span:last-child')!.textContent = state === EvRoomState_State.R_ENDED ? '开始下一局' : '开始对局'
    $('solo-bots-label').textContent = this.soloBots ? '关闭自动 Bot（下次开场）' : '自动补满空位'
    this.botsButton.setAttribute('aria-pressed', String(this.soloBots > 0))
    const notice = $('room-notice')
    notice.hidden = !(this.startButton.hidden && this.warmupButton.hidden && this.botsButton.hidden)
    if (!notice.hidden) notice.textContent = this.pausedState ? '对局已暂停，等待房主继续'
      : state === EvRoomState_State.R_RUNNING ? '对局进行中' : (isHost ? '等待开始' : '等待房主开始')
    this.renderMembers()
  }

  renderMembers(): void {
    const me = this.deps.selfNick()
    const items = [this.hostNick ? `房主：${this.hostNick}` : '', me && me !== this.hostNick ? `你：${me}` : '', this.robotsOnline > 0 ? `在线：${this.robotsOnline} 人` : '']
    $('members').replaceChildren(...items.filter(Boolean).map(text => {
      const element = document.createElement('li'); element.textContent = text; return element
    }))
  }

  disconnected(): void {
    this.startButton.hidden = this.warmupButton.hidden = true
    $('btn-game-start').hidden = true
    $('room-notice').hidden = false
    $('room-notice').textContent = '正在恢复连接，房间与昵称已保留'
  }

  mapFailed(): void { $('room-state').textContent = '地图数据异常，无法进入对局' }
}
