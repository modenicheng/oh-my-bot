// GameFeedback（C-17 拆分后的门面）：确认事件/状态转移的瞬态表现。
// 视觉子层在各自模块：effects（特效注册表）/ vitals（延迟血条+飘字+低血框）/
// trails（冲刺拖尾）/ camera-feel（震屏+变焦）/ visibility（撞击可见性）。
// 快照消费、事件去重、音频线索、倒计时与文案裁决留在本文件。
import type { ClientInput, ServerEvent, SnapshotDelta } from '@omb/protocol'
import { audio, type SoundCue } from '../../audio'
import type { Camera } from '../camera'
import { type MapDefParsed, type MapUplink, type MapVec2 } from '../mapdef'
import { hackMaxX10 } from '../tuning'
import type { WorldState } from '../world'
import type { KillFeedSource } from '../kill-feed'
import { cyan, green, red, white } from './constants'
import { CameraFeel } from './camera-feel'
import { Effects, EFFECT_MS } from './effects'
import { Trails } from './trails'
import { LOW_HEALTH_X10, Vitals } from './vitals'
import { visibleImpact } from './visibility'
import type { FeedbackKind } from './types'

export type { FeedbackKind } from './types'

/** 命中音高连击：520ms 窗口内逐次升调，上限 6 级、步进 0.07。 */
const HIT_CHAIN_MS = 520
const HIT_CHAIN_MAX = 6
const HIT_CHAIN_PITCH_STEP = 0.07
/** 事件去重表容量（可靠事件重放防线）。 */
const SEEN_MAX = 512
/** 就位音效的可闻距离与声像参数。 */
const SOUND_RANGE = 24
const SOUND_PAN_LIMIT = 0.8
const SOUND_PAN_DIVISOR = 20
/** 输入拒绝提示节流。 */
const DENY_THROTTLE_MS = 700
/** 撞墙特效/音效阈值与强度归一（impact 原始冲量 → 0..1 增益）。 */
const WALL_HIT_MIN_IMPACT = 1.5
const WALL_HIT_IMPACT_SCALE = 8
const WALL_HIT_COLOR = '#9bafbd'

/** Transient presentation follows confirmed events/state transitions; resyncs establish a quiet baseline. */
export class GameFeedback {
  private fx: Effects
  private vitals: Vitals
  private trails: Trails
  private camFeel: CameraFeel
  private seen = new Set<string>()
  private robots = new Map<number, { shield: boolean; dash: boolean; dead: boolean; hpX10: number }>()
  private cores = new Set<number>()
  private hackers = new Map<number, number>()
  private completed = new Map<number, number>()
  private near = 0
  private baseline = false
  private quietThroughTick = -1
  private phase: number | undefined
  private innerOpened = false
  private seconds: number | undefined
  private countdownWarned = false
  private countdownTicks = new Set<number>()
  private held = { fire: false, shield: false, interact: false }
  private lastDenied = -Infinity
  private hitChain = { at: -Infinity, count: 0 }
  private reduced = matchMedia('(prefers-reduced-motion: reduce)')

  constructor(
    private message: (text: string, kind?: FeedbackKind, source?: KillFeedSource) => void,
    private onInnerRing?: () => void,
    private onCountdown?: (seconds: number) => void,
  ) {
    this.fx = new Effects(this.reduced)
    this.vitals = new Vitals(this.reduced)
    this.trails = new Trails(this.reduced)
    this.camFeel = new CameraFeel(this.reduced)
  }

  reset(): void {
    this.fx.clear(); this.vitals.reset(); this.trails.clear(); this.camFeel.reset()
    this.seen.clear(); this.robots.clear(); this.hackers.clear(); this.completed.clear()
    this.near = 0; this.baseline = false; this.lastDenied = -Infinity
    this.quietThroughTick = -1; this.phase = undefined; this.innerOpened = false
    this.seconds = undefined; this.countdownWarned = false; this.countdownTicks.clear()
    this.held = { fire: false, shield: false, interact: false }
    this.hitChain = { at: -Infinity, count: 0 }
    audio.stopGame()
  }

  pause(): void { this.fx.clear(); this.vitals.clearPopups(); this.trails.clear(); this.near = 0; this.baseline = false; this.camFeel.calm(); audio.stopGame() }

