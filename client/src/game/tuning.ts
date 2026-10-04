// 对局数值（审计 X-3）：EvMapBootstrap.tuning 是唯一权威源，本模块持有
// 「已下发值 + 旧服务器/旧录像兜底」。漂移高危集与服务器 sim 常量一一对应：
//   tick_rate ↔ sim.TickRate=60 · max_hp_x10/max_energy_x10 ↔ sim.MaxHP/MaxEnergy ×10
//   fire_cost ↔ sim.FireCost=5 · hack_duration_ticks ↔ sim.HackDuration=480
//   invuln_duration_ticks ↔ sim.InvulnDuration=240 · vision_radius ↔ sim.VisionRadius=20
// 兜底值与 DEFAULT_TUNING.goldenHex 由 server/internal/glue 的 SimTuning golden
// 测试互钉（两侧断言同一 hex），服务器调数值而不改协议时漂移即刻暴露。
import { create, toBinary } from '@bufbuild/protobuf'
import { SimTuningSchema, type SimTuning } from '@omb/protocol'

/** 兜底值 = 当前服务器常量的快照（仅旧服务器/旧录像路径使用）。 */
export const FALLBACK_TUNING: Readonly<SimTuning> = Object.freeze(create(SimTuningSchema, {
  tickRate: 60,
  maxHpX10: 1000,
  maxEnergyX10: 1000,
  fireCost: 5,
  hackDurationTicks: 480,
  invulnDurationTicks: 240,
  visionRadius: 20,
}))

/** 字节 → 小写 hex（测试用；不依赖 Node Buffer，客户端包是浏览器环境）。 */
function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** 兜底值的黄金字节：与 server/internal/glue 的 SimTuning golden 互钉。 */
export const FALLBACK_TUNING_HEX = toHex(toBinary(SimTuningSchema, FALLBACK_TUNING))

/** 解析服务器下发 tuning；字段缺失（旧服务器）回退兜底值。 */
export function resolveTuning(wire: SimTuning | undefined): Readonly<SimTuning> {
  if (!wire) return FALLBACK_TUNING
  return Object.freeze(create(SimTuningSchema, {
    tickRate: wire.tickRate || FALLBACK_TUNING.tickRate,
    maxHpX10: wire.maxHpX10 || FALLBACK_TUNING.maxHpX10,
    maxEnergyX10: wire.maxEnergyX10 || FALLBACK_TUNING.maxEnergyX10,
    fireCost: wire.fireCost || FALLBACK_TUNING.fireCost,
    hackDurationTicks: wire.hackDurationTicks || FALLBACK_TUNING.hackDurationTicks,
    invulnDurationTicks: wire.invulnDurationTicks || FALLBACK_TUNING.invulnDurationTicks,
    visionRadius: wire.visionRadius || FALLBACK_TUNING.visionRadius,
  }))
}

/** 无敌闪烁窗口（ms）：服务器 InvulnDuration tick + 250ms 容差（快照延迟）。 */
export function invulnWindowMs(tuning: Readonly<SimTuning>): number {
  return (tuning.invulnDurationTicks / tuning.tickRate) * 1000 + 250
}

/** Uplink 引导进度满值（×10）：HACK_MAX_X10 的服务器同源形态。 */
export function hackMaxX10(tuning: Readonly<SimTuning>): number {
  return (tuning.hackDurationTicks * 10) / tuning.tickRate
}
