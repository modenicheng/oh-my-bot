import { ManualView } from '../manual/manual'
import { ReplayLibrary } from '../replay/library'
import { LiveSpectator } from '../live'
import { readRoute, type RouteExtra, type View } from '../route'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
interface AuxiliaryViewDeps {
  show: (view: View, extra?: RouteExtra) => void
  hasGame: () => boolean
  hasRoom: () => boolean
  refreshLobby: () => void
  setRoomCode: (roomCode: string) => void
}

/** 负责独立页面的创建、复用与销毁；玩家连接只由 main 管理。 */
export class AuxiliaryViews {
  private manual: ManualView | null = null
  private manualReturn: View = 'join'
  private lastDocument = 'index.md'
  private library: ReplayLibrary | null = null
  private spectator = false
  private live: LiveSpectator | null = null
  private roomCode = ''
  private manualRoot = $('view-manual')
  private replayList = $('view-replays')
  private replayRoot = $('view-replay-player')
  private replayCanvas = $<HTMLCanvasElement>('replay-canvas')
  private liveRoot = $('view-live')

  constructor(private deps: AuxiliaryViewDeps) {
    $('btn-manual').addEventListener('click', () => this.openManual())
    for (const id of ['btn-spectator', 'btn-room-spectator']) {
      $(id).addEventListener('click', () => this.openReplays(undefined, true))
    }
    for (const id of ['btn-replay', 'btn-game-replay']) {
      $(id).addEventListener('click', () => this.openReplays())
    }
    $('btn-replays-back').addEventListener('click', () => this.closeReplays())
    this.replayList.addEventListener('keydown', event => {
      if (this.spectator && event.key === 'Escape') { event.preventDefault(); this.closeReplays() }
    })
  }

  get liveRoom(): string { return this.roomCode }

  /** 地图重建不能把正在阅读/看录像的玩家强制拉回战场。 */
  currentUtilityView(): View | null {
    if (!this.manualRoot.hidden) return 'manual'
    if (!this.replayList.hidden) return this.spectator ? 'spectator' : 'replays'
    if (!this.replayRoot.hidden) return this.spectator ? 'spectator' : 'replay-player'
    return null
  }

  openManual(path = this.lastDocument): void {
    if (!this.manualRoot.hidden) return
    this.manualReturn = !$('view-game').hidden ? 'game' : !$('view-room').hidden ? 'room' : 'join'
    if (!this.manual) {
      this.manual = new ManualView({
        root: this.manualRoot, breadcrumb: $('manual-breadcrumb'), sidebar: $('manual-sidebar'),
        content: $('manual-content'), status: $('manual-status'), onExit: () => this.closeManual(),
      })
    }
    this.deps.show('manual', { doc: path })
    void this.manual.open(path)
  }

  closeManual(): void {
    this.lastDocument = readRoute().doc ?? 'index.md'
    this.manual?.close()
    this.deps.show(this.deps.hasGame() ? 'game' : this.manualReturn === 'game' ? 'room' : this.manualReturn)
    if (this.deps.hasRoom()) this.deps.refreshLobby()
  }

  openReplays(replayId?: string, spectator = false): void {
    if (this.spectator !== spectator) { this.library?.exit(); this.library = null }
    this.spectator = spectator
    this.replayRoot.toggleAttribute('data-spectator', spectator)
    for (const element of this.replayRoot.querySelectorAll<HTMLElement>('.spectator-heading, .spectator-camera')) element.hidden = !spectator
    $('spectator-library-note').hidden = !spectator
    $('replay-library-title').textContent = spectator ? '只读观战 · 选择录像' : '回放库'
    this.replayCanvas.setAttribute('aria-label', spectator ? '只读录像地图；方向键平移，加减缩放，Home 全图' : '录像战场')
    if (spectator) this.replayCanvas.setAttribute('aria-describedby', 'spectator-help spectator-source')
    else this.replayCanvas.removeAttribute('aria-describedby')
    if (!this.library) {
      this.library = new ReplayLibrary({
        listRoot: $('replay-list'), errorEl: $('replay-error'), playerRoot: this.replayRoot,
        canvas: this.replayCanvas, spectator,
        onExitToList: () => this.deps.show(spectator ? 'spectator' : 'replays'),
        showPlayer: matchId => {
          $('spectator-source').textContent = `录像 ${matchId} · 按已有回放记录重建，非实时；不发送游戏输入。`
          this.deps.show(spectator ? 'spectator' : 'replay-player', { replay: matchId })
          if (spectator) $('rp-return').focus({ preventScroll: true })
        },
        showList: () => {
          this.deps.show(spectator ? 'spectator' : 'replays')
          if (spectator) $('btn-replays-back').focus({ preventScroll: true })
        },
      })
    }
    this.deps.show(spectator ? 'spectator' : 'replays')
    void this.library.open(replayId)
  }

  private closeReplays(): void {
    this.library?.exit(); this.library = null
    this.deps.show(this.deps.hasGame() ? 'game' : this.deps.hasRoom() ? 'room' : 'join')
    if (this.spectator && !this.deps.hasGame()) {
      $(this.deps.hasRoom() ? 'btn-room-spectator' : 'btn-spectator').focus({ preventScroll: true })
    }
  }

  openLive(roomCode: string): void {
    this.live?.dispose()
    this.roomCode = roomCode
    this.deps.setRoomCode(roomCode)
    this.deps.show('live')
    const canvas = $<HTMLCanvasElement>('live-canvas')
    this.live = new LiveSpectator({ root: this.liveRoot, canvas, onExit: () => this.closeLive() })
    void this.live.connect(roomCode)
    canvas.focus({ preventScroll: true })
  }

  private closeLive(): void {
    this.disposeLive()
    this.deps.show('join')
    $('btn-live').focus({ preventScroll: true })
  }

  disposeLive(): void { this.live?.dispose(); this.live = null }
}
