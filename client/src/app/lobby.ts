import { EvRoomState_State, RoomAction_Kind } from '@omb/protocol'
import type { JoinProfile } from '../route'

const COLORS = ['#22d3ee', '#a3e635', '#f472b6', '#ff5c5c', '#fbbf24', '#a78bfa', '#34d399', '#f97316']
const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

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
  private color = COLORS[0]!
  private roomInput = $<HTMLInputElement>('in-room')
  private nickInput = $<HTMLInputElement>('in-nick')
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
    this.joinButton.addEventListener('click', () => this.join())
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
    this.deps.join({ roomCode: this.roomInput.value, nick, color: this.color })
  }

  setRoomCode(value: string): void { this.roomInput.value = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) }
  showError(message: string): void { $('form-error').textContent = message }
  setJoining(joining: boolean): void { this.joinButton.disabled = joining }

  restore(profile: JoinProfile): void {
    this.roomInput.value = profile.roomCode
    this.nickInput.value = profile.nick
    this.color = profile.color
    this.renderColor()
  }

  private renderColor(): void {
    for (const element of this.swatches.children) {
      element.classList.toggle('sel', (element as HTMLElement).style.getPropertyValue('--sw') === this.color)
    }
  }

  beginJoin(roomCode: string): void {
    this.setJoining(true)
    $('room-code').textContent = roomCode
    $<HTMLAnchorElement>('room-live').href = `?view=live&room=${encodeURIComponent(roomCode)}`
    this.hostNick = ''; this.robotsOnline = 0; this.state = -1; this.soloBots = 0
    $('members').replaceChildren()
    this.startButton.hidden = this.warmupButton.hidden = this.botsButton.hidden = true
    $('room-notice').hidden = true
    $('room-state').textContent = '已发送进房请求，等待服务器…'
  }

  update(state: number, hostNick: string, robotsOnline: number, soloBots: number): void {
    this.state = state; this.hostNick = hostNick; this.robotsOnline = robotsOnline; this.soloBots = soloBots
    this.refresh()
  }

  refresh(): void {
    const { state, hostNick, robotsOnline } = this
    const stateName = ['空闲', '热身中', '对局中', '已结束'][state] ?? `状态${state}`
    $('room-state').textContent = `房间 ${stateName} · 房主 ${hostNick || '—'} · 真人 ${robotsOnline}` + (this.soloBots ? ' · 下次开场最多 3 个测试 Bot' : '')
    const isHost = hostNick !== '' && hostNick === this.deps.selfNick()
    const idleLike = state === EvRoomState_State.R_IDLE || state === EvRoomState_State.R_WARMUP
    $('btn-game-start').hidden = !(isHost && state === EvRoomState_State.R_WARMUP)
    this.startButton.hidden = !(isHost && idleLike && !this.deps.inGame())
    this.warmupButton.hidden = !(isHost && (state === EvRoomState_State.R_IDLE || state === EvRoomState_State.R_ENDED) && !this.deps.inGame())
    this.botsButton.hidden = !(isHost && (idleLike || state === EvRoomState_State.R_ENDED) && !this.deps.inGame())
    $('solo-bots-label').textContent = this.soloBots ? '关闭测试 Bot（下次开场）' : '添加 3 个测试 Bot'
    this.botsButton.setAttribute('aria-pressed', String(this.soloBots > 0))
    const notice = $('room-notice')
    notice.hidden = !(this.startButton.hidden && this.warmupButton.hidden && this.botsButton.hidden)
    if (!notice.hidden) notice.textContent = state === EvRoomState_State.R_RUNNING ? '对局进行中' : (isHost ? '等待开始' : '等待房主开始')
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
