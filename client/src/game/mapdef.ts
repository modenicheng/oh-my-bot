// MapDef 解析：EvMapBootstrap.map_json → 结构化地图。
// JSON 形状对齐服务端 server/internal/sim/contract.go 的 MapDef（json tag 小写下划线），
// 但 Vec2/Rect 无 json tag → 序列化为大写 X/Y、Min/Max，此处做大小写兼容。
// 三环结构（docs/design/game_design_v0.3.md §3）：外环 55–80m / 中环 30–55m / 核心区 <30m。

export interface MapVec2 { x: number; y: number }
export interface MapRect { min: MapVec2; max: MapVec2 }
export interface MapWall { id: number; min: MapVec2; max: MapVec2 }
export interface MapSector { id: number; spawnArea: MapRect; center: MapVec2 }
export interface MapUplink { id: number; pos: MapVec2; main: boolean; interactR: number; activePhase: number }
export interface MapCorePad { id: number; pos: MapVec2; group: number; value: number }

export interface MapDefParsed {
  version: number
  generatorVer: number
  seed: number
  mapHash: string
  walls: MapWall[]
  sectors: MapSector[]
  uplinks: MapUplink[]
  corePads: MapCorePad[]
  coreZone: { radius: number; unlockPhase: number }
  /** 地图外接半径（米）：相机钳制与全局参照用 */
  extent: number
}

/** 三环半径（设计常量，渲染环线参照；实际锁区以 core_zone 为准） */
export const RING_CORE = 30
export const RING_MID = 55
export const RING_OUTER = 80

type Raw = Record<string, unknown>

function asRaw(v: unknown): Raw {
  return v !== null && typeof v === 'object' ? (v as Raw) : {}
}
function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
/** Vec2 无 json tag：Go 序列化为大写 X/Y；兼容小写 */
function vec2(v: unknown): MapVec2 {
  const r = asRaw(v)
  const x = r['X'] ?? r['x'] ?? 0
  const y = r['Y'] ?? r['y'] ?? 0
  return { x: num(x), y: num(y) }
}
/** Rect 无 json tag：Go 序列化为大写 Min/Max；兼容小写 */
function rect(v: unknown): MapRect {
  const r = asRaw(v)
  return { min: vec2(r['Min'] ?? r['min']), max: vec2(r['Max'] ?? r['max']) }}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
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
    return { id: num(o['id'], i), min: vec2(o['min']), max: vec2(o['max']) }
  })
  const sectors: MapSector[] = arr(r['sectors']).map((s, i) => {
    const o = asRaw(s)
    return { id: num(o['id'], i), spawnArea: rect(o['spawn_area']), center: vec2(o['center']) }
  })
  const uplinks: MapUplink[] = arr(r['uplinks']).map((u, i) => {
    const o = asRaw(u)
    return {
      id: num(o['id'], i),
      pos: vec2(o['pos']),
      main: o['main'] === true,
      interactR: num(o['interact_r'], 2.5),
      activePhase: num(o['active_phase'], 1),
    }
  })
  const corePads: MapCorePad[] = arr(r['core_pads']).map((c, i) => {
    const o = asRaw(c)
    return { id: num(o['id'], i), pos: vec2(o['pos']), group: num(o['group']), value: num(o['value'], 10) }
  })
  const cz = asRaw(r['core_zone'])
  const coreZone = { radius: num(cz['radius'], RING_CORE), unlockPhase: num(cz['unlock_phase'], 2) }

  if (walls.length === 0) throw new Error('地图缺少墙体数据')
  if (uplinks.length === 0) throw new Error('地图缺少 Uplink 数据')

  // 外接半径：三环 80m 与所有实体坐标的最大值
  let maxC = RING_OUTER
  for (const w of walls) {
    maxC = Math.max(maxC, Math.abs(w.min.x), Math.abs(w.min.y), Math.abs(w.max.x), Math.abs(w.max.y))
  }
  for (const u of uplinks) maxC = Math.max(maxC, Math.abs(u.pos.x), Math.abs(u.pos.y))
  for (const p of corePads) maxC = Math.max(maxC, Math.abs(p.pos.x), Math.abs(p.pos.y))

  return {
    version: num(r['version'], 1),
    generatorVer: num(r['generator_ver']),
    seed: num(r['seed']),
    mapHash: typeof r['map_hash'] === 'string' ? r['map_hash'] : '',
    walls,
    sectors,
    uplinks,
    corePads,
    coreZone,
    extent: maxC,
  }
}