  snapshot(world: WorldState, map: MapDefParsed, snap: SnapshotDelta, active: boolean): void {
    const transitions = this.baseline && !snap.full && active && !document.hidden
    const selfId = world.self?.robotId
    if (!transitions) this.quietThroughTick = Math.max(this.quietThroughTick, snap.tick)
    if (world.phase >= map.coreZone.unlockPhase) {
      if (transitions && this.phase !== undefined && this.phase < map.coreZone.unlockPhase) this.openInnerRing()
      else if (!transitions) this.innerOpened = true
    }
    this.phase = world.phase
    this.countdown(world, transitions)
    const now = performance.now()
    for (const [id, r] of world.robots) {
      const prev = this.robots.get(id), pos = r.base?.pos
      if (this.vitals.absorb(id, prev?.hpX10, r.hpX10, transitions, now)) {
        if (pos) this.vitals.popup(id, pos, prev!.hpX10 - r.hpX10, now, id * 31 + snap.tick)
        if (id === selfId && r.hpX10 <= LOW_HEALTH_X10) this.vitals.markSelfHit(now)
      }
      if (transitions && prev && pos) {
        if (r.dashing && !prev.dash) { this.fx.add('dash', pos, cyan, id, EFFECT_MS.dash, r.base?.heading); this.sound('dash', pos, world, 1, id === selfId) }
        if (r.shieldOn !== prev.shield) this.sound(r.shieldOn ? 'shieldOn' : 'shieldOff', pos, world, 1, id === selfId)
      }
      if (transitions && r.dashing && pos) {
        this.trails.record(id, snap.tick, pos, r.color || cyan)
      } else if (!transitions) this.trails.drop(id)
      // 审计 C-40：prev 就是 map 内存储对象，原地改写——60Hz×64 人下每 tick
      // 新建 4 字段对象是稳定 GC 饲料。
      if (prev) { prev.shield = r.shieldOn; prev.dash = r.dashing; prev.dead = r.dead; prev.hpX10 = r.hpX10 } else {
        this.robots.set(id, { shield: r.shieldOn, dash: r.dashing, dead: r.dead, hpX10: r.hpX10 })
      }
    }
    const self = selfId !== undefined ? world.robots.get(selfId) : undefined
    this.vitals.setSelfLow(!!selfId && !!self && !self.dead && self.hpX10 <= LOW_HEALTH_X10)
    for (const id of this.robots.keys()) if (!world.robots.has(id)) { this.robots.delete(id); this.vitals.forget(id); this.trails.drop(id) }
    for (const [id, core] of world.cores) {
      if (transitions && !this.cores.has(id) && core.base?.pos) {
        this.fx.add('spawn', core.base.pos, cyan, id, EFFECT_MS.coreSpawn)
        this.sound('coreSpawn', core.base.pos, world)
      }
    }
    // 审计 C-40：cores 集合原地增删，替代每快照重建 Set（spawn 检测已在
    // 上面的循环里用旧集合完成，这里只做同步）。
    for (const id of world.cores.keys()) if (!this.cores.has(id)) this.cores.add(id)
    for (const id of this.cores) if (!world.cores.has(id)) this.cores.delete(id)
    for (const [id, u] of world.uplinks) {
      const prev = this.hackers.get(id) ?? 0
      if (transitions && selfId) {
        if (u.hackingId === selfId && prev !== selfId) {
          audio.play('uplinkStart'); this.message('正在黑入 · 持续按住 E / F', 'uplink')
        } else if (prev === selfId && u.hackingId !== selfId && u.myCooldownS === 0 && world.tick > (this.completed.get(id) ?? -1) + 2) {
          audio.play('uplinkCancel'); this.message('黑入中断 · 保持范围内，按住 E / F', 'uplink')
        }
      }
      this.hackers.set(id, u.hackingId)
    }
    this.ambience(world, map, active, transitions)
    this.baseline = active && !document.hidden
  }

