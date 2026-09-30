import type { ClientInput, ServerEvent, SnapshotDelta } from '@omb/protocol'
import { audio, type SoundCue } from '../audio'
import type { Camera } from './camera'
import type { MapDefParsed, MapVec2 } from './mapdef'
import type { WorldState } from './world'

const tau = Math.PI * 2
const white = '#f4fbff', cyan = '#22d3ee', green = '#b9d985', red = '#ff756d'
export type FeedbackKind = 'status' | 'kill' | 'uplink'
type EffectKind = 'shot' | 'impact' | 'spawn' | 'pickup' | 'uplink' | 'dash' | 'death'
interface Effect { kind: EffectKind; pos: MapVec2; at: number; duration: number; color: string; seed: number; heading: number }

/** Transient presentation follows confirmed events/state transitions; resyncs establish a quiet baseline. */
export class GameFeedback {
  private effects: Effect[] = []
  private seen = new Set<string>()
  private robots = new Map<number, { shield: boolean; dash: boolean; dead: boolean }>()
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
  private reduced = matchMedia('(prefers-reduced-motion: reduce)')

  constructor(
    private message: (text: string, kind?: FeedbackKind) => void,
    private onInnerRing?: () => void,
    private onCountdown?: (seconds: number) => void,
  ) {}

  reset(): void {
    this.effects = []; this.seen.clear(); this.robots.clear(); this.cores.clear()
    this.hackers.clear(); this.completed.clear(); this.near = 0; this.baseline = false; this.lastDenied = -Infinity
    this.quietThroughTick = -1; this.phase = undefined; this.innerOpened = false
    this.seconds = undefined; this.countdownWarned = false; this.countdownTicks.clear()
    this.held = { fire: false, shield: false, interact: false }
    audio.stopGame()
  }

  pause(): void { this.effects = []; this.near = 0; this.baseline = false; audio.stopGame() }

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
    for (const [id, r] of world.robots) {
      const prev = this.robots.get(id), pos = r.base?.pos
      if (transitions && prev && pos) {
        if (r.dashing && !prev.dash) { this.add('dash', pos, cyan, id, 320, r.base?.heading); this.sound('dash', pos, world, 1, id === selfId) }
        if (r.shieldOn !== prev.shield) this.sound(r.shieldOn ? 'shieldOn' : 'shieldOff', pos, world, 1, id === selfId)
      }
      this.robots.set(id, { shield: r.shieldOn, dash: r.dashing, dead: r.dead })
    }
    for (const id of this.robots.keys()) if (!world.robots.has(id)) this.robots.delete(id)
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
    const nearest = map.uplinks.filter(u => world.phase >= u.activePhase && (!u.main || world.phase >= 2) && Math.hypot(pos.x - u.pos.x, pos.y - u.pos.y) <= u.interactR)
      .sort((a, b) => Math.hypot(pos.x - a.pos.x, pos.y - a.pos.y) - Math.hypot(pos.x - b.pos.x, pos.y - b.pos.y))[0]
    const id = nearest?.id ?? 0
    if (id && id !== this.near && transitions) {
      audio.play('uplinkEnter')
      const state = world.uplinks.get(id)
      this.message(state?.myCooldownS ? `Uplink 冷却 ${state.myCooldownS}s` : '已接入 Uplink · 按住 E / F 黑入', 'uplink')
    }
    this.near = id
    const u = world.uplinks.get(id)
    audio.setUplink(!id ? 'off' : u?.hackingId === world.self?.robotId ? 'hacking' : 'near', (u?.progressX10 ?? 0) / 80)
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
        if (k.value.at) { this.add('shot', k.value.at, white, k.value.projectile, 110, k.value.heading); this.sound('shot', k.value.at, world, 1, k.value.owner === selfId) }
        break
      case 'projectileImpact':
        if (!world.robots.has(k.value.owner) && !world.robots.has(k.value.target)) break
        if (k.value.at) {
          this.add('impact', k.value.at, k.value.shield || k.value.invulnerable ? white : k.value.target ? red : cyan, k.value.projectile, 330)
          this.sound(k.value.shield || k.value.invulnerable ? 'shieldHit' : 'hit', k.value.at, world, 1, k.value.target === selfId)
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
      case 'uplinkHack': {
        const p = map.uplinks.find(u => u.id === k.value.uplinkId)?.pos
        if (p) this.add('uplink', p, green, k.value.uplinkId, 1000)
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
        this.message(`${this.nickOf(k.value.killer, world)} 击毁 ${this.nickOf(k.value.victim, world)}`, 'kill')
        break
      case 'respawn':
        if (k.value.robot === selfId) { audio.play('respawn'); this.message('机体已重生') }
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
    if (input.dash) {
      if ((world.self?.dashReadyTick ?? 0) > world.tick) reason = '冲刺冷却中'
      else if (self.energyX10 < 200) reason = '冲刺需要 20 能量'
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

  draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
    const now = performance.now()
    this.effects = this.effects.filter(e => now - e.at < e.duration)
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
      } else {
        const radius = (e.kind === 'uplink' ? 1.5 : 0.4) * cam.scale + motion * cam.scale * 1.4
        ctx.beginPath(); ctx.arc(x, y, radius, 0, tau); ctx.stroke()
        if (e.kind === 'spawn' || e.kind === 'pickup') {
          for (let i = 0; i < 4; i++) {
            const a = i * tau / 4
            ctx.fillRect(Math.round(x + Math.cos(a) * radius) - 3, Math.round(y + Math.sin(a) * radius) - 3, 6, 6)
          }
        }
      }
    }
    ctx.restore()
  }

  private add(kind: EffectKind, pos: MapVec2, color: string, seed: number, duration: number, heading = 0): void {
    if (this.effects.length >= 160) this.effects.shift()
    this.effects.push({ kind, pos: { x: pos.x, y: pos.y }, at: performance.now(), duration, color, seed, heading })
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

  private sound(cue: SoundCue, pos: MapVec2, world: WorldState, intensity = 1, priority = false): void {
    const self = world.robots.get(world.self?.robotId ?? 0)?.base?.pos
    if (!self) return
    const distance = Math.hypot(pos.x - self.x, pos.y - self.y)
    if (distance > 24) return
    const gain = intensity * Math.max(0, 1 - distance / 24), pan = Math.max(-0.8, Math.min(0.8, (pos.x - self.x) / 20))
    if (priority || cue === 'corePickup' || cue === 'uplinkSuccess') audio.play(cue, gain, pan, priority)
    else audio.play(cue, gain, pan)
  }
}
