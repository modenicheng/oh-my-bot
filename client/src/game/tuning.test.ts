// 对局数值消费（审计 X-3）：兜底值与服务器 sim 常量的黄金字节互钉、
// resolveTuning 的旧服务器回退、world/HUD 派生量（无敌窗口/黑入满值）换算。
import { describe, expect, it, vi } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { SimTuningSchema } from '@omb/protocol'
import { FALLBACK_TUNING, FALLBACK_TUNING_HEX, invulnWindowMs, hackMaxX10, resolveTuning } from './tuning'
import { emptyWorld, applySnapshot } from './world'
import { SnapshotDeltaSchema, RobotStateSchema, EntityBaseSchema } from '@omb/protocol'

// 与 server/internal/glue/simtuning_notice_test.go TestSimTuningGoldenBytes 同一 hex
// （即 server sim.TickRate=60 / MaxHP=MaxEnergy=100 / FireCost=5 / HackDuration=480 /
//  InvulnDuration=240 / VisionRadius=20 的编码）。两侧任一改值即失败。
const SERVER_GOLDEN = '083c10d00f18d00f21000000000000144028e00330f001390000000000003440'

describe('SimTuning 兜底值（X-3）', () => {
  it('FALLBACK_TUNING 黄金字节与 Go 侧 simTuning() 一致', () => {
    expect(FALLBACK_TUNING_HEX).toBe(SERVER_GOLDEN)
  })

  it('兜底值 = 当前服务器常量快照（60/1000/1000/5/480/240/20）', () => {
    expect(FALLBACK_TUNING.tickRate).toBe(60)
    expect(FALLBACK_TUNING.maxHpX10).toBe(1000)
    expect(FALLBACK_TUNING.maxEnergyX10).toBe(1000)
    expect(FALLBACK_TUNING.fireCost).toBe(5)
    expect(FALLBACK_TUNING.hackDurationTicks).toBe(480)
    expect(FALLBACK_TUNING.invulnDurationTicks).toBe(240)
    expect(FALLBACK_TUNING.visionRadius).toBe(20)
  })
})

describe('resolveTuning 旧服务器回退（X-3）', () => {
  it('undefined（旧服务器不下发）→ 兜底值', () => {
    expect(resolveTuning(undefined)).toEqual(FALLBACK_TUNING)
  })

  it('零值字段（proto3 缺省）逐字段回退兜底', () => {
    const partial = resolveTuning(create(SimTuningSchema, { tickRate: 30 }))
    expect(partial.tickRate).toBe(30)
    expect(partial.maxHpX10).toBe(FALLBACK_TUNING.maxHpX10)
    expect(partial.hackDurationTicks).toBe(FALLBACK_TUNING.hackDurationTicks)
    expect(partial.visionRadius).toBe(FALLBACK_TUNING.visionRadius)
  })

  it('完整下发值原样通过', () => {
    const wire = create(SimTuningSchema, {
      tickRate: 60, maxHpX10: 800, maxEnergyX10: 1200, fireCost: 8,
      hackDurationTicks: 300, invulnDurationTicks: 120, visionRadius: 25,
    })
    expect(resolveTuning(wire)).toEqual(wire)
  })
})

describe('派生量换算（X-3）', () => {
  it('无敌窗口 = invuln ticks / tick_rate + 250ms 快照容差', () => {
    expect(invulnWindowMs(FALLBACK_TUNING)).toBe(4250) // 240/60*1000+250，历史硬编码值
    expect(invulnWindowMs(resolveTuning(create(SimTuningSchema, { tickRate: 60, invulnDurationTicks: 120, maxHpX10: 1000, maxEnergyX10: 1000, fireCost: 5, hackDurationTicks: 480, visionRadius: 20 })))).toBe(2250)
  })

  it('黑入满值 = hack ticks ×10 / tick_rate（对应 HACK_MAX_X10=80）', () => {
    expect(hackMaxX10(FALLBACK_TUNING)).toBe(80)
  })
})

describe('world 消费 tuning（X-3）', () => {
  it('emptyWorld 携带兜底 tuning；旧服务器缺失 invuln_s 时用 dead→alive 推导窗口', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const world = emptyWorld()
    expect(world.tuning).toBe(FALLBACK_TUNING)
    const full = create(SnapshotDeltaSchema, {
      tick: 1, full: true, phase: 1,
      robots: [create(RobotStateSchema, { base: create(EntityBaseSchema, { id: 7 }), hpX10: 500, dead: true })],
    })
    applySnapshot(world, full)
    const revived = create(SnapshotDeltaSchema, {
      tick: 200, baseTick: 1, phase: 1,
      robots: [create(RobotStateSchema, { base: create(EntityBaseSchema, { id: 7 }), hpX10: 1000, dead: false })],
    })
    expect(applySnapshot(world, revived)).toBe('applied')
    // dead→alive：无敌近似 = performance.now() + 4250（兜底 tuning）
    const ent = world.robots.get(7)!
    expect(ent.invulnUntil! - performance.now()).toBeCloseTo(4250, -1)
    vi.useRealTimers()
  })

  it('权威 invuln_s 在 full/resync 中恢复绿色护盾并以 optional 0 明确关闭', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
    try {
      const world = emptyWorld()
      const full = create(SnapshotDeltaSchema, {
        tick: 10, full: true, phase: 1,
        robots: [create(RobotStateSchema, { base: create(EntityBaseSchema, { id: 7 }), hpX10: 1000, invulnS: 3 })],
      })
      expect(applySnapshot(world, full)).toBe('applied')
      expect(world.robots.get(7)!.invulnerable).toBe(true)
      expect(world.robots.get(7)!.invulnUntil).toBeUndefined()

      const ended = create(SnapshotDeltaSchema, {
        tick: 11, baseTick: 10, phase: 1,
        robots: [create(RobotStateSchema, { base: create(EntityBaseSchema, { id: 7 }), hpX10: 1000, invulnS: 0 })],
      })
      expect(applySnapshot(world, ended)).toBe('applied')
      expect(world.robots.get(7)!.invulnerable).toBe(false)
      expect(world.robots.get(7)!.invulnUntil).toBeUndefined()
    } finally { vi.useRealTimers() }
  })
})
