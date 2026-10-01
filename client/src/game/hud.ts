// HUD 覆盖层（DOM）：HP/能量条、时间/阶段、比分简表、技能卡组、Uplink 状态、
// say 气泡事件、结算覆盖层。令牌严格走 client/STYLE.md：radius 0、1px #1f2733
// 描边、荧光只用于状态高亮。技能卡是状态显示（含键帽），不是可点击按钮。
import type { WorldState, RobotEnt } from './world'
import type { MapDefParsed, MapUplink } from './mapdef'
import { phaseName } from './render'
import { type Scoreboard, scoreRow } from './scoreboard'
import { icon, type IconName } from '../icons'
import type { FeedbackKind } from './feedback'
import './hud.css'

const MAX_HP = 1000   // hp_x10（×10）
const MAX_EN = 1000   // energy_x10（×10）
const TICK_HZ = 60    // 服务器固定 60Hz 绝对 tick
const FIRE_COST_EN = 5   // server sim.FireCost
const HACK_TICKS = 480   // server sim.HackDuration（480 tick = 8s）
const HACK_MAX_X10 = 80  // progress_x10 满值（8s × 10）
const MSG_MS = 2600      // 消息驻留时长（有界定时器，dispose 可清理）
const INNER_MS = 4200
const BANNER_ICON: Record<FeedbackKind, IconName> = { status: 'target', kill: 'skull', uplink: 'uplink' }

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
  private selfScore: HTMLElement
  private scoreRows: HTMLDivElement
  private assistEl: HTMLDivElement
  private assistHint: HTMLDivElement
  private assistCard: HTMLDivElement
  private msgLine: HTMLDivElement
  private msgTimer: number | undefined
  private innerBanner: HTMLDivElement
  private innerTimer: number | undefined
  private countdownTimer: number | undefined
  private reduced = matchMedia('(prefers-reduced-motion: reduce)')
  private assistLocal = false
  private assistServer: boolean | undefined
  /** SelfState 权威分轴状态（缺失 = 旧服务器）。 */
  private manualAxesMask: number | undefined
  private assistMoveSrc: number | undefined
  private assistTurretSrc: number | undefined
  private assistFireSrc: number | undefined
  private assistAbilitySrc: number | undefined
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
    const ownScore = document.createElement('div')
    ownScore.id = 'hud-self-score'
    ownScore.append(document.createTextNode('当前积分'))
    this.selfScore = document.createElement('strong')
    ownScore.append(this.selfScore)
    this.leftPanel.append(ownScore)
    this.assistEl = req(root, 'hud-assist')
    this.assistCard = req(root, 'skill-assist')
    this.assistHint = req(root, 'hud-assist-hint')
    this.msgLine = req(root, 'hud-msg')
    this.msgLine.setAttribute('role', 'status')
    if (!this.msgLine.hasAttribute('aria-live')) this.msgLine.setAttribute('aria-live', 'polite')
    this.msgLine.setAttribute('aria-atomic', 'true')
    this.leftPanel.append(this.msgLine)
    this.innerBanner = document.createElement('div')
    this.innerBanner.id = 'hud-inner-ring'
    this.innerBanner.className = 'hud-inner-ring'
    this.innerBanner.setAttribute('role', 'status')
    this.innerBanner.setAttribute('aria-live', 'polite')
    this.innerBanner.setAttribute('aria-atomic', 'true')
    this.innerBanner.hidden = true
    root.append(this.innerBanner)
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
  update(world: WorldState, map?: MapDefParsed, scores?: Scoreboard): void {
    if (!world.initialized) { this.clearMsg(); this.clearInnerRing(); this.clearCountdown() }
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
    this.manualAxesMask = world.self?.manualAxesMask
    this.assistMoveSrc = world.self?.moveSrc
    this.assistTurretSrc = world.self?.turretSrc
    this.assistFireSrc = world.self?.fireSrc
    this.assistAbilitySrc = world.self?.abilitySrc
    this.renderAssist()

    // 阶段 / 时间
    setText(this.phaseEl, phaseName(world.phase))
    const t = Math.max(0, world.timeLeftS)
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60)
    const clock = world.initialized ? `${m}:${String(s).padStart(2, '0')}` : '—:—'
    if (this.timeEl.textContent !== clock) this.timeEl.textContent = clock
    this.timeEl.classList.toggle('urgent', world.initialized && world.timeLeftS >= 0 && world.timeLeftS <= 30)

    setText(this.selfScore, String(scores?.score(selfId) ?? '—'))
    const rows = scores?.display(world.robots, selfId) ?? []
    const sig = JSON.stringify([scores?.hasScores, rows])
    if (sig !== this.lastRowsSig) {
      this.lastRowsSig = sig
      this.scoreRows.replaceChildren(...rows.map(row => scoreRow(row)))
      if (!rows.length) {
        const empty = document.createElement('div')
        empty.className = 'score-waiting'
        empty.textContent = scores?.hasScores ? '暂无积分记录' : '等待积分同步'
        this.scoreRows.append(empty)
      }
    }

    this.updateSkills(world, self)
    this.updateUplink(world, map, self)
  }

  setAssist(on: boolean): void {
    this.assistLocal = on
    this.renderAssist()
  }

  /** 有界消息：定时自动清除，dispose 清理定时器（退出对局后可安全重入）。 */
  flashMsg(text: string, kind: FeedbackKind = 'status'): void {
    // Keep confirmed kill/upload banners readable through routine combat hints.
    if (kind === 'status' && this.msgTimer !== undefined && this.msgLine.dataset.kind !== 'status') return
    window.clearTimeout(this.msgTimer)
    const label = document.createElement('span')
    label.className = 'hud-event-text'
    label.textContent = text
    this.msgLine.dataset.kind = kind
    this.msgLine.replaceChildren(icon(BANNER_ICON[kind]), label)
    this.restartAnimation(this.msgLine, 'show')
    this.msgTimer = window.setTimeout(() => this.clearMsg(), MSG_MS)
  }

  showInnerRing(): void {
    window.clearTimeout(this.innerTimer)
    const text = document.createElement('div')
    text.className = 'hud-inner-copy'
    const title = document.createElement('strong')
    title.textContent = '核心区已开放'
    const detail = document.createElement('span')
    detail.textContent = '内环解锁 · 主 Uplink 已激活'
    text.append(title, detail)
    this.innerBanner.replaceChildren(icon('target'), text, icon('uplink'))
    this.innerBanner.hidden = false
    this.restartAnimation(this.innerBanner, 'show')
    this.innerTimer = window.setTimeout(() => this.clearInnerRing(), INNER_MS)
  }

  pulseCountdown(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) return
    window.clearTimeout(this.countdownTimer)
    this.timeEl.dataset.countdown = String(seconds)
    this.timeEl.classList.add('urgent')
    this.restartAnimation(this.timeEl, 'countdown-pulse')
    this.countdownTimer = window.setTimeout(() => this.clearCountdown(), 480)
  }

  clearMsg(): void {
    window.clearTimeout(this.msgTimer)
    this.msgTimer = undefined
    this.msgLine.classList.remove('show')
    this.msgLine.replaceChildren()
    delete this.msgLine.dataset.kind
  }

  dispose(): void {
    this.clearMsg(); this.clearInnerRing(); this.clearCountdown()
    this.timeEl.classList.remove('urgent')
    this.innerBanner.remove()
    this.selfScore.parentElement?.remove()
  }

  private clearInnerRing(): void {
    window.clearTimeout(this.innerTimer)
    this.innerTimer = undefined
    this.innerBanner.hidden = true
    this.innerBanner.classList.remove('show')
    this.innerBanner.replaceChildren()
  }

  private clearCountdown(): void {
    window.clearTimeout(this.countdownTimer)
    this.countdownTimer = undefined
    this.timeEl.classList.remove('countdown-pulse')
    delete this.timeEl.dataset.countdown
  }

  private restartAnimation(el: HTMLElement, className: string): void {
    el.classList.remove(className)
    if (!this.reduced.matches) void el.offsetWidth
    el.classList.add(className)
  }

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

    // 开火：无 CD 概念外的能量门槛（5/发）；间隔 250ms 仅在射击后瞬时可见
    if (dead) this.setCard(this.skills.fire, 'off', '阵亡')
    else if (self.shieldOn) this.setCard(this.skills.fire, 'off', '护盾中')
    else if (en < FIRE_COST_EN) this.setCard(this.skills.fire, 'off', `EN ${FIRE_COST_EN}`)
    else if (fireCd === undefined) this.setCard(this.skills.fire, 'ready', '—')
    else if (fireCd > 0) this.setCard(this.skills.fire, 'cooling', `${fireCd.toFixed(1)}s`)
    else this.setCard(this.skills.fire, 'ready', '—')

    // 冲刺：按住持续耗能，无冷却；护盾优先。
    if (dead) this.setCard(this.skills.dash, 'off', '阵亡')
    else if (self.shieldOn) this.setCard(this.skills.dash, 'off', '护盾中')
    else if (self.dashing) this.setCard(this.skills.dash, 'active', '冲刺中')
    else if (self.energyX10 < 4) this.setCard(this.skills.dash, 'off', '能量低')
    else this.setCard(this.skills.dash, 'ready', '按住')

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
    // 逐轴手操提示（服务端权威 manual_axes_mask；bit0 move/1 aim/2 fire/3 ability）。
    // 仅在辅助开启且部分轴被人工接管时显示：这正是“Space 交回辅助”生效的状态
    // （第二分支）。辅助关闭时玩家全手操属正常驾驶，不提示。缺失（旧服务器）回退
    // 分轴来源标记推导，不做其他猜测。
    const mask = this.manualAxesMask ?? srcMask(this.assistMoveSrc, this.assistTurretSrc, this.assistFireSrc, this.assistAbilitySrc)
    const manual = on ? axesFromMask(mask) : []
    const manualLine = manual.length ? `手操 ${manual.join('/')} · Space 交回辅助` : ''
    setText(this.assistHint, manualLine)
    this.assistHint.classList.toggle('on', manual.length > 0)
    if (manual.length > 0) this.assistHint.removeAttribute('hidden')
    else this.assistHint.setAttribute('hidden', '')
    setText(this.assistEl, on ? '辅助 ON' : '辅助 OFF')
    this.assistEl.classList.toggle('off', !on)
    const state = on ? 'active' : 'off'
    if (this.assistCard.dataset.state !== state) this.assistCard.dataset.state = state
  }
}

