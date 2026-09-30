// 回放库视图：对局列表（fetch /api/matches）→ 点击进入回放器。
// 对局时间估算：id 无法可靠推时间，显示序号与房间码；具体时长进入回放器后
// 由 endTick 得出（列表页保持轻量，不预下载每局 JSONL）。
import { fetchMatches, type MatchEntry } from './api'
import { ReplayPlayer } from './player'
import { writeRoute, readRoute } from '../route'

export interface ReplayLibraryDeps {
  listRoot: HTMLElement
  errorEl: HTMLElement
  playerRoot: HTMLElement
  canvas: HTMLCanvasElement
  onExitToList: () => void
  /** 视图切换（列表 ⇄ 播放器）由外部宿主控制。 */
  showPlayer: () => void
  showList: () => void
}

export class ReplayLibrary {
  private entries: MatchEntry[] = []
  private player: ReplayPlayer | null = null
  private loading = false
  private disposed = false

  constructor(private deps: ReplayLibraryDeps) {}

  /** 进入回放库：拉取列表并渲染。 */
  async open(matchId?: string): Promise<void> {
    this.deps.showList()
    await this.refresh()
    if (matchId && !this.disposed) await this.openPlayer(matchId)
  }

  /** 返回列表（从播放器退出时调用）。 */
  backToList(): void {
    this.player?.dispose()
    this.player = null
    this.deps.showList()
  }

  exit(): void {
    this.disposed = true
    this.player?.dispose()
    this.player = null
  }

  private async refresh(): Promise<void> {
    if (this.loading) return
    this.loading = true
    this.setError('')
    this.renderLoading()
    try {
      this.entries = await fetchMatches()
      if (!this.disposed) this.renderList()
    } catch (e) {
      if (this.disposed) return
      this.entries = []
      this.renderEmpty()
      this.setError(e instanceof Error ? e.message : String(e))
    } finally {
      this.loading = false
    }
  }

  private renderLoading(): void {
    this.deps.listRoot.innerHTML = '<div class="placeholder">载入中…</div>'
  }

  private renderEmpty(): void {
    this.deps.listRoot.innerHTML = '<div class="placeholder">暂无对局记录</div>'
  }

  private renderList(): void {
    const root = this.deps.listRoot
    if (this.entries.length === 0) {
      this.renderEmpty()
      return
    }
    root.innerHTML = ''
    for (const entry of this.entries) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'replay-item'
      // 房间码 + 局序：id 形如 ROOMCODE-SEQ
      const meta = entry.seq > 0 ? `#${entry.seq}` : ''
      btn.innerHTML =
        `<span class="ri-id">${escapeHtml(entry.id)}</span>` +
        `<span class="ri-meta">${escapeHtml(meta)}</span>`
      btn.addEventListener('click', () => void this.openPlayer(entry.id))
      root.appendChild(btn)
    }
  }

  private async openPlayer(matchId: string): Promise<void> {
    this.deps.showPlayer()
    if (!this.player) {
      this.player = new ReplayPlayer({
        root: this.deps.playerRoot,
        canvas: this.deps.canvas,
        onExit: () => this.backToList(),
        onError: (msg) => {
          this.setError(msg)
          this.backToList()
        },
      })
    }
    const player = this.player
    writeRoute('replay-player', readRoute().roomCode, { replay: matchId })
    const ok = await player.load(matchId)
    if (!ok && this.player === player && !this.disposed) this.backToList()
  }

  private setError(msg: string): void {
    this.deps.errorEl.textContent = msg
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}
