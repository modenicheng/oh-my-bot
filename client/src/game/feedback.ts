import type { ClientInput, ServerEvent, SnapshotDelta } from '@omb/protocol'
import { audio, type SoundCue } from '../audio'
import type { Camera } from './camera'
import { type MapDefParsed, type MapUplink, type MapVec2 } from './mapdef'
import { hackMaxX10 } from './tuning'
import type { WorldState } from './world'

const tau = Math.PI * 2
const CAMERA_SHAKE_TICKS = 16
const DAMAGE_HOLD_MS = 420
const DAMAGE_FADE_MS = 620
const DAMAGE_POPUP_MS = 850
const HIT_CHAIN_MS = 520
const HIT_CHAIN_MAX = 6
const HIT_CHAIN_PITCH_STEP = 0.07
const ZOOM_DASH_TARGET = 0.92
const ZOOM_DASH_BLEND = 0.64
const ZOOM_NORMAL_BLEND = 0.78
const TRAIL_TICKS = 15
const LOW_HEALTH_X10 = 250
const CAMERA_SHAKE_DIRECTIONS = [[1, 1], [-1, 1], [-1, -1], [1, -1]] as const
const white = '#f4fbff', cyan = '#22d3ee', green = '#b9d985', red = '#ff756d'
export type FeedbackKind = 'status' | 'kill' | 'uplink'
type EffectKind = 'shot' | 'impact' | 'spawn' | 'pickup' | 'heal' | 'uplink' | 'splash' | 'dash' | 'death'
interface Effect { kind: EffectKind; pos: MapVec2; at: number; duration: number; color: string; seed: number; heading: number }
interface HealthVisual { actualX10: number; delayedX10: number; holdUntil: number; updatedAt: number }
interface DamagePopup { robot: number; pos: MapVec2; amountX10: number; at: number; seed: number }
interface TrailPoint { pos: MapVec2; tick: number; color: string }

/** Transient presentation follows confirmed events/state transitions; resyncs establish a quiet baseline. */
export class GameFeedback {
  private effects: Effect[] = []
  private seen = new Set<string>()
  private robots = new Map<number, { shield: boolean; dash: boolean; dead: boolean; hpX10: number }>()
  private health = new Map<number, HealthVisual>()
  private damage: DamagePopup[] = []
  private trails = new Map<number, TrailPoint[]>()
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
  private shake: { tick: number; seed: number } | undefined
  private selfLow = false
  private lowHitAt = -Infinity
  private dashZoom = { value: 1, tick: 0 }
  /** cameraZoom 每 tick 只推进一步（C-4）：记录已缓存的 tick，undefined 表示尚未推进过。 */
  private zoomAtTick: number | undefined
  private hitChain = { at: -Infinity, count: 0 }
  private reduced = matchMedia('(prefers-reduced-motion: reduce)')

  constructor(
    private message: (text: string, kind?: FeedbackKind) => void,
    private onInnerRing?: () => void,
    private onCountdown?: (seconds: number) => void,
  ) {}

  reset(): void {
    this.effects = []; this.seen.clear(); this.robots.clear(); this.health.clear(); this.damage = []; this.trails.clear(); this.cores.clear()
    this.hackers.clear(); this.completed.clear(); this.near = 0; this.baseline = false; this.lastDenied = -Infinity
    this.quietThroughTick = -1; this.phase = undefined; this.innerOpened = false
    this.seconds = undefined; this.countdownWarned = false; this.countdownTicks.clear()
    this.held = { fire: false, shield: false, interact: false }; this.shake = undefined
    this.selfLow = false; this.lowHitAt = -Infinity; this.dashZoom = { value: 1, tick: 0 }; this.hitChain = { at: -Infinity, count: 0 }; this.zoomAtTick = undefined
    audio.stopGame()
  }

