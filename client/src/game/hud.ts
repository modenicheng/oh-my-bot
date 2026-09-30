// HUD 覆盖层（DOM）：HP/能量条、时间/阶段、比分简表、技能卡组、Uplink 状态、
// say 气泡事件、结算覆盖层。令牌严格走 client/STYLE.md：radius 0、1px #1f2733
// 描边、荧光只用于状态高亮。技能卡是状态显示（含键帽），不是可点击按钮。
import type { WorldState, RobotEnt } from './world'
import type { MapDefParsed, MapUplink } from './mapdef'
import { phaseName, titleName } from './render'
import type { ScoreRow } from '@omb/protocol'
import { icon } from '../icons'

const MAX_HP = 1000   // hp_x10（×10）
const MAX_EN = 1000   // energy_x10（×10）
const TICK_HZ = 60    // 服务器固定 60Hz 绝对 tick
const DASH_COST_EN = 20  // server sim.DashCost
const FIRE_COST_EN = 5   // server sim.FireCost
const HACK_TICKS = 480   // server sim.HackDuration（480 tick = 8s）
const HACK_MAX_X10 = 80  // progress_x10 满值（8s × 10）
const MSG_MS = 2600      // 消息驻留时长（有界定时器，dispose 可清理）

interface SkillCard {
  root: HTMLDivElement
  cd: HTMLElement
}

type CardState = 'ready' | 'cooling' | 'active' | 'off'

export class Hud {
  private hpFill: HTMLDivElement
  private enFill: HTMLDivElement
  private hpText: HTMLSpanElement
  private enText: HTMLSpanElement
  private leftPanel: HTMLDivElement
  private phaseEl: HTMLSpanElement
  private timeEl: HTMLSpanElement
  private scoreRows: HTMLDivElement
  private assistEl: HTMLDivElement
  private assistCard: HTMLDivElement
  private msgLine: HTMLDivElement
  private msgTimer: number | undefined
  private assistLocal = false
  private assistServer: boolean | undefined
  private skills: Record<'fire' | 'dash' | 'shield' | 'uplink', SkillCard>
  private uplinkPanel: HTMLDivElement
  private uplinkText: HTMLSpanElement
  private uplinkTrack: HTMLDivElement
  private uplinkFill: HTMLDivElement
  private lastRowsSig = ''

  constructor(private root: HTMLElement) {
    this.hpFill = req(root, 'hud-hp-fill')
    this.enFill = req(root, 'hud-en-fill')
    this.hpText = req(root, 'hud-hp-text')
    this.enText = req(root, 'hud-en-text')
    this.leftPanel = req(root, 'hud-left')
    this.phaseEl = req(root, 'hud-phase')
    this.timeEl = req(root, 'hud-time')
    this.scoreRows = req(root, 'hud-score-rows')
    this.assistEl = req(root, 'hud-assist')
    this.assistCard = req(root, 'skill-assist')
    this.msgLine = req(root, 'hud-msg')
    this.skills = {
      fire: { root: req(root, 'skill-fire'), cd: req(root, 'skill-fire-cd') },
      dash: { root: req(root, 'skill-dash'), cd: req(root, 'skill-dash-cd') },
      shield: { root: req(root, 'skill-shield'), cd: req(root, 'skill-shield-cd') },
      uplink: { root: req(root, 'skill-uplink'), cd: req(root, 'skill-uplink-cd') },
    }
    this.uplinkPanel = req(root, 'hud-uplink')
    this.uplinkText = req(root, 'hud-uplink-text')
    this.uplinkTrack = req(root, 'hud-uplink-track')
    this.uplinkFill = req(root, 'hud-uplink-fill')
  }

  /** map 为可选：mapBootstrap 完成前也能渲染基础状态。 */
  update(world: WorldState, map?: MapDefParsed): void {
    const selfId = world.self?.robotId ?? -1
    const self = world.robots.get(selfId)

    // 常态机体用低饱和绿，能量用青色；数值与颜色共同标识状态。
    this.leftPanel.classList.toggle('dead', !!self?.dead)
    if (self) {
      const hp = clamp01(self.hpX10 / MAX_HP)
      const en = clamp01(self.energyX10 / MAX_EN)
      this.hpFill.style.width = `${(hp * 100).toFixed(1)}%`
      this.enFill.style.width = `${(en * 100).toFixed(1)}%`
      setText(this.hpText, self.dead ? `重生 ${self.respawnInS.toFixed(1)}s` : `${Math.round(self.hpX10 / 10)}`)
      setText(this.enText, `${Math.round(self.energyX10 / 10)}`)
    } else {
      this.hpFill.style.width = this.enFill.style.width = '0%'
      setText(this.hpText, '—'); setText(this.enText, '—')
    }

    // 辅助开关：服务器权威值优先；缺失（旧服务器）回退本地输入
    this.assistServer = world.self?.assistOn
    this.renderAssist()

    // 阶段 / 时间
    setText(this.phaseEl, phaseName(world.phase))
    const t = Math.max(0, world.timeLeftS)
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60)
    const clock = world.initialized ? `${m}:${String(s).padStart(2, '0')}` : '—:—'
    if (this.timeEl.textContent !== clock) this.timeEl.textContent = clock

