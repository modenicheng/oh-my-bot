// HUD 覆盖层（DOM）：HP/能量条、时间/阶段、比分简表、技能卡组、Uplink 状态、
// say 气泡事件、结算覆盖层。令牌严格走 client/STYLE.md：radius 0、1px #1f2733
// 描边、荧光只用于状态高亮。技能卡是状态显示（含键帽），不是可点击按钮。
import type { WorldState, RobotEnt } from './world'
import { type MapDefParsed, type MapUplink } from './mapdef'
import { hackMaxX10 } from './tuning'
import { phaseName } from './render'
import { type Scoreboard, type ScoreDisplay, scoreRow } from './scoreboard'
import { icon, type IconName } from '../icons'
import type { FeedbackKind } from './feedback'
import { AIM_STATUS_TEXT, aimControlStatus, axisTakeover } from './axis-src'
import { requireEl, setText, fmtClock } from '../ui/dom'
import { clamp01 } from '../lib/math'
import './hud.css'

const MSG_MS = 2600      // 消息驻留时长（有界定时器，dispose 可清理）
const INNER_MS = 4200
const AIM_HINT_MS = 4000 // 瞄准 guard 提示节流间隔
const BANNER_ICON: Record<FeedbackKind, IconName> = { status: 'target', kill: 'skull', uplink: 'uplink' }
/** scores 缺省时的稳定空数组：让 hud 的引用比对在无计分板时保持为 false。 */
const NO_ROWS: ScoreDisplay[] = []

interface SkillCard {
  root: HTMLDivElement
  cd: HTMLElement
}

