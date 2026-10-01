import { Title } from '@omb/protocol'
import type { RobotEnt } from './world'
import './scoreboard.css'

export interface ScoreEntry { robot: number; score: number; titles?: readonly number[] }
export interface ScoreDisplay extends ScoreEntry { rank: number; nick: string; self: boolean; dead: boolean }

export function rankedScores<T extends ScoreEntry>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.score - a.score || a.robot - b.robot)
}

/** 实时榜以服务器为准；昵称可跨 AOI 缓存，但绝不从可见机器人推算分数。 */
export class Scoreboard {
  readonly names = new Map<number, string>()
  private rows: ScoreEntry[] = []
  private tick = -1
  private final = false
  private received = false

  reset(): void { this.rows = []; this.tick = -1; this.final = false; this.received = false; this.names.clear() }
  observe(robots: ReadonlyMap<number, RobotEnt>): void {
    for (const [id, robot] of robots) if (robot.nick) this.names.set(id, robot.nick)
  }
  accept(rows: readonly ScoreEntry[], tick: number, final = false): void {
    if (this.final || !final && tick < this.tick) return
    this.rows = rows.map(row => ({ robot: row.robot, score: row.score, titles: [...(row.titles ?? [])] }))
    this.tick = tick; this.final = final; this.received = true
  }
  score(robot: number): number | undefined { return this.rows.find(row => row.robot === robot)?.score }
  get hasScores(): boolean { return this.received }
  get ended(): boolean { return this.final }
  display(robots: ReadonlyMap<number, RobotEnt>, self = -1): ScoreDisplay[] {
    return rankedScores(this.rows).map((row, i) => ({ ...row, rank: i + 1,
      nick: this.names.get(row.robot) || `robot-${row.robot}`, self: row.robot === self,
      dead: !!robots.get(row.robot)?.dead,
    }))
  }
}

export function titleName(title: number): string {
  switch (title) {
    case Title.WAR_MACHINE: return '战争机器'
    case Title.SCAVENGER: return '垃圾佬'
    case Title.SIGNAL_THIEF: return '信号大盗'
    case Title.RUNNER: return '跑路大师'
    case Title.WALL_HEAD: return '铁头娃'
    case Title.SURVIVOR: return '苟王'
    case Title.PEACEMAKER: return '和平使者'
    case Title.AI_IDIOT: return '人工智障'
    case Title.BARRAGE: return '弹幕大师'
    case Title.BEST_PARTNER: return '' // deprecated legacy replay value
    case Title.AI_REGULAR: return 'AI 常客'
    case Title.OLD_SCHOOL: return '古法编程'
    case Title.CNMB: return '充能面包'
    case Title.KILL_STEAL: return '抢人头'
    case Title.HEALER: return '耐活王'
    default: return ''
  }
}

function text(className: string, value: string): HTMLSpanElement {
  const span = document.createElement('span'); span.className = className; span.textContent = value; return span
}

export function scoreRow(row: ScoreDisplay, tag: 'div' | 'li' = 'div', titles = false): HTMLElement {
  const element = document.createElement(tag)
  element.className = 'score-row'
  element.dataset.robot = String(row.robot)
  element.classList.toggle('score-self', row.self)
  element.classList.toggle('score-first', row.rank === 1)
  element.append(text('score-rank', String(row.rank)), text('score-name', row.nick), text('score-value', String(row.score)))
  const state = [row.self ? '自己' : '', row.dead ? '重生中' : ''].filter(Boolean).join(' · ')
  if (state) element.append(text('score-state', state))
  if (titles) {
    const badges = document.createElement('div'); badges.className = 'score-titles'
    const names = (row.titles ?? []).map(titleName).filter(Boolean)
    for (const name of names) badges.append(text('score-title', name))
    if (!names.length) badges.append(text('score-no-title', '暂无称号'))
    element.append(badges)
  }
  return element
}

export function showMatchEnd(root: HTMLElement, rows: readonly ScoreEntry[], names: ReadonlyMap<number, string>, onBack?: () => void, self = -1): void {
  hideMatchEnd(root)
  const overlay = document.createElement('div'); overlay.className = 'end-overlay'
  overlay.setAttribute('role', 'region'); overlay.setAttribute('aria-label', '对局结算')
  overlay.append(text('end-title', '对局结算'))
  const list = document.createElement('ol'); list.className = 'end-list'
  list.setAttribute('aria-label', '最终积分与称号')
  for (const [i, row] of rankedScores(rows).entries()) {
    list.append(scoreRow({ ...row, rank: i + 1, nick: names.get(row.robot) || `robot-${row.robot}`, self: row.robot === self, dead: false }, 'li', true))
  }
  if (!rows.length) overlay.append(text('end-empty', '本局无得分记录'))
  else overlay.append(list)
  if (onBack) {
    const back = document.createElement('button'); back.type = 'button'; back.className = 'end-back'
    back.textContent = '回到房间'; back.addEventListener('click', onBack); overlay.append(back)
  }
  root.append(overlay)
}

export function hideMatchEnd(root: HTMLElement): void {
  for (const element of root.querySelectorAll('.end-overlay')) element.remove()
}
