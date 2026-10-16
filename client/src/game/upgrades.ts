// 升级面板（ADR-0016）：技能点计数器 + 五维升级条，挂 hud-left 顶部。
// 数据全部来自服务器权威快照（SelfState.upgrade + SimTuning.upgrade 曲线），
// 本模块不做任何本地推算/乐观更新——拒绝=点数不变，UI 以快照为准。
import './upgrades.css'
import { icon, type IconName } from '../icons'
import type { WorldState } from './world'
import type { UpgradeTuning } from '@omb/protocol'
import { setText } from '../ui/dom'

/** 轨定义：下标与协议 UpgradeSelf.levels / UpgradeTuning 数组一致。 */
const TRACKS: readonly { icon: IconName; name: string; fmt: (step: number) => string }[] = [
  { icon: 'heart', name: '机体', fmt: s => `+${fmtStep(s / 10)}` },
  { icon: 'speed', name: '移速', fmt: s => `+${fmtStep(s / 10)}` },
  { icon: 'shield', name: '盾量', fmt: s => `−${fmtStep(s / 1000 * 100)}%` },
  { icon: 'fire', name: '攻击', fmt: s => `+${fmtStep(s / 10)}` },
  { icon: 'energy', name: '能量', fmt: s => `+${fmtStep(s / 10)}` },
]

const MAX_LEVEL = 10
/** 赏金状态门槛（ADR-0016）：任一轨 ≥4，阵亡将散落点数。 */
export const BOUNTY_LEVEL = 4

