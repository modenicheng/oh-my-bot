// MapDef 解析：EvMapBootstrap.map_json → 结构化地图。
// JSON 形状对齐服务端 server/internal/sim/contract.go 的 MapDef（json tag 小写下划线），
// 但 Vec2/Rect 无 json tag → 序列化为大写 X/Y、Min/Max，此处做大小写兼容。
// 三环结构（docs/design/game_design_v0.3.md §3）：外环 55–80m / 中环 30–55m / 锁区 28m（mapgen coreZoneR）。
// 注：设计文档的「核心区 <30m」是中环内边界表述；实际锁区半径以 mapgen 下发的 core_zone 为准。

import { goNum, goVec2 } from '../lib/gojson'

export interface MapVec2 { x: number; y: number }
export interface MapRect { min: MapVec2; max: MapVec2 }
export interface MapWall { id: number; min: MapVec2; max: MapVec2 }
export interface MapSector { id: number; spawnArea: MapRect; center: MapVec2 }
export interface MapUplink { id: number; pos: MapVec2; main: boolean; interactR: number; activePhase: number }
export interface MapCorePad { id: number; pos: MapVec2; group: number; value: number }
export interface MapHealthPack { id: number; pos: MapVec2 }

export interface MapDefParsed {
  version: number
  generatorVer: number
  seed: number
  mapHash: string
  walls: MapWall[]
  sectors: MapSector[]
  uplinks: MapUplink[]
  corePads: MapCorePad[]
  healthPacks: MapHealthPack[]
  coreZone: { radius: number; unlockPhase: number }
  /** 地图外接半径（米）：相机钳制与全局参照用 */
  extent: number
}

/** 三环半径（设计常量，渲染环线参照；实际锁区以 core_zone 为准）。
 * RING_CORE 仅作 mapdef 缺 core_zone.radius 时的兜底，取服务端实际锁区半径：
 * mapgen/generator.go 的 coreZoneR = 28（<30m 中环内边界；旧值 30 与服务端不一致）。 */
export const RING_CORE = 28
export const RING_OUTER = 80

/** 黑入进度满值：progress_x10 的分母（8s × 10，对应 server sim.HackDuration=480）。
 *  X-3 起 HUD/渲染/音效改消费 world.tuning（hackMaxX10，服务器下发）；
 *  本常量仅保留给不持有 world 的旧路径引用，值与兜底 tuning 一致（D3）。 */
export const HACK_MAX_X10 = 80

type Raw = Record<string, unknown>

function asRaw(v: unknown): Raw {
  return v !== null && typeof v === 'object' ? (v as Raw) : {}
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
/** Rect 无 json tag：Go 序列化为大写 Min/Max；兼容小写 */
function rect(v: unknown): MapRect {
  const r = asRaw(v)
  return { min: goVec2(r['Min'] ?? r['min']), max: goVec2(r['Max'] ?? r['max']) }
}

/**
 * 解析 EvMapBootstrap.map_json。结构非法（缺 walls/uplinks/core_zone 等）时抛错，
 * 调用方捕获后留在房间视图并提示。
 */
export function parseMapDef(json: string): MapDefParsed {
  let root: unknown
  try {
    root = JSON.parse(json)
  } catch (err) {
    throw new Error(`地图 JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  const r = asRaw(root)

  const walls: MapWall[] = arr(r['walls']).map((w, i) => {
    const o = asRaw(w)
    return { id: goNum(o['id'], i), min: goVec2(o['min']), max: goVec2(o['max']) }
  })
  const sectors: MapSector[] = arr(r['sectors']).map((s, i) => {
    const o = asRaw(s)
    return { id: goNum(o['id'], i), spawnArea: rect(o['spawn_area']), center: goVec2(o['center']) }
  })
  const uplinks: MapUplink[] = arr(r['uplinks']).map((u, i) => {
    const o = asRaw(u)
    return {
      id: goNum(o['id'], i),
      pos: goVec2(o['pos']),
      main: o['main'] === true,
      interactR: goNum(o['interact_r'], 2.5),
      activePhase: goNum(o['active_phase'], 1),
    }
  })
  const corePads: MapCorePad[] = arr(r['core_pads']).map((c, i) => {
    const o = asRaw(c)
    return { id: goNum(o['id'], i), pos: goVec2(o['pos']), group: goNum(o['group']), value: goNum(o['value'], 10) }
  })
  const healthPacks: MapHealthPack[] = arr(r['health_packs']).map((h, i) => {
    const o = asRaw(h)
    return { id: goNum(o['id'], i + 1), pos: goVec2(o['pos']) }
  })
  const cz = asRaw(r['core_zone'])
  const coreZone = { radius: goNum(cz['radius'], RING_CORE), unlockPhase: goNum(cz['unlock_phase'], 2) }

  if (walls.length === 0) throw new Error('地图缺少墙体数据')
  if (uplinks.length === 0) throw new Error('地图缺少 Uplink 数据')

  // 外接半径：三环 80m 与所有实体坐标的最大值
  let maxC = RING_OUTER
  for (const w of walls) {
    maxC = Math.max(maxC, Math.abs(w.min.x), Math.abs(w.min.y), Math.abs(w.max.x), Math.abs(w.max.y))
  }
  for (const u of uplinks) maxC = Math.max(maxC, Math.abs(u.pos.x), Math.abs(u.pos.y))
  for (const p of corePads) maxC = Math.max(maxC, Math.abs(p.pos.x), Math.abs(p.pos.y))
  for (const h of healthPacks) maxC = Math.max(maxC, Math.abs(h.pos.x), Math.abs(h.pos.y))

  return {
    version: goNum(r['version'], 1),
    generatorVer: goNum(r['generator_ver']),
    seed: goNum(r['seed']),
    mapHash: typeof r['map_hash'] === 'string' ? r['map_hash'] : '',
    walls,
    sectors,
    uplinks,
    corePads,
    healthPacks,
    coreZone,
    extent: maxC,
  }
}