    // 比分简表：行 = nick + hp（分数服务器未透出，用状态占位；签名查重重建）
    const rows = [...sortedRobots(world.robots)].slice(0, 8).map(r => ({
      self: r.base?.id === selfId,
      partner: r.isPartner,
      nick: r.nick || `robot-${r.base?.id ?? '?'}`,
      health: r.dead ? '重生中' : `${Math.max(0, Math.round(r.hpX10 / 10))}hp`,
    }))
    const sig = JSON.stringify(rows)
    if (sig !== this.lastRowsSig) {
      this.lastRowsSig = sig
      this.scoreRows.replaceChildren(...rows.map(row => {
        const div = document.createElement('div')
        div.className = 'hud-score-row'
        if (row.self) { div.append(icon('target')); div.title = '自己' }
        div.append(document.createTextNode(row.nick))
        if (row.partner) div.append(icon('partner'), document.createTextNode('搭档'))
        div.append(document.createTextNode(` · ${row.health}`))
        return div
      }))
    }

    this.updateSkills(world, self)
    this.updateUplink(world, map, self)
  }

  setAssist(on: boolean): void {
    this.assistLocal = on
    this.renderAssist()
  }

  /** 有界消息：定时自动清除，dispose 清理定时器（退出对局后可安全重入）。 */
  flashMsg(text: string): void {
    window.clearTimeout(this.msgTimer)
    this.msgLine.textContent = text
    this.msgLine.classList.remove('show')
    // 强制重排以重启动画
    void this.msgLine.offsetWidth
    this.msgLine.classList.add('show')
    this.msgTimer = window.setTimeout(() => this.clearMsg(), MSG_MS)
  }

  clearMsg(): void {
    window.clearTimeout(this.msgTimer)
    this.msgTimer = undefined
    this.msgLine.classList.remove('show')
    this.msgLine.textContent = ''
  }

  dispose(): void { this.clearMsg() }

  // ---- 技能卡组：纯状态显示 --------------------------------------------------
  // 冷却语义：readyTick 为服务器绝对 60Hz tick；字段缺失（旧服务器）显示 '—'
  // 表示未知，不臆造倒计时。冷却值一位小数秒。
  private updateSkills(world: WorldState, self: RobotEnt | undefined): void {
    if (!self) {
      for (const card of Object.values(this.skills)) this.setCard(card, 'off', '—')
      return
    }
    const dead = self.dead
    const en = self ? self.energyX10 / 10 : 0
    const fireCd = cdSeconds(world.self?.fireReadyTick, world.tick)
    const dashCd = cdSeconds(world.self?.dashReadyTick, world.tick)

    // 开火：无 CD 概念外的能量门槛（5/发）；间隔 250ms 仅在射击后瞬时可见
    if (dead) this.setCard(this.skills.fire, 'off', '阵亡')
    else if (self.shieldOn) this.setCard(this.skills.fire, 'off', '护盾中')
    else if (en < FIRE_COST_EN) this.setCard(this.skills.fire, 'off', `EN ${FIRE_COST_EN}`)
    else if (fireCd === undefined) this.setCard(this.skills.fire, 'ready', '—')
    else if (fireCd > 0) this.setCard(this.skills.fire, 'cooling', `${fireCd.toFixed(1)}s`)
    else this.setCard(this.skills.fire, 'ready', '—')

    // 冲刺：耗 20 EN + 服务器 CD
    if (dead) this.setCard(this.skills.dash, 'off', '阵亡')
    else if (self.dashing) this.setCard(this.skills.dash, 'active', '冲刺中')
    else if (en < DASH_COST_EN) this.setCard(this.skills.dash, 'off', `EN ${DASH_COST_EN}`)
    else if (dashCd === undefined) this.setCard(this.skills.dash, 'ready', '—')
    else if (dashCd > 0) this.setCard(this.skills.dash, 'cooling', `${dashCd.toFixed(1)}s`)
    else this.setCard(this.skills.dash, 'ready', '—')

    // 护盾：按住持续，无假 CD；开盾期间禁开火
    if (dead) this.setCard(this.skills.shield, 'off', '阵亡')
    else if (self.shieldOn) this.setCard(this.skills.shield, 'active', '开启中')
    else if (self.energyX10 < 3) this.setCard(this.skills.shield, 'off', '能量低')
    else this.setCard(this.skills.shield, 'ready', '按住')
  }

  // ---- Uplink 上下文面板 -----------------------------------------------------
  // 只在「激活阶段 + 自机处于 interactR 内」时出现；状态全部来自 world.uplinks。
  private updateUplink(world: WorldState, map: MapDefParsed | undefined, self: RobotEnt | undefined): void {
    const selfId = world.self?.robotId ?? -1
    const pos = self?.base?.pos
    const nearest = map && pos && !self?.dead ? nearestUplink(map, world.phase, pos.x, pos.y) : undefined
    const card = this.skills.uplink
    if (!nearest) {
      this.uplinkPanel.hidden = true
      this.setCard(card, 'off', self?.dead ? '阵亡' : self ? '靠近' : '—')
      return
    }
    const ent = world.uplinks.get(nearest.id)
    let pct = 0
    let text: string
    if (ent && world.self !== undefined && ent.hackingId === selfId) {
      pct = progressPct(ent.progressX10)
      text = `黑入 ${pct}%`
      this.setCard(card, 'active', `${pct}%`)
    } else if (ent && ent.myCooldownS > 0) {
      text = `冷却 ${Math.ceil(ent.myCooldownS)}秒`
      this.setCard(card, 'cooling', `${Math.ceil(ent.myCooldownS)}s`)
    } else if (ent && ent.hackingId !== 0) {
      pct = progressPct(ent.progressX10)
      text = '他人正在黑入'
      this.setCard(card, 'off', '占用中')
    } else {
      text = `按住 E/F · ${Math.round(HACK_TICKS / TICK_HZ)}秒`
      this.setCard(card, 'ready', '按住')
    }
    if (this.uplinkPanel.hidden) this.uplinkPanel.hidden = false
    setText(this.uplinkText, text)
    this.uplinkTrack.setAttribute('aria-valuenow', String(pct))
    this.uplinkFill.style.width = `${pct}%`
  }

  private setCard(card: SkillCard, state: CardState, cdText: string): void {
    if (card.root.dataset.state !== state) card.root.dataset.state = state
    setText(card.cd, cdText)
  }

  private renderAssist(): void {
    const on = this.assistServer ?? this.assistLocal
    setText(this.assistEl, on ? '辅助 ON' : '辅助 OFF')
    this.assistEl.classList.toggle('off', !on)
    const state = on ? 'active' : 'off'
    if (this.assistCard.dataset.state !== state) this.assistCard.dataset.state = state
  }
}