type CardState = 'ready' | 'cooling' | 'active' | 'off' | 'takeover' | 'standby'

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
  private assistCard: HTMLDivElement
  private msgLine: HTMLDivElement
  private msgTimer: number | undefined
  private innerBanner: HTMLDivElement
  private innerTimer: number | undefined
  private countdownTimer: number | undefined
  /** 瞄准 guard 提示下次可触发时间（performance.now 基准）。 */
  private aimHintUntil = 0
  private reduced = matchMedia('(prefers-reduced-motion: reduce)')
  private assistLocal = false
  private assistServer: boolean | undefined
  private skills: Record<'move' | 'aim' | 'fire' | 'dash' | 'shield' | 'uplink', SkillCard>
  private uplinkPanel: HTMLDivElement
  private uplinkText: HTMLSpanElement
  private uplinkTrack: HTMLDivElement
  private uplinkFill: HTMLDivElement
  private lastHp = -1
  private lastEn = -1
  private lastRows: ScoreDisplay[] = NO_ROWS
  private uplinkPct = -1
  private assistRenderedOn: boolean | undefined
  private takeoverRendered = ''
  private aimStatusText = AIM_STATUS_TEXT.unavailable
  /** 瞄准能力信号（Workbench 上报），updateTakeover 供 aimControlStatus 用。 */
  private aimCapable = false

  constructor(private root: HTMLElement) {
    this.hpFill = requireEl(root, 'hud-hp-fill')
    this.enFill = requireEl(root, 'hud-en-fill')
    this.hpText = requireEl(root, 'hud-hp-text')
    this.enText = requireEl(root, 'hud-en-text')
    this.leftPanel = requireEl(root, 'hud-left')
    this.phaseEl = requireEl(root, 'hud-phase')
    this.timeEl = requireEl(root, 'hud-time')
    this.scoreRows = requireEl(root, 'hud-score-rows')
    const ownScore = document.createElement('div')
    ownScore.id = 'hud-self-score'
    ownScore.append(document.createTextNode('当前积分'))
    this.selfScore = document.createElement('strong')
    ownScore.append(this.selfScore)
    this.leftPanel.append(ownScore)
    this.assistEl = requireEl(root, 'hud-assist')
    this.assistCard = requireEl(root, 'skill-assist')
    this.msgLine = requireEl(root, 'hud-msg')
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
      move: { root: requireEl(root, 'skill-move'), cd: requireEl(root, 'skill-move-cd') },
      aim: { root: requireEl(root, 'skill-aim'), cd: requireEl(root, 'skill-aim-cd') },
      fire: { root: requireEl(root, 'skill-fire'), cd: requireEl(root, 'skill-fire-cd') },
      dash: { root: requireEl(root, 'skill-dash'), cd: requireEl(root, 'skill-dash-cd') },
      shield: { root: requireEl(root, 'skill-shield'), cd: requireEl(root, 'skill-shield-cd') },
      uplink: { root: requireEl(root, 'skill-uplink'), cd: requireEl(root, 'skill-uplink-cd') },
    }
    this.uplinkPanel = requireEl(root, 'hud-uplink')
    this.uplinkText = requireEl(root, 'hud-uplink-text')
    this.uplinkTrack = requireEl(root, 'hud-uplink-track')
    this.uplinkFill = requireEl(root, 'hud-uplink-fill')
  }

  /** map 为可选：mapBootstrap 完成前也能渲染基础状态。 */
  update(world: WorldState, map?: MapDefParsed, scores?: Scoreboard, aimCapable = false): void {
    if (!world.initialized) { this.clearMsg(); this.clearInnerRing(); this.clearCountdown() }
    const selfId = world.self?.robotId ?? -1
    const self = world.robots.get(selfId)
    this.aimCapable = aimCapable

    // 常态机体用低饱和绿，能量用青色；数值与颜色共同标识状态。
    const tuning = world.tuning
    this.leftPanel.classList.toggle('dead', !!self?.dead)
    if (self) {
      const hp = clamp01(self.hpX10 / tuning.maxHpX10)
      const en = clamp01(self.energyX10 / tuning.maxEnergyX10)
      // scaleX 走合成器路径（app.css transition 同步为 transform），width 每帧触发 layout。
      if (hp !== this.lastHp) { this.lastHp = hp; this.hpFill.style.transform = `scaleX(${hp})` }
      if (en !== this.lastEn) { this.lastEn = en; this.enFill.style.transform = `scaleX(${en})` }
      setText(this.hpText, self.dead ? `重生 ${self.respawnInS.toFixed(1)}s` : `${Math.round(self.hpX10 / 10)}`)
      setText(this.enText, `${Math.round(self.energyX10 / 10)}`)
    } else {
      this.lastHp = this.lastEn = 0
      this.hpFill.style.transform = this.enFill.style.transform = 'scaleX(0)'
      setText(this.hpText, '—'); setText(this.enText, '—')
    }

    // 辅助开关：服务器权威值优先；缺失（旧服务器）回退本地输入
    this.assistServer = world.self?.assistOn
    this.renderAssist()

    // 阶段 / 时间
    setText(this.phaseEl, phaseName(world.phase))
    const clock = world.initialized ? fmtClock(world.timeLeftS) : '—:—'
    setText(this.timeEl, clock)
    this.timeEl.classList.toggle('urgent', world.initialized && world.timeLeftS >= 0 && world.timeLeftS <= 30)

    setText(this.selfScore, String(scores?.score(selfId) ?? '—'))
    // scoreboard.display 内部按 (版本, self, 阵亡位) 缓存：引用相同即数据未变，
    // 免去此前每帧 JSON.stringify 签名与整表重建。
    const rows = scores?.display(world.robots, selfId) ?? NO_ROWS
    if (rows !== this.lastRows) {
      this.lastRows = rows
      this.scoreRows.replaceChildren(...rows.map(row => scoreRow(row)))
      if (!rows.length) {
        const empty = document.createElement('div')
        empty.className = 'score-waiting'
        empty.textContent = scores?.hasScores ? '暂无积分记录' : '等待积分同步'
        this.scoreRows.append(empty)
      }
    }

    this.updateSkills(world, self)
    this.updateTakeover(world, self)
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

  /** 瞄准 guard 生效期间的鼠标移动提示（4s 节流；不与 kill/uplink 横幅竞争）。 */
  flashAimGuardHint(): void {
    const now = performance.now()
    if (this.msgTimer !== undefined && now < this.aimHintUntil) return
    this.aimHintUntil = now + AIM_HINT_MS
    this.flashMsg(`${this.aimStatusText} · 按 R 手动瞄准`)
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
    // 移动/瞄准卡由 updateTakeover 按分轴来源渲染（无冷却语义），不在此循环内。
    if (!self) {
      for (const card of [this.skills.fire, this.skills.dash, this.skills.shield]) this.setCard(card, 'off', '—')
      return
    }
    const dead = self.dead
    const tuning = world.tuning
    const en = self.energyX10 / 10
    const fireCd = cdSeconds(world.self?.fireReadyTick, world.tick, tuning.tickRate)

    // 开火：无 CD 概念外的能量门槛（服务器 fire_cost，X-3）；间隔 250ms 仅在射击后瞬时可见
    if (dead) this.setCard(this.skills.fire, 'off', '阵亡')
    else if (self.shieldOn) this.setCard(this.skills.fire, 'off', '护盾中')
    else if (en < tuning.fireCost) this.setCard(this.skills.fire, 'off', `EN ${tuning.fireCost}`)
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
    const hackMax = hackMaxX10(world.tuning)
    const hackSeconds = Math.round(world.tuning.hackDurationTicks / world.tuning.tickRate)
    let pct = 0
    let text: string
    if (ent && world.self !== undefined && ent.hackingId === selfId) {
      pct = progressPct(ent.progressX10, hackMax)
      text = `黑入 ${pct}%`
      this.setCard(card, 'active', `${pct}%`)
    } else if (ent && ent.myCooldownS > 0) {
      text = `冷却 ${Math.ceil(ent.myCooldownS)}秒`
      this.setCard(card, 'cooling', `${Math.ceil(ent.myCooldownS)}s`)
    } else if (ent && ent.hackingId !== 0) {
      pct = progressPct(ent.progressX10, hackMax)
      text = '他人正在黑入'
      this.setCard(card, 'off', '占用中')
    } else {
      text = `按住 E/F · ${hackSeconds}秒`
      this.setCard(card, 'ready', '按住')
    }
    if (this.uplinkPanel.hidden) this.uplinkPanel.hidden = false
    setText(this.uplinkText, text)
    // 面板可见时 update 每帧到达：等值守卫避免重复 DOM 写；进度条同走 scaleX 合成路径。
    if (pct !== this.uplinkPct) {
      this.uplinkPct = pct
      this.uplinkTrack.setAttribute('aria-valuenow', String(pct))
      this.uplinkFill.style.transform = `scaleX(${pct / 100})`
    }
  }

  private setCard(card: SkillCard, state: CardState, cdText: string): void {
    if (card.root.dataset.state !== state) card.root.dataset.state = state
    setText(card.cd, cdText)
  }

  private renderAssist(): void {
    const on = this.assistServer ?? this.assistLocal
    if (on === this.assistRenderedOn) return
    this.assistRenderedOn = on
    setText(this.assistEl, on ? '辅助 ON' : '辅助 OFF')
    this.assistEl.classList.toggle('off', !on)
    const state = on ? 'active' : 'off'
    if (this.assistCard.dataset.state !== state) this.assistCard.dataset.state = state
  }

  // ---- 脚本接管标记（ADR-0009 仲裁结果的 HUD 投影） ------------------------
  // move/aim 轴在技能卡组首两卡；fire/ability 轴沿用开火/冲刺/护盾卡：脚本正在
  // 输出某轴时对应卡标 data-takeover="script"（琥珀色，见 hud.css）。服务器逐
  // tick 回显仲裁来源，人一按键即抢占，标记随之消失。等值守卫：快照 60Hz 到达
  // 而接管组合极少变化。快照丢失/未初始化时旧标记保留，下一次快照修正。
  private updateTakeover(world: WorldState, self: RobotEnt | undefined): void {
    const t = axisTakeover(world.self)
    const aim = aimControlStatus(world.self, this.aimCapable)
    this.aimStatusText = AIM_STATUS_TEXT[aim]
    const dead = !!self?.dead
    const sig = `${world.self ? 1 : 0}${dead ? 1 : 0}${t.move ? 1 : 0}${aim}${t.fire ? 1 : 0}${t.ability ? 1 : 0}`
    if (sig === this.takeoverRendered) return
    this.takeoverRendered = sig
    this.setTakeover(this.skills.fire, t.fire)
    this.setTakeover(this.skills.dash, t.ability)
    this.setTakeover(this.skills.shield, t.ability)
    this.setTakeover(this.skills.uplink, t.ability)
    if (!world.self) {
      this.setTakeover(this.skills.move, false)
      this.setTakeover(this.skills.aim, false)
      this.setCard(this.skills.move, 'off', '—')
      this.setCard(this.skills.aim, 'off', '—')
      return
    }
    // 自瞄已启用但本 tick 没有输出时保持待机，不误报手操或正在跟踪。
    this.setTakeover(this.skills.move, t.move)
    this.setTakeover(this.skills.aim, !dead && aim === 'aiming')
    if (dead) {
      this.setCard(this.skills.move, 'off', '阵亡')
      this.setCard(this.skills.aim, 'off', '阵亡')
    } else {
      this.setCard(this.skills.move, t.move ? 'takeover' : 'ready', t.move ? '脚本' : '手操')
      this.setCard(this.skills.aim, aim === 'aiming' ? 'takeover' : aim === 'standby' ? 'standby' : 'ready', this.aimStatusText)
    }
  }

  private setTakeover(card: SkillCard, on: boolean): void {
    if (on) card.root.dataset.takeover = 'script'
    else delete card.root.dataset.takeover
  }
}

// ---- helpers ---------------------------------------------------------------

/** 绝对 tick → 剩余秒（一位小数由调用方格式化）；字段缺失返回 undefined（未知）。 */
function cdSeconds(readyTick: number | undefined, nowTick: number, tickRate: number): number | undefined {
  if (readyTick === undefined) return undefined
  return Math.max(0, (readyTick - nowTick) / tickRate)
}

function progressPct(progressX10: number, hackMax: number): number {
  const v = Math.round((progressX10 / hackMax) * 100)
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