  pause(): void { this.effects = []; this.damage = []; this.trails.clear(); this.near = 0; this.baseline = false; this.shake = undefined; audio.stopGame() }

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
      let visual = this.health.get(id)
      if (!visual || !transitions || !prev) {
        visual = { actualX10: r.hpX10, delayedX10: r.hpX10, holdUntil: now, updatedAt: now }
      } else if (r.hpX10 < prev.hpX10) {
        visual.delayedX10 = Math.max(this.delayedHpAt(visual, now), prev.hpX10)
        visual.actualX10 = r.hpX10
        visual.holdUntil = now + DAMAGE_HOLD_MS
        visual.updatedAt = now
        if (pos) {
          if (this.damage.length >= 48) this.damage.shift()
          this.damage.push({ robot: id, pos: { x: pos.x, y: pos.y }, amountX10: prev.hpX10 - r.hpX10, at: now, seed: id * 31 + snap.tick })
        }
        if (id === selfId && r.hpX10 <= LOW_HEALTH_X10) this.lowHitAt = now
      } else if (r.hpX10 > prev.hpX10) {
        visual.actualX10 = r.hpX10; visual.delayedX10 = r.hpX10; visual.holdUntil = now; visual.updatedAt = now
      } else {
        visual.actualX10 = r.hpX10
      }
      this.health.set(id, visual)
      if (transitions && prev && pos) {
        if (r.dashing && !prev.dash) { this.add('dash', pos, cyan, id, 320, r.base?.heading); this.sound('dash', pos, world, 1, id === selfId) }
        if (r.shieldOn !== prev.shield) this.sound(r.shieldOn ? 'shieldOn' : 'shieldOff', pos, world, 1, id === selfId)
      }
      if (transitions && r.dashing && pos) {
        const trail = this.trails.get(id) ?? []
        const last = trail[trail.length - 1]
        if (!last || last.tick !== snap.tick) trail.push({ pos: { x: pos.x, y: pos.y }, tick: snap.tick, color: r.color || cyan })
        while (trail.length && trail[0]!.tick < snap.tick - TRAIL_TICKS) trail.shift()
        this.trails.set(id, trail)
      } else if (!transitions) this.trails.delete(id)
      this.robots.set(id, { shield: r.shieldOn, dash: r.dashing, dead: r.dead, hpX10: r.hpX10 })
    }
    this.selfLow = !!selfId && !!world.robots.get(selfId) && !world.robots.get(selfId)!.dead && world.robots.get(selfId)!.hpX10 <= LOW_HEALTH_X10
    for (const id of this.robots.keys()) if (!world.robots.has(id)) { this.robots.delete(id); this.health.delete(id); this.trails.delete(id) }
    for (const [id, core] of world.cores) {
      if (transitions && !this.cores.has(id) && core.base?.pos) {
        this.add('spawn', core.base.pos, cyan, id, 850)
        this.sound('coreSpawn', core.base.pos, world)
      }
    }
    this.cores = new Set(world.cores.keys())
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
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!)
    if (document.hidden) { this.baseline = false; if (opening) this.innerOpened = true; return }
    if (ev.tick <= this.quietThroughTick && k.case !== 'matchStart' && k.case !== 'matchEnd') return
    const selfId = world.self?.robotId
    switch (k.case) {
      case 'shot':
        if (!world.robots.has(k.value.owner)) break
        if (k.value.at) { this.add('shot', k.value.at, k.value.color || world.robots.get(k.value.owner)?.color || white, k.value.projectile, 110, k.value.heading); this.sound('shot', k.value.at, world, 1, k.value.owner === selfId) }
        break
      case 'projectileImpact':
        if (!k.value.at || !this.visibleImpact(k.value.at, world, map, k.value.projectile)) break
        if (k.value.at) {
          this.add('impact', k.value.at, k.value.shield || k.value.invulnerable ? white : k.value.target ? red : k.value.color || world.projectiles.get(k.value.projectile)?.color || world.robots.get(k.value.owner)?.color || cyan, k.value.projectile, 330)
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
        if (k.value.at && k.value.impact >= 1.5) {
          this.add('impact', k.value.at, '#9bafbd', k.value.robot, 220)
          this.sound('wallHit', k.value.at, world, Math.min(1, k.value.impact / 8))
        }
        break
      case 'corePickup': {
        const own = k.value.by === selfId
        const p = world.cores.get(k.value.coreId)?.base?.pos ?? map.corePads.find(p => p.id === k.value.coreId)?.pos
          ?? world.robots.get(k.value.by)?.base?.pos
        if (p) this.add('pickup', p, green, k.value.coreId, 600)
        // A delta can remove the core before its pickup event, including all position data for self.
        if (own) { audio.play('corePickup'); this.message(`拾取 Core · +${k.value.value} 分`) }
        else if (p) this.sound('corePickup', p, world)
        break
      }
      case 'heal': {
        const own = k.value.by === selfId
        const p = k.value.at ?? map.healthPacks.find(pack => pack.id === k.value.id)?.pos
          ?? world.robots.get(k.value.by)?.base?.pos
        if (p) this.add('heal', p, green, k.value.id, 720)
        if (own) {
          audio.play('healthPickup')
          this.message(`生命回灌 · +${(k.value.healX10 / 10).toFixed(k.value.healX10 % 10 ? 1 : 0)} HP`, 'status')
        } else if (p) this.sound('healthPickup', p, world)
        break
      }
      case 'uplinkHack': {
        const p = map.uplinks.find(u => u.id === k.value.uplinkId)?.pos
        if (p) { this.add('uplink', p, green, k.value.uplinkId, 1000); this.add('splash', p, cyan, k.value.uplinkId + ev.tick, 520) }
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
        if (k.value.at) { this.add('death', k.value.at, red, k.value.victim, 650); this.sound('death', k.value.at, world, 1, k.value.victim === selfId) }
        if (k.value.victim === selfId) this.shake = { tick: ev.tick, seed: ev.tick + k.value.killer * 3 + k.value.victim * 7 }
        this.message(`${this.nickOf(k.value.killer, world)} 击毁 ${this.nickOf(k.value.victim, world)}`, 'kill')
        break
      case 'respawn':
        if (k.value.robot === selfId) { this.shake = undefined; this.lowHitAt = -Infinity; audio.play('respawn'); this.message('机体已重生') }
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
    if (reason && performance.now() - this.lastDenied > 700) {
      this.lastDenied = performance.now(); this.message(reason); audio.play('deny')
    }
  }

  cameraShake(tick: number): { x: number; y: number } {
    if (this.reduced.matches) return { x: 0, y: 0 }
    let x = 0, y = 0
    const shake = this.shake
    if (shake) {
      const age = Math.max(0, tick - shake.tick)
      if (age >= CAMERA_SHAKE_TICKS) this.shake = undefined
      else {
        const decay = 1 - age / CAMERA_SHAKE_TICKS
        const direction = CAMERA_SHAKE_DIRECTIONS[Math.abs(shake.seed + age) % CAMERA_SHAKE_DIRECTIONS.length]!
        x += Math.round(direction[0] * 8 * decay); y += Math.round(direction[1] * 6 * decay)
      }
    }
    return { x, y }
  }

  cameraZoom(tick: number, dashing: boolean): number {
    if (this.reduced.matches) return 1
    // rAF drawFrame 与 60Hz sampleAndSend 同 tick 各调一次（C-4）：同 tick 返回
    // 缓存，每 tick 只推进一步，收敛速度不随刷新率变化（此前 144Hz≈204 步/s）。
    if (this.zoomAtTick === tick) return this.dashZoom.value
    const elapsed = Math.max(1, Math.min(6, tick - this.dashZoom.tick || 1))
    const target = dashing ? ZOOM_DASH_TARGET : 1
    const blend = 1 - Math.pow(dashing ? ZOOM_DASH_BLEND : ZOOM_NORMAL_BLEND, elapsed)
    this.dashZoom.value += (target - this.dashZoom.value) * blend
    this.dashZoom.tick = tick
    this.zoomAtTick = tick
    return this.dashZoom.value
  }

  uplinkLift(progress: number): number {
    if (this.reduced.matches || progress <= 0) return 0
    return Math.min(1, progress)
  }

  delayedHealth(robot: number, actualX10: number): number {
    const visual = this.health.get(robot)
    if (!visual) return actualX10 / 10
    const delayed = this.delayedHpAt(visual, performance.now())
    visual.delayedX10 = delayed
    return Math.max(actualX10, delayed) / 10
  }

  drawTrails(ctx: CanvasRenderingContext2D, cam: Camera, tick: number): void {
    if (this.reduced.matches) return
    ctx.save()
    for (const trail of this.trails.values()) {
      for (let i = 0; i < trail.length; i++) {
        const point = trail[i]!, age = Math.max(0, tick - point.tick)
        if (age > TRAIL_TICKS) continue
        const x = cam.toPxX(point.pos.x), y = cam.toPxY(point.pos.y)
        const alpha = (1 - age / TRAIL_TICKS) * (i + 1) / trail.length * 0.42
        const size = Math.max(4, cam.scale * 0.42 * (1 - age / (TRAIL_TICKS * 1.4)))
        ctx.globalAlpha = alpha; ctx.strokeStyle = point.color; ctx.lineWidth = 1
        ctx.strokeRect(Math.round(x - size), Math.round(y - size), Math.round(size * 2), Math.round(size * 2))
      }
    }
    ctx.restore()
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
    const now = performance.now()
    // 原地压缩过期特效，避免每帧 filter 分配。
    let kept = 0
    for (let i = 0; i < this.effects.length; i++) {
      const e = this.effects[i]!
      if (now - e.at < e.duration) this.effects[kept++] = e
    }
    this.effects.length = kept
    let damageKept = 0
    for (let i = 0; i < this.damage.length; i++) {
      const popup = this.damage[i]!
      if (now - popup.at < DAMAGE_POPUP_MS) this.damage[damageKept++] = popup
    }
    this.damage.length = damageKept
    ctx.save()
    for (const e of this.effects) {
      const x = cam.toPxX(e.pos.x), y = cam.toPxY(e.pos.y)
      if (x < -100 || y < -100 || x > cam.cw + 100 || y > cam.ch + 100) continue
      const t = (now - e.at) / e.duration, motion = this.reduced.matches ? 0.3 : t
      ctx.globalAlpha = (1 - t) * 0.95; ctx.strokeStyle = e.color; ctx.fillStyle = e.color
      ctx.lineWidth = e.kind === 'uplink' ? 3 : 2
      if (e.kind === 'shot') {
        ctx.save(); ctx.translate(x, y); ctx.rotate(e.heading)
        const muzzle = cam.scale * 0.65
        ctx.fillRect(muzzle, -3, 12 * (1 - motion) + 4, 6); ctx.restore()
      } else if (e.kind === 'impact' || e.kind === 'death') {
        const count = this.reduced.matches ? 3 : e.kind === 'death' ? 14 : 7
        for (let i = 0; i < count; i++) {
          const a = (i / count + (e.seed % 19) / 19) * tau
          const d = (3 + motion * (e.kind === 'death' ? 2 : 0.8) * cam.scale)
          const px = Math.round(x + Math.cos(a) * d), py = Math.round(y + Math.sin(a) * d)
          ctx.fillRect(px - 2, py - 2, 4, 4)
        }
      } else if (e.kind === 'splash') {
        const count = this.reduced.matches ? 4 : 10
        ctx.globalAlpha = (1 - t) * 0.85; ctx.fillStyle = cyan
        for (let i = 0; i < count; i++) {
          const a = -Math.PI * 0.92 + i / Math.max(1, count - 1) * Math.PI * 0.84
          const d = (0.35 + motion * (0.7 + i % 3 * 0.16)) * cam.scale
          const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d + motion * motion * cam.scale * 0.5
          ctx.fillRect(Math.round(px) - 2, Math.round(py) - 2, 4, 4)
        }
        ctx.strokeStyle = '#a5e6ef'; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(x, y + 3, motion * cam.scale * 1.5, motion * cam.scale * 0.42, 0, 0, tau); ctx.stroke()
      } else {
        const radius = (e.kind === 'uplink' ? 1.5 : 0.4) * cam.scale + motion * cam.scale * 1.4
        ctx.beginPath(); ctx.arc(x, y, radius, 0, tau); ctx.stroke()
        if (e.kind === 'spawn' || e.kind === 'pickup' || e.kind === 'heal') {
          for (let i = 0; i < 4; i++) {
            const a = i * tau / 4
            ctx.fillRect(Math.round(x + Math.cos(a) * radius) - 3, Math.round(y + Math.sin(a) * radius) - 3, 6, 6)
          }
        }
      }
    }
    ctx.globalAlpha = 1
    ctx.font = '14px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    for (const popup of this.damage) {
      const t = Math.min(1, (now - popup.at) / DAMAGE_POPUP_MS)
      const drift = this.reduced.matches ? 0 : (10 + (popup.seed % 5)) * t
      const x = cam.toPxX(popup.pos.x) + ((popup.seed % 7) - 3)
      const y = cam.toPxY(popup.pos.y) - 20 - drift
      const text = `-${(popup.amountX10 / 10).toFixed(popup.amountX10 % 10 ? 1 : 0)}`
      ctx.globalAlpha = t < 0.7 ? 1 : (1 - t) / 0.3
      ctx.fillStyle = '#071019'; ctx.fillText(text, x + 1, y + 1)
      ctx.fillStyle = red; ctx.fillText(text, x, y)
    }
    if (this.selfLow) {
      const flash = this.reduced.matches ? 0 : Math.max(0, 1 - (now - this.lowHitAt) / 240)
      const pulse = this.reduced.matches ? 0.64 : 0.64 + Math.sin(now / 650) * 0.06
      const alpha = Math.min(0.9, pulse + flash * 0.24)
      const cell = 8, layers = Math.min(5, Math.floor(Math.min(cam.cw, cam.ch) / (cell * 5)))
      ctx.fillStyle = red
      // Spatial noise stays stable between frames: irregular damage, not strobing static.
      for (let side = 0; side < 4; side++) {
        const length = side < 2 ? cam.cw : cam.ch
        for (let row = 0; row < layers; row++) {
          for (let along = 0; along < length; along += cell) {
            let hash = Math.imul((along / cell + 1) ^ ((row + 1) * 193) ^ ((side + 1) * 941), 0x45d9f3b)
            hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) >>> 0
            const random = (hash % 997) / 997
            if (row > 0 && random > 1 - row * 0.19) continue
            const size = Math.min(cell, length - along)
            const depth = row * cell
            ctx.globalAlpha = alpha * (0.8 + (hash % 17) / 85) * (1 - row * 0.13)
            if (side === 0) ctx.fillRect(along, depth, size, cell)
            else if (side === 1) ctx.fillRect(along, cam.ch - depth - cell, size, cell)
            else if (side === 2) ctx.fillRect(depth, along, cell, size)
            else ctx.fillRect(cam.cw - depth - cell, along, cell, size)
          }
        }
      }
    }
    ctx.restore()
  }

  private delayedHpAt(visual: HealthVisual, now: number): number {
    if (now <= visual.holdUntil) return visual.delayedX10
    const elapsed = now - visual.holdUntil
    if (elapsed >= DAMAGE_FADE_MS) return visual.actualX10
    return visual.actualX10 + (visual.delayedX10 - visual.actualX10) * (1 - elapsed / DAMAGE_FADE_MS)
  }

  private add(kind: EffectKind, pos: MapVec2, color: string, seed: number, duration: number, heading = 0): void {
    if (this.effects.length >= 160) this.effects.shift()
    this.effects.push({ kind, pos: { x: pos.x, y: pos.y }, at: performance.now(), duration, color, seed, heading })
  }

  // 事件为全房间广播；颜色元数据不能使视野外或掩体后的撞击凭空可见。
  private visibleImpact(at: MapVec2, world: WorldState, map: MapDefParsed, projectileId: number): boolean {
    const self = world.robots.get(world.self?.robotId ?? 0)?.base?.pos
    if (!self) return false
    const dx = at.x - self.x, dy = at.y - self.y, distance = Math.hypot(dx, dy)
    const knownProjectile = world.projectiles.get(projectileId)
    if (distance > 32 || (distance > 20 && !knownProjectile)) return false
    // 截短末端：撞击墙体近表面本身不应成为遮挡。
    const end = Math.max(0, 1 - 0.03 / Math.max(distance, 0.03))
    for (const wall of map.walls) {
      // 标量化两轴 slab 测试，语义与原数组解构版一致（平行且在外 → 不遮挡该墙）。
      let enter = 0, exit = end
      let parallelOutside = false
      if (dx > -1e-8 && dx < 1e-8) {
        if (self.x < wall.min.x || self.x > wall.max.x) parallelOutside = true
      } else {
        const a = (wall.min.x - self.x) / dx, b = (wall.max.x - self.x) / dx
        enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b))
      }
      if (!parallelOutside) {
        if (dy > -1e-8 && dy < 1e-8) {
          if (self.y < wall.min.y || self.y > wall.max.y) parallelOutside = true
        } else {
          const a = (wall.min.y - self.y) / dy, b = (wall.max.y - self.y) / dy
          enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b))
        }
        if (enter <= exit) return false
      }
    }
    return true
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
    if (distance > 24) return
    const gain = intensity * Math.max(0, 1 - distance / 24), pan = Math.max(-0.8, Math.min(0.8, (pos.x - self.x) / 20))
    if (pitch !== 1) audio.play(cue, gain, pan, priority, pitch)
    else if (priority || cue === 'corePickup' || cue === 'uplinkSuccess') audio.play(cue, gain, pan, priority)
    else audio.play(cue, gain, pan)
  }
}