  ambience(world: WorldState, map: MapDefParsed, active: boolean, transitions = this.baseline): void {
    const self = world.robots.get(world.self?.robotId ?? 0), pos = self?.base?.pos
    if (!active || document.hidden) { this.baseline = false; this.near = 0; audio.setUplink('off'); return }
    if (!pos || self?.dead) { this.near = 0; audio.setUplink('off'); return }
    // 单循环取范围内最近 Uplink：rAF 与快照双路径每帧到达，避免 filter+sort 的临时数组。
    let nearest: MapUplink | undefined
    let bestD = Infinity
    for (const u of map.uplinks) {
      if (world.phase < u.activePhase || (u.main && world.phase < 2)) continue
      const d = Math.hypot(pos.x - u.pos.x, pos.y - u.pos.y)
      if (d <= u.interactR && d < bestD) { nearest = u; bestD = d }
    }
    const id = nearest?.id ?? 0
    if (id && id !== this.near && transitions) {
      audio.play('uplinkEnter')
      const state = world.uplinks.get(id)
      this.message(state?.myCooldownS ? `Uplink 冷却 ${state.myCooldownS}s` : '已接入 Uplink · 按住 E / F 黑入', 'uplink')
    }
    this.near = id
    const u = world.uplinks.get(id)
    audio.setUplink(!id ? 'off' : u?.hackingId === world.self?.robotId ? 'hacking' : 'near', (u?.progressX10 ?? 0) / hackMaxX10(world.tuning))
  }

