import type { RobotEnt } from './world'
import { icon } from '../icons'
import { setText } from '../ui/dom'

export function deathStatus(self: RobotEnt | undefined, initialized: boolean, ended: boolean): string | undefined {
  if (!initialized || ended || !self?.dead) return undefined
  const seconds = self.respawnInS
  return Number.isFinite(seconds) && seconds > 0 ? `${seconds} 秒后重生` : '等待重生同步'
}

/** A snapshot-driven notice, not a dialog: never steals focus or pauses play. */
export class DeathNotice {
  private readonly root = document.createElement('section')
  private readonly announcement = document.createElement('span')
  private readonly countdown = document.createElement('strong')
  private readonly score = document.createElement('span')

  constructor(parent: HTMLElement) {
    this.root.className = 'hud-death'
    this.root.hidden = true
    this.root.setAttribute('aria-label', '机体损毁与重生状态')
    const heading = document.createElement('h2')
    heading.append(icon('skull'), document.createTextNode('机体已损毁'))
    this.countdown.className = 'death-countdown'
    // Only announce entering death. Countdown snapshots must not flood a screen reader.
    this.announcement.className = 'death-announcement'
    this.announcement.setAttribute('role', 'status')
    this.announcement.setAttribute('aria-live', 'polite')
    this.countdown.setAttribute('aria-live', 'off')
    this.score.className = 'death-score'
    const note = document.createElement('p')
    note.textContent = '重生由服务器自动完成。等待时仍可查看战场、文档和编辑器。'
    this.root.append(heading, this.countdown, this.score, note)
    parent.append(this.announcement, this.root)
  }

  update(self: RobotEnt | undefined, initialized: boolean, ended: boolean, score?: number): void {
    const status = deathStatus(self, initialized, ended)
    if (status === undefined) {
      this.root.hidden = true
      setText(this.announcement, '')
      return
    }
    if (this.root.hidden) setText(this.announcement, '机体已损毁，等待自动重生。')
    this.root.hidden = false
    setText(this.countdown, status)
    setText(this.score, score === undefined ? '当前积分等待同步' : `当前积分 ${score}`)
  }

  dispose(): void { this.root.remove(); this.announcement.remove() }
}