// ---- helpers ---------------------------------------------------------------

/** 控制来源枚举（omb.v1.ControlSource）。 */
const CS_HUMAN = 1

/** 权威 manual_axes_mask 位定义（与协议 ClientInput.axis_mask 同构）。 */
const AXIS_MOVE = 1 << 0
const AXIS_AIM = 1 << 1
const AXIS_FIRE = 1 << 2
const AXIS_ABILITY = 1 << 3

/** mask → 手操轴名列表（HUD 文案）。 */
function axesFromMask(mask: number): string[] {
  const out: string[] = []
  if (mask & AXIS_MOVE) out.push('移动')
  if (mask & AXIS_AIM) out.push('瞄准')
  if (mask & AXIS_FIRE) out.push('开火')
  if (mask & AXIS_ABILITY) out.push('技能')
  return out
}

/** 旧服务器回退：由分轴来源标记推导手操轴。 */
function srcMask(move: number | undefined, turret: number | undefined, fire: number | undefined, ability: number | undefined): number {
  let m = 0
  if (move === CS_HUMAN) m |= AXIS_MOVE
  if (turret === CS_HUMAN) m |= AXIS_AIM
  if (fire === CS_HUMAN) m |= AXIS_FIRE
  if (ability === CS_HUMAN) m |= AXIS_ABILITY
  return m
}

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