  event(ev: ServerEvent, world: WorldState, map: MapDefParsed, active: boolean): void {
    const k = ev.kind
    const opening = k.case === 'phaseChange' && k.value.to >= map.coreZone.unlockPhase
    if (!active) { if (opening) this.innerOpened = true; return }
    // Reliable delivery can be retried. Keep background events seen so they cannot replay on return.
    const key = `${ev.tick}:${k.case}:${JSON.stringify(k.value, (_, value) => typeof value === 'bigint' ? value.toString() : value)}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!)
    if (document.hidden) { this.baseline = false; if (opening) this.innerOpened = true; return }
    if (ev.tick <= this.quietThroughTick && k.case !== 'matchStart' && k.case !== 'matchEnd') return
    const selfId = world.self?.robotId
    switch (k.case) {
      case 'shot':
        if (!world.robots.has(k.value.owner)) break
        if (k.value.at) { this.fx.add('shot', k.value.at, k.value.color || world.robots.get(k.value.owner)?.color || white, k.value.projectile, EFFECT_MS.shot, k.value.heading); this.sound('shot', k.value.at, world, 1, k.value.owner === selfId) }
        break
      case 'projectileImpact':
        if (!k.value.at || !visibleImpact(k.value.at, world, map, k.value.projectile)) break
        if (k.value.at) {
          this.fx.add('impact', k.value.at, k.value.shield || k.value.invulnerable ? white : k.value.target ? red : k.value.color || world.projectiles.get(k.value.projectile)?.color || world.robots.get(k.value.owner)?.color || cyan, k.value.projectile, EFFECT_MS.impact)
          const cue = k.value.shield || k.value.invulnerable ? 'shieldHit' : 'hit'
          const now = performance.now()
          this.hitChain.count = now - this.hitChain.at <= HIT_CHAIN_MS ? Math.min(HIT_CHAIN_MAX, this.hitChain.count + 1) : 1
          this.hitChain.at = now
          this.sound(cue, k.value.at, world, 1, k.value.target === selfId, cue === 'hit' ? 1 + (this.hitChain.count - 1) * HIT_CHAIN_PITCH_STEP : 1)
        }
        if (k.value.target === selfId && !k.value.invulnerable) this.message(k.value.shield ? '护盾吸收命中' : '机体受击')
        break
      case 'wallHit':
        if (!world.robots.has(k.value.robot)) break
        if (k.value.at && k.value.impact >= WALL_HIT_MIN_IMPACT) {
          this.fx.add('impact', k.value.at, WALL_HIT_COLOR, k.value.robot, EFFECT_MS.wallImpact)
          this.sound('wallHit', k.value.at, world, Math.min(1, k.value.impact / WALL_HIT_IMPACT_SCALE))
        }
        break
      case 'corePickup': {
        const own = k.value.by === selfId
        const p = world.cores.get(k.value.coreId)?.base?.pos ?? map.corePads.find(p => p.id === k.value.coreId)?.pos
          ?? world.robots.get(k.value.by)?.base?.pos
        if (p) this.fx.add('pickup', p, green, k.value.coreId, EFFECT_MS.corePickup)
        // A delta can remove the core before its pickup event, including all position data for self.
        if (own) { audio.play('corePickup'); this.message(`拾取 Core · +${k.value.value} 分`) }
        else if (p) this.sound('corePickup', p, world)
        break
      }
      case 'heal': {
        const own = k.value.by === selfId
        const p = k.value.at ?? map.healthPacks.find(pack => pack.id === k.value.id)?.pos
          ?? world.robots.get(k.value.by)?.base?.pos
        if (p) this.fx.add('heal', p, green, k.value.id, EFFECT_MS.heal)
        if (own) {
          audio.play('healthPickup')
          this.message(`生命回灌 · +${(k.value.healX10 / 10).toFixed(k.value.healX10 % 10 ? 1 : 0)} HP`, 'status')
        } else if (p) this.sound('healthPickup', p, world)
        break
      }
      case 'uplinkHack': {
        const p = map.uplinks.find(u => u.id === k.value.uplinkId)?.pos
        if (p) { this.fx.add('uplink', p, green, k.value.uplinkId, EFFECT_MS.uplinkRing); this.fx.add('splash', p, cyan, k.value.uplinkId + ev.tick, EFFECT_MS.uplinkSplash) }
        if (k.value.by === selfId) {
          audio.play('uplinkSuccess')
          this.completed.set(k.value.uplinkId, ev.tick)
          this.message(`黑入完成 · +${k.value.value} 分 · 本桩冷却 30s`, 'uplink')
        } else {
          if (p) this.sound('uplinkSuccess', p, world)
          this.message(`${this.nickOf(k.value.by, world)} 黑入完成 · +${k.value.value} 分`, 'uplink')
        }
        break
      }
      case 'kill':
        if (k.value.at) { this.fx.add('death', k.value.at, red, k.value.victim, EFFECT_MS.death); this.sound('death', k.value.at, world, 1, k.value.victim === selfId) }
        if (k.value.victim === selfId) this.camFeel.jolt(ev.tick, ev.tick + k.value.killer * 3 + k.value.victim * 7)
        this.message(`${this.nickOf(k.value.killer, world)} 击毁 ${this.nickOf(k.value.victim, world)}`, 'kill',
          { id: k.value.killer, name: this.nickOf(k.value.killer, world) })
        break
      case 'respawn':
        if (k.value.robot === selfId) { this.camFeel.calm(); this.vitals.clearSelfHit(); audio.play('respawn'); this.message('机体已重生') }
        break
      case 'matchStart': audio.play('matchStart'); break
      case 'matchEnd': audio.stopGame(); audio.play('matchEnd'); break
      case 'phaseChange':
        if (opening) {
          if (this.baseline) this.openInnerRing()
          else this.innerOpened = true
        } else { audio.play('phase'); this.message('阶段切换') }
        break
    }
  }

  input(input: ClientInput, world: WorldState, map: MapDefParsed): void {
    const self = world.robots.get(world.self?.robotId ?? 0)
    if (!self || self.dead) return
    let reason = ''
    if (input.dash && self.energyX10 < 4) {
      reason = '能量不足，冲刺停止'
    } else if (input.fire && !this.held.fire) {
      if (self.shieldOn || input.shield) reason = '护盾期间无法开火'
      else if (self.energyX10 < 50) reason = '开火需要 5 能量'
    } else if (input.shield && !this.held.shield && self.energyX10 < 3) {
      reason = '能量不足，护盾无法维持'
    } else if (input.interact && !this.held.interact) {
      const pos = self.base?.pos
      const def = pos && map.uplinks.find(u => Math.hypot(pos.x - u.pos.x, pos.y - u.pos.y) <= u.interactR)
      const u = def && world.uplinks.get(def.id)
      if (!def) reason = '靠近 Uplink 后按住 E / F'
      else if (world.phase < def.activePhase || def.main && world.phase < 2) reason = '该 Uplink 尚未开放'
      else if (u?.myCooldownS) reason = `本桩冷却 ${u.myCooldownS}s`
      else if (u?.hackingId && u.hackingId !== world.self?.robotId) reason = '其他机器人正在黑入'
      else if (input.fire) reason = '停止开火后才能黑入'
    }
    this.held = { fire: input.fire, shield: input.shield, interact: input.interact }
    if (reason && performance.now() - this.lastDenied > DENY_THROTTLE_MS) {
      this.lastDenied = performance.now(); this.message(reason); audio.play('deny')
    }
  }

  cameraShake(tick: number): { x: number; y: number } {
    return this.camFeel.shakeAt(tick)
  }

  cameraZoom(tick: number, dashing: boolean, hacking = false): number {
    return this.camFeel.zoomAt(tick, dashing, hacking)
  }

  uplinkLift(progress: number): number {
    if (this.reduced.matches || progress <= 0) return 0
    return Math.min(1, progress)
  }

  delayedHealth(robot: number, actualX10: number, now = performance.now()): number {
    return this.vitals.delayedHealth(robot, actualX10, now)
  }

  drawTrails(ctx: CanvasRenderingContext2D, cam: Camera, tick: number): void {
    this.trails.draw(ctx, cam, tick)
  }

  /** 静默判定（纯查询，不改状态）：无存活特效/飘字/低血呼吸帧/排空中的白条/
   *  可见拖尾/持续震屏，且相机变焦已收敛。controls 据此在空闲期跳帧（C-26 收尾）。 */
  quiet(tick: number, now = performance.now()): boolean {
    return !this.fx.busy(now) && !this.vitals.busy(now) && !this.trails.visible(tick)
      && !this.camFeel.shaking(tick) && this.camFeel.settled
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
    ctx.save()
    this.fx.draw(ctx, cam)
    this.vitals.draw(ctx, cam)
    ctx.restore()
  }

  private nickOf(id: number, world: WorldState): string {
    return world.robots.get(id)?.nick || `robot-${id}`
  }

  private openInnerRing(): void {
    if (this.innerOpened) return
    this.innerOpened = true
    audio.play('innerOpen')
    if (this.onInnerRing) this.onInnerRing()
    else this.message('核心区已开放')
  }

  private countdown(world: WorldState, transitions: boolean): void {
    if (!world.initialized || !Number.isFinite(world.timeLeftS)) return
    const seconds = Math.max(0, Math.floor(world.timeLeftS)), previous = this.seconds
    this.seconds = seconds
    if (!transitions) {
      if (seconds <= 30) this.countdownWarned = true
      if (seconds >= 1 && seconds <= 10) this.countdownTicks.add(seconds)
      return
    }
    if (previous === undefined || seconds >= previous) return
    const warning = previous > 30 && seconds <= 30 && !this.countdownWarned
    const tick = seconds >= 1 && seconds <= 10 && !this.countdownTicks.has(seconds)
    if (warning) { this.countdownWarned = true; audio.play('countdownWarning') }
    if (tick) {
      this.countdownTicks.add(seconds)
      // A large jump gets one cue at the received second, never a burst of missed ticks.
      if (!warning) audio.play('countdownTick')
    }
    if (warning || tick) this.onCountdown?.(seconds)
  }

  private sound(cue: SoundCue, pos: MapVec2, world: WorldState, intensity = 1, priority = false, pitch = 1): void {
    const self = world.robots.get(world.self?.robotId ?? 0)?.base?.pos
    if (!self) return
    const distance = Math.hypot(pos.x - self.x, pos.y - self.y)
    if (distance > SOUND_RANGE) return
    const gain = intensity * Math.max(0, 1 - distance / SOUND_RANGE)
    const pan = Math.max(-SOUND_PAN_LIMIT, Math.min(SOUND_PAN_LIMIT, (pos.x - self.x) / SOUND_PAN_DIVISOR))
    if (pitch !== 1) audio.play(cue, gain, pan, priority, pitch)
    else if (priority || cue === 'corePickup' || cue === 'uplinkSuccess') audio.play(cue, gain, pan, priority)
    else audio.play(cue, gain, pan)
  }
}

/** C-26 收尾（controls 空闲跳帧门）：指针瞄准预览、say 气泡与 feedback 时间
 *  动效（特效/飘字/低血帧/白条排空/拖尾/震屏/变焦收敛）任一在场时画面仍需
 *  逐帧重绘；全静默才允许跳帧——脏标记（快照/resize/DPR 漂移）路径不受影响，
 *  静默被打破后的下一帧立即恢复重绘。 */
export function canvasAwake(feedback: GameFeedback, tick: number, live: { aimPreview: boolean; bubbles: number }, now = performance.now()): boolean {
  return live.aimPreview || live.bubbles > 0 || !feedback.quiet(tick, now)
}