function fmtStep(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

export interface UpgradePanelDeps {
  /** 购买回调（track 1–5）：由 GameController 注入 UpgradeRequest 上行。 */
  buy: (track: number) => void
  /** 点击购买后焦点还画布（WASD 焦点纪律，照 controls.ts 模式）。 */
  returnFocus: () => void
}

export class UpgradePanel {
  private readonly root: HTMLElement
  private readonly count: HTMLElement
  private readonly bounty: HTMLElement
  private readonly rows: readonly HTMLButtonElement[]
  private readonly pips: readonly HTMLElement[][]
  private readonly deltas: readonly HTMLElement[]
  private readonly costs: readonly HTMLElement[]
  private lastPoints = -1
  private readonly lastLevels = Array<number>(TRACKS.length).fill(-1)
  private curve: UpgradeTuning | undefined
  private labels: { delta: string; cost: string }[] = []
  private popTimer: number | undefined
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)')

  constructor(hudRoot: ParentNode, deps: UpgradePanelDeps) {
    this.root = document.createElement('div')
    this.root.className = 'hud-upgrades'
    this.root.hidden = true

    const head = document.createElement('div')
    head.className = 'hud-up-head'
    const points = document.createElement('span')
    points.className = 'hud-up-points'
    points.append(icon('skillPoint'))
    this.count = document.createElement('b')
    this.count.textContent = '0'
    points.append(this.count)
    this.bounty = document.createElement('span')
    this.bounty.className = 'hud-up-bounty'
    this.bounty.textContent = '赏金'
    this.bounty.hidden = true
    head.append(points, this.bounty)
    this.root.append(head)

    const rows: HTMLButtonElement[] = []
    const pips: HTMLElement[][] = []
    const deltas: HTMLElement[] = []
    const costs: HTMLElement[] = []
    TRACKS.forEach((track, i) => {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'hud-up-row'
      row.dataset.track = String(i + 1)
      row.setAttribute('aria-label', `升级${track.name}`)
      const kbd = document.createElement('kbd')
      kbd.textContent = String(i + 1)
      const ic = document.createElement('span')
      ic.className = 'hud-up-icon'
      ic.append(icon(track.icon))
      const name = document.createElement('span')
      name.className = 'hud-up-name'
      name.textContent = track.name
      const pipRow = document.createElement('span')
      pipRow.className = 'hud-up-pips'
      pipRow.setAttribute('aria-hidden', 'true')
      const cells: HTMLElement[] = []
      for (let l = 0; l < MAX_LEVEL; l++) {
        const pip = document.createElement('i')
        pipRow.append(pip)
        cells.push(pip)
      }
      const delta = document.createElement('span')
      delta.className = 'hud-up-delta'
      const cost = document.createElement('span')
      cost.className = 'hud-up-cost'
      cost.append(icon('skillPoint'))
      const costNum = document.createElement('b')
      cost.append(costNum)
      row.append(kbd, ic, name, pipRow, delta, cost)
      row.addEventListener('click', () => {
        deps.buy(i + 1)
        deps.returnFocus()
      })
      this.root.append(row)
      rows.push(row)
      pips.push(cells)
      deltas.push(delta)
      costs.push(costNum)
    })
    this.rows = rows
    this.pips = pips
    this.deltas = deltas
    this.costs = costs

    const host = hudRoot.querySelector('#hud-left')
    if (host) host.prepend(this.root)
    else hudRoot.appendChild(this.root)
  }

  /** 快照更新时消费；曲线文案仅在 tuning 变化时预处理。 */
  update(world: WorldState): void {
    const up = world.self?.upgrade
    const curve: UpgradeTuning | undefined = world.tuning.upgrade
    if (!up || !curve || curve.costs.length < TRACKS.length * MAX_LEVEL) {
      if (!this.root.hidden) this.root.hidden = true
      this.lastPoints = -1
      this.lastLevels.fill(-1)
      return
    }
    if (this.root.hidden) this.root.hidden = false
    const points = up.points ?? 0
    const levels = up.levels
    const curveChanged = curve !== this.curve
    if (curveChanged) {
      this.curve = curve
      this.labels = curve.costs.map((cost, index) => ({
        delta: TRACKS[Math.floor(index / MAX_LEVEL)]?.fmt(curve.stepsX10[index] ?? 0) ?? '',
        cost: String(cost),
      }))
    }
    if (!curveChanged && points === this.lastPoints && this.lastLevels.every((level, i) => level === (levels.length === TRACKS.length ? levels[i] : 0))) return
    setText(this.count, String(points))
    if (points > this.lastPoints && this.lastPoints >= 0 && !this.reduced.matches) {
      this.root.dataset.pop = '1'
      window.clearTimeout(this.popTimer)
      this.popTimer = window.setTimeout(() => { delete this.root.dataset.pop; this.popTimer = undefined }, 180)
    }
    this.lastPoints = points
    const bounty = levels.length === TRACKS.length && levels.some(l => l >= BOUNTY_LEVEL)
    if (this.bounty.hidden === bounty) this.bounty.hidden = !bounty
    for (let t = 0; t < TRACKS.length; t++) {
      const level = levels.length === TRACKS.length ? levels[t] ?? 0 : 0
      const idx = t * MAX_LEVEL + level
      const cells = this.pips[t]!
      if (level !== this.lastLevels[t]) {
        for (let l = 0; l < MAX_LEVEL; l++) {
          if (cells[l]!.classList.contains('on') !== (l < level)) cells[l]!.classList.toggle('on', l < level)
        }
        this.lastLevels[t] = level
      }
      const row = this.rows[t]!
      const deltaEl = this.deltas[t]!
      const costEl = this.costs[t]!
      if (level >= MAX_LEVEL) {
        if (row.dataset.state !== 'max') row.dataset.state = 'max'
        setText(deltaEl, 'MAX')
        setText(costEl, '')
        continue
      }
      const cost = curve.costs[idx] ?? 0
      const label = this.labels[idx]!
      setText(deltaEl, label.delta)
      setText(costEl, label.cost)
      const state = points >= cost ? 'buy' : 'wait'
      if (row.dataset.state !== state) row.dataset.state = state
    }
  }

  dispose(): void {
    window.clearTimeout(this.popTimer)
    this.root.remove()
  }
}