/** 结算覆盖层：分数行 + 称号。重复调用防重（服务器幂等但客户端也只渲染一次）；
 *  onBack：「回到房间」回调（本地切视图，不发 RoomAction）。 */
export function showMatchEnd(
  root: HTMLElement,
  rows: ScoreRow[],
  idToNick: Map<number, string>,
  onBack?: () => void,
): void {
  hideMatchEnd(root) // 防重：丢弃旧覆盖层，确保全屏只有一个
  const overlay = document.createElement('div')
  overlay.className = 'end-overlay'
  const title = document.createElement('div')
  title.className = 'end-title'
  title.textContent = 'MATCH END'
  overlay.appendChild(title)

  if (rows.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'end-empty'
    empty.textContent = '本局无得分记录'
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

  if (onBack) {
    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'end-back'
    const label = document.createElement('span')
    label.textContent = '回到房间'
    back.append(icon('back'), label)
    back.addEventListener('click', onBack)
    overlay.appendChild(back)
  }

  root.appendChild(overlay)
}

export function hideMatchEnd(root: HTMLElement): void {
  for (const el of root.querySelectorAll('.end-overlay')) el.remove()
}

// ---- helpers ---------------------------------------------------------------

/** 绝对 tick → 剩余秒（一位小数由调用方格式化）；字段缺失返回 undefined（未知）。 */
function cdSeconds(readyTick: number | undefined, nowTick: number): number | undefined {
  if (readyTick === undefined) return undefined
  return Math.max(0, (readyTick - nowTick) / TICK_HZ)
}

function progressPct(progressX10: number): number {
  const v = Math.round((progressX10 / HACK_MAX_X10) * 100)
  return v < 0 ? 0 : v > 100 ? 100 : v
}

/** 当前阶段内、自机 interactR 范围内最近的 Uplink。 */
function nearestUplink(map: MapDefParsed, phase: number, x: number, y: number): MapUplink | undefined {
  let best: MapUplink | undefined
  let bestD = Infinity
  for (const u of map.uplinks) {
    if (phase < u.activePhase || u.main && phase < 2) continue
    const d = Math.hypot(x - u.pos.x, y - u.pos.y)
    if (d <= u.interactR && d < bestD) { best = u; bestD = d }
  }
  return best
}

function* sortedRobots(robots: Map<number, RobotEnt>): Generator<RobotEnt> {
  const arr = [...robots.values()].sort((a, b) => (a.nick || '').localeCompare(b.nick || ''))
  yield* arr
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text
}

function req<T extends HTMLElement>(root: HTMLElement, id: string): T {
  const el = root.querySelector(`#${id}`) as T | null
  if (!el) throw new Error(`HUD 缺少元素 #${id}`)
  return el
}
