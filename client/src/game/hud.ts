// HUD 覆盖层（DOM）：HP/能量条、时间/阶段、比分简表、say 气泡事件、结算覆盖层。
// 令牌严格走 client/STYLE.md：radius 0、1px #1f2733 描边、荧光只用于数据高亮。
import type { WorldState, RobotEnt } from './world'
import { phaseName, titleName } from './render'
import type { ScoreRow } from '@omb/protocol'

const MAX_HP = 1000  // hp_x10（×10）
const MAX_EN = 1000  // energy_x10（×10）

export class Hud {
  private hpFill: HTMLDivElement
  private enFill: HTMLDivElement
  private hpText: HTMLSpanElement
  private enText: HTMLSpanElement
  private phaseEl: HTMLSpanElement
  private timeEl: HTMLSpanElement
  private scoreRows: HTMLDivElement
  private assistEl: HTMLDivElement
  private msgLine: HTMLDivElement
  private lastRowsSig = ''

  constructor(private root: HTMLElement) {
    this.hpFill = req(root, 'hud-hp-fill')
    this.enFill = req(root, 'hud-en-fill')
    this.hpText = req(root, 'hud-hp-text')
    this.enText = req(root, 'hud-en-text')
    this.phaseEl = req(root, 'hud-phase')
    this.timeEl = req(root, 'hud-time')
    this.scoreRows = req(root, 'hud-score-rows')
    this.assistEl = req(root, 'hud-assist')
    this.msgLine = req(root, 'hud-msg')
  }

  update(world: WorldState): void {
    const selfId = world.self?.robotId ?? -1
    const self = world.robots.get(selfId)

    // HP / 能量
    if (self) {
      const hp = clamp01(self.hpX10 / MAX_HP)
      const en = clamp01(self.energyX10 / MAX_EN)
      this.hpFill.style.width = `${(hp * 100).toFixed(1)}%`
      this.enFill.style.width = `${(en * 100).toFixed(1)}%`
      this.hpFill.style.background = hp > 0.5 ? 'var(--lime)' : hp > 0.25 ? 'var(--amber)' : 'var(--danger)'
      this.hpText.textContent = self.dead ? `重生 ${self.respawnInS.toFixed(1)}s` : `${Math.round(self.hpX10 / 10)}`
      this.enText.textContent = `${Math.round(self.energyX10 / 10)}`
    }

    // 阶段 / 时间
    this.phaseEl.textContent = phaseName(world.phase)
    const t = Math.max(0, world.timeLeftS)
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60)
    this.timeEl.textContent = `${m}:${String(s).padStart(2, '0')}`

    // 比分简表：行 = nick + hp（分数服务器未透出，用状态占位；每秒查重重建）
    const rows: string[] = []
    for (const r of sortedRobots(world.robots)) {
      const tag = r.base?.id === selfId ? '›' : ' '
      const hp = Math.max(0, Math.round(r.hpX10 / 10))
      const partner = r.isPartner ? ' ◆搭档' : ''
      rows.push(`${tag}${r.nick || `robot-${r.base?.id ?? '?'}`}${partner} · ${r.dead ? '重生中' : `${hp}hp`}`)
    }
    const sig = rows.join('\n')
    if (sig !== this.lastRowsSig) {
      this.lastRowsSig = sig
      this.scoreRows.innerHTML = ''
      for (const line of rows.slice(0, 8)) {
        const div = document.createElement('div')
        div.className = 'hud-score-row'
        div.textContent = line
        this.scoreRows.appendChild(div)
      }
    }
  }

  setAssist(on: boolean): void {
    this.assistEl.textContent = on ? 'ASSIST ON' : 'ASSIST OFF'
    this.assistEl.classList.toggle('off', !on)
  }

  flashMsg(text: string): void {
    this.msgLine.textContent = text
    this.msgLine.classList.remove('show')
    // 强制重排以重启动画
    void this.msgLine.offsetWidth
    this.msgLine.classList.add('show')
  }

  clearMsg(): void {
    this.msgLine.classList.remove('show')
    this.msgLine.textContent = ''
  }
}

/** 结算覆盖层：分数行 + 称号 */
export function showMatchEnd(root: HTMLElement, rows: ScoreRow[], idToNick: Map<number, string>): void {
  const overlay = document.createElement('div')
  overlay.className = 'end-overlay'
  const title = document.createElement('div')
  title.className = 'end-title'
  title.textContent = 'MATCH END'
  overlay.appendChild(title)

  if (rows.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'end-empty'
    empty.textContent = '无比分数据'
    overlay.appendChild(empty)
  } else {
    const list = document.createElement('div')
    list.className = 'end-list'
    const sorted = [...rows].sort((a, b) => b.score - a.score)
    for (let i = 0; i < sorted.length; i++) {
      const row = sorted[i]!
      const div = document.createElement('div')
      div.className = 'end-row'
      const rank = document.createElement('span')
      rank.className = 'end-rank'
      rank.textContent = String(i + 1)
      const name = document.createElement('span')
      name.className = 'end-name'
      name.textContent = idToNick.get(row.robot) ?? `robot-${row.robot}`
      const score = document.createElement('span')
      score.className = 'end-score'
      score.textContent = String(row.score)
      div.append(rank, name, score)
      list.appendChild(div)
      // 称号行
      for (const t of row.titles) {
        const name2 = titleName(t)
        if (!name2) continue
        const tdiv = document.createElement('div')
        tdiv.className = 'end-title-row'
        tdiv.textContent = `「${name2}」`
        list.appendChild(tdiv)
      }
    }
    overlay.appendChild(list)
  }

  root.appendChild(overlay)
}

export function hideMatchEnd(root: HTMLElement): void {
  for (const el of root.querySelectorAll('.end-overlay')) el.remove()
}

// ---- helpers ---------------------------------------------------------------

function* sortedRobots(robots: Map<number, RobotEnt>): Generator<RobotEnt> {
  const arr = [...robots.values()].sort((a, b) => (a.nick || '').localeCompare(b.nick || ''))
  yield* arr
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function req<T extends HTMLElement>(root: HTMLElement, id: string): T {
  const el = root.querySelector(`#${id}`) as T | null
  if (!el) throw new Error(`HUD 缺少元素 #${id}`)
  return el
}
