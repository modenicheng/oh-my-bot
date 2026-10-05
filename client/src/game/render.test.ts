import { beforeAll, describe, expect, it, vi } from 'vitest'
import { emptyWorld, type RobotEnt, type WorldState } from './world'
import type { MapDefParsed, MapWall } from './mapdef'
import { Camera } from './camera'

// render.ts → art.ts 在模块加载期访问 matchMedia/document.fonts/Image（Node
// 环境缺失）：先桩再动态导入一次。
beforeAll(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('document', { fonts: { load: () => Promise.resolve([]) } })
  vi.stubGlobal('Image', class { onload?: () => void; onerror?: () => void; src = '' })
})

interface Op { op: string; args: unknown[] }

/** 记录型 2D 上下文：只记录路径/填充调用，供结构断言（无像素环境的替代）。 */
function recordingCtx(): { ctx: Record<string, unknown>; ops: Op[] } {
  const ops: Op[] = []
  const rec = (op: string) => (...args: unknown[]) => { ops.push({ op, args }) }
  const ctx: Record<string, unknown> = {
    canvas: {}, save: rec('save'), restore: rec('restore'), beginPath: rec('beginPath'),
    setTransform: rec('setTransform'),
    rect: rec('rect'), arc: rec('arc'), fill: rec('fill'), fillRect: rec('fillRect'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'), closePath: rec('closePath'), stroke: rec('stroke'),
    clip: rec('clip'), ellipse: rec('ellipse'), drawImage: rec('drawImage'), fillText: rec('fillText'),
    strokeRect: rec('strokeRect'), translate: rec('translate'), rotate: rec('rotate'),
    setLineDash: rec('setLineDash'), measureText: () => ({ width: 8 }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    set fillStyle(v: unknown) { ops.push({ op: 'fillStyle', args: [v] }) },
    get fillStyle() { return '#000' },
    set strokeStyle(v: unknown) { ops.push({ op: 'strokeStyle', args: [v] }) },
    get strokeStyle() { return '#000' },
    set lineWidth(v: unknown) { ops.push({ op: 'lineWidth', args: [v] }) },
    get lineWidth() { return 1 },
    set font(v: unknown) { ops.push({ op: 'font', args: [v] }) },
    get font() { return '' },
    set globalAlpha(v: unknown) { ops.push({ op: 'globalAlpha', args: [v] }) },
    get globalAlpha() { return 1 },
    set textAlign(v: unknown) { ops.push({ op: 'textAlign', args: [v] }) },
    get textAlign() { return 'left' },
    set textBaseline(v: unknown) { ops.push({ op: 'textBaseline', args: [v] }) },
    get textBaseline() { return 'alphabetic' },
    createRadialGradient: () => ({ addColorStop: () => {} }),
    set fillRule(v: unknown) { ops.push({ op: 'fillRule', args: [v] }) },
  }
  return { ctx, ops }
}

/** 第 i 个纯圆填充块（beginPath…fill()，非 evenodd）：最后一次 arc 的参数。 */
function discFill(ops: Op[], index: number): { x: number; y: number; r: number } | undefined {
  let seen = -1
  let lastArc: { x: number; y: number; r: number } | undefined
  for (const { op, args } of ops) {
    if (op === 'beginPath') lastArc = undefined
    else if (op === 'arc') lastArc = { x: args[0] as number, y: args[1] as number, r: args[2] as number }
    else if (op === 'fill' && args.length === 0) {
      seen++
      if (seen === index) return lastArc
    }
  }
  return undefined
}

/** 第 i 个 evenodd 填充块（beginPath…fill('evenodd')）里最后一次 arc 的参数。 */
function evenoddArc(ops: Op[], index: number): { x: number; y: number; r: number } | undefined {
  let seen = -1
  let lastArc: { x: number; y: number; r: number } | undefined
  for (const { op, args } of ops) {
    if (op === 'beginPath') lastArc = undefined
    else if (op === 'arc') lastArc = { x: args[0] as number, y: args[1] as number, r: args[2] as number }
    else if (op === 'fill' && args[0] === 'evenodd') {
      seen++
      if (seen === index) return lastArc
    }
  }
  return undefined
}

/** beginPath…clip() 块（视野圆裁剪）里最后一次 arc 的参数。 */
function clipArc(ops: Op[]): { x: number; y: number; r: number } | undefined {
  let lastArc: { x: number; y: number; r: number } | undefined
  for (const { op, args } of ops) {
    if (op === 'beginPath') lastArc = undefined
    else if (op === 'arc') lastArc = { x: args[0] as number, y: args[1] as number, r: args[2] as number }
    else if (op === 'clip') return lastArc
  }
  return undefined
}

interface Pt { x: number; y: number }

/** 影多边形子路径：clip() 之后的 beginPath…fill() 块内，按 moveTo 分组。 */
function shadowSubpaths(ops: Op[]): Pt[][] {
  const paths: Pt[][] = []
  let cur: Pt[] | undefined
  let inShadow = false
  for (const { op, args } of ops) {
    if (op === 'clip') { inShadow = true; cur = undefined; continue }
    if (!inShadow) continue
    if (op === 'restore') break
    if (op === 'beginPath') { cur = undefined; continue }
    if (op === 'moveTo') { cur = [{ x: args[0] as number, y: args[1] as number }]; paths.push(cur); continue }
    if (op === 'lineTo' && cur) { cur.push({ x: args[0] as number, y: args[1] as number }); continue }
    if (op === 'fill') break
  }
  return paths
}

const wall = (minx: number, miny: number, maxx: number, maxy: number, id = 1): MapWall => ({ id, min: { x: minx, y: miny }, max: { x: maxx, y: maxy } })

/** 全部纯圆盘填充（beginPath…arc…fill）的圆参数。 */
function discFills(ops: Op[]): { x: number; y: number; r: number }[] {
  const discs: { x: number; y: number; r: number }[] = []
  let lastArc: { x: number; y: number; r: number } | undefined
  for (const { op, args } of ops) {
    if (op === 'beginPath') lastArc = undefined
    else if (op === 'arc') lastArc = { x: args[0] as number, y: args[1] as number, r: args[2] as number }
    else if (op === 'fill' && args.length === 0 && lastArc) discs.push(lastArc)
  }
  return discs
}

const map = (unlockPhase: number, walls: MapWall[] = []): MapDefParsed => ({
  version: 1, generatorVer: 1, seed: 1, mapHash: '', extent: 80,
  walls, sectors: [], uplinks: [], corePads: [], healthPacks: [],
  coreZone: { radius: 28, unlockPhase },
})

function worldAt(phase: number, x = 40, y = 0): WorldState {
  const world = emptyWorld()
  world.phase = phase
  world.self = { robotId: 1 } as WorldState['self']
  const robot = {} as RobotEnt
  Object.assign(robot, { base: { id: 1, pos: { x, y } }, seenAt: 0 })
  world.robots.set(1, robot)
  return world
}

/** 直接驱动私有 drawVisionMask：render() 全路径需要完整 art 装配，雾罩本身自足。 */
async function visionOps(phase: number, unlockPhase: number, walls: MapWall[] = [], self = { x: 40, y: 0 }): Promise<{ ops: Op[]; cam: Camera }> {
  const { Renderer } = await import('./render')
  const { ctx, ops } = recordingCtx()
  const renderer = new Renderer({ getContext: () => ctx } as unknown as HTMLCanvasElement)
  const cam = new Camera()
  cam.resize(800, 500, 80)
  cam.follow(self.x, self.y)
  ;(renderer as unknown as { drawVisionMask(w: WorldState, m: MapDefParsed, c: Camera): void })
    .drawVisionMask(worldAt(phase, self.x, self.y), map(unlockPhase, walls), cam)
  return { ops, cam }
}

// X-9：未解锁核心区雾遮罩。锁区圆心是场地原点（与 drawArena 的锁区圈一致），
// 半径取 map.coreZone.radius；解锁后（phase >= unlock_phase）与未开局
// （phase 0）不遮；视野圈/墙影结构保持不变。
describe('drawVisionMask locked core-zone cover (X-9)', () => {
  // 相机跟随自机 (40,0)，scale=20：场地原点投影在 x=-400（锁区圆心，与
  // drawArena 一致），自机投影在 x=400（视野圆心）。
  const cam = new Camera()
  cam.resize(800, 500, 80)
  cam.follow(40, 0)
  const CORE = { x: cam.toPxX(0), y: cam.toPxY(0), r: 28 * cam.scale }
  const VISION = { x: cam.toPxX(40), y: cam.toPxY(0), r: 20 * cam.scale }

  it('covers the locked core zone (plain disc fill centered at arena origin)', async () => {
    const { ops } = await visionOps(1, 2)
    // 第 0 个纯圆填充 = 锁区盘（原点圆心 + coreZone 半径）；视野圈仍是 evenodd 打孔。
    expect(discFill(ops, 0)).toEqual(CORE)
    expect(evenoddArc(ops, 0)).toEqual(VISION)
  })
  it('keeps the fog color token on the core-zone fill', async () => {
    const { ops } = await visionOps(1, 2)
    const styles = ops.filter(o => o.op === 'fillStyle').map(o => o.args[0])
    expect(styles).toContain('rgba(5, 9, 14, 0.78)')
  })

  it('does not cover the core zone once unlocked (phase >= unlock_phase)', async () => {
    const { ops } = await visionOps(2, 2)
    // 不再有锁区盘（原点圆心 + coreZone 半径）；视野圈仍是一块 evenodd。
    expect(discFills(ops)).not.toContainEqual(CORE)
    expect(evenoddArc(ops, 0)).toEqual(VISION)
    expect(evenoddArc(ops, 1)).toBeUndefined()
  })

  it('does not cover the core zone before the match starts (phase 0)', async () => {
    const { ops } = await visionOps(0, 2)
    expect(discFills(ops)).not.toContainEqual(CORE)
    expect(evenoddArc(ops, 0)).toEqual(VISION)
    expect(evenoddArc(ops, 1)).toBeUndefined()
  })

  it('still bails out without a self robot (no mask ops at all)', async () => {
    const { Renderer } = await import('./render')
    const { ctx, ops } = recordingCtx()
    const renderer = new Renderer({ getContext: () => ctx } as unknown as HTMLCanvasElement)
    const cam = new Camera()
    cam.resize(800, 500, 80)
    const world = emptyWorld()
    world.phase = 1
    ;(renderer as unknown as { drawVisionMask(w: WorldState, m: MapDefParsed, c: Camera): void })
      .drawVisionMask(world, map(2), cam)
    expect(ops.filter(o => o.op === 'fill')).toHaveLength(0)
  })
})

// 精确墙影投影：每墙一个子路径合入单次 nonzero 填充；视野圆 clip 保证影不外溢。
describe('drawVisionMask exact projected wall shadows', () => {
  it('draws one subpath per wall with a single nonzero fill clipped to the vision disc', async () => {
    const walls = [
      wall(30, -2, 34, 2, 1),   // 自机正西（墙 x<40）→ 出口链向左
      wall(46, -2, 50, 2, 2),   // 自机正东
      wall(38, 8, 42, 12, 3),   // 自机正北（y 向下为负）
      wall(-30, -2, -26, 2, 4), // 远离视野圆 → 不投影
    ]
    const { ops, cam } = await visionOps(1, 2, walls)
    const paths = shadowSubpaths(ops)
    expect(paths).toHaveLength(3)
    // 视野圆 clip（自机像素位置，半径 = visionRadius × scale）。
    expect(clipArc(ops)).toEqual({ x: cam.toPxX(40), y: cam.toPxY(0), r: 20 * cam.scale })
    // 单次填充（clip 与 fill 之间恰好一个 fill，nonzero 默认填充规则）。
    const fills = ops.filter(o => o.op === 'fill' && o.args.length === 0).length
    expect(fills).toBeGreaterThanOrEqual(1)
    // 全部子路径在 clip…fill 块内一次性合入（不是每墙一 fill）。
    const clipIdx = ops.findIndex(o => o.op === 'clip')
    const restoreIdx = ops.findIndex((o, i) => o.op === 'restore' && i > clipIdx)
    const innerFills = ops.slice(clipIdx, restoreIdx).filter(o => o.op === 'fill')
    expect(innerFills).toHaveLength(1)
    // 影多边形顶点有限（无 NaN 进入 Canvas 路径）。
    for (const p of paths) for (const v of p) expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true)
  })

  it('projects the east wall as a pixel-space silhouette behind the wall', async () => {
    const walls = [wall(46, -2, 50, 2)]
    const { ops, cam } = await visionOps(1, 2, walls)
    const paths = shadowSubpaths(ops)
    expect(paths).toHaveLength(1)
    const poly = paths[0]!
    // 顶点经 cam 变换：c0=(46,-2)…c3=(50,2) 均在路径上（全链 4 角 + 2 延长点）。
    for (const [wx, wy] of [[46, -2], [50, -2], [50, 2], [46, 2]] as const) {
      expect(poly).toContainEqual({ x: cam.toPxX(wx), y: cam.toPxY(wy) })
    }
    expect(poly.length).toBe(7)
    // 两个切线延长点和一个远向中心封口点均在视野圆之外。
    const vcx = cam.toPxX(40), vcy = cam.toPxY(0), vr = 20 * cam.scale
    const exts = poly.filter(v => !([[46, -2], [50, -2], [50, 2], [46, 2]] as const).some(([wx, wy]) => v.x === cam.toPxX(wx) && v.y === cam.toPxY(wy)))
    expect(exts.length).toBeGreaterThanOrEqual(2)
    for (const e of exts) expect(Math.hypot(e.x - vcx, e.y - vcy)).toBeGreaterThan(vr)
  })

  it('keeps overlap of an L assembly at a single fill (no per-wall double fill)', async () => {
    // L 形两件套（mapgen 语义：0.7×0.7 正面积重叠）投影后两子路径相交，
    // 但只发生一次 fill() —— 强度恒定，不因重叠加深。
    const walls = [
      wall(44.3, -0.35, 48.3, 0.35, 1),
      wall(47.6, -0.35, 48.3, 3.5, 2),
    ]
    const { ops } = await visionOps(1, 2, walls)
    const clipIdx = ops.findIndex(o => o.op === 'clip')
    const restoreIdx = ops.findIndex((o, i) => o.op === 'restore' && i > clipIdx)
    const innerFills = ops.slice(clipIdx, restoreIdx).filter(o => o.op === 'fill')
    expect(innerFills).toHaveLength(1)
    expect(shadowSubpaths(ops)).toHaveLength(2)
    // 填充色是单一固定 token（重叠处同一次填充，色值一致）。
    const styles = ops.slice(clipIdx, restoreIdx).filter(o => o.op === 'fillStyle').map(o => o.args[0])
    expect(styles).toEqual(['rgba(5, 9, 14, 0.2925)'])
  })

  it('self inside a wall: full-dark ring around a visible wall body', async () => {
    const walls = [wall(38, -3, 42, 3)]
    const { ops, cam } = await visionOps(1, 2, walls)
    const paths = shadowSubpaths(ops)
    // 两个子路径：视野大框 + 逆向墙身（nonzero 相消 → 墙身可见）。
    expect(paths).toHaveLength(2)
    const [big, body] = paths as [Pt[], Pt[]]
    expect(big.length).toBe(4)
    expect(body).toEqual([
      { x: cam.toPxX(38), y: cam.toPxY(-3) }, { x: cam.toPxX(38), y: cam.toPxY(3) },
      { x: cam.toPxX(42), y: cam.toPxY(3) }, { x: cam.toPxX(42), y: cam.toPxY(-3) },
    ])
    const clipIdx = ops.findIndex(o => o.op === 'clip')
    const restoreIdx = ops.findIndex((o, i) => o.op === 'restore' && i > clipIdx)
    expect(ops.slice(clipIdx, restoreIdx).filter(o => o.op === 'fill')).toHaveLength(1)
  })

  it('emits no shadow path at all without walls in range', async () => {
    const { ops } = await visionOps(1, 2, [wall(-60, -2, -56, 2)])
    expect(clipArc(ops)).toBeUndefined()
    expect(shadowSubpaths(ops)).toHaveLength(0)
  })

  it('scales per wall: constant ops per wall, one clip + one fill regardless of wall count', async () => {
    // 64 面在视野内的墙（绕自机一圈）：结构成本 = 每墙 1 个 moveTo +
    // 5–6 个 lineTo（远侧链 2–4 角 + 2 切线点 + 1 远向封口点），整体恰好
    // 1 次 clip + 1 次 fill —— 不存在旧实现的 512 射线 × 32 band 结构。
    const walls: MapWall[] = []
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2
      const cx = 40 + Math.cos(a) * 10, cy = Math.sin(a) * 10
      walls.push(wall(cx - 1, cy - 0.35, cx + 1, cy + 0.35, i + 1))
    }
    const { ops } = await visionOps(1, 2, walls)
    const clipIdx = ops.findIndex(o => o.op === 'clip')
    const restoreIdx = ops.findIndex((o, i) => o.op === 'restore' && i > clipIdx)
    const block = ops.slice(clipIdx, restoreIdx)
    expect(block.filter(o => o.op === 'fill')).toHaveLength(1)
    const moveTo = block.filter(o => o.op === 'moveTo').length
    const lineTo = block.filter(o => o.op === 'lineTo').length
    expect(moveTo).toBe(64)
    expect(lineTo).toBeGreaterThanOrEqual(64 * 5)
    expect(lineTo).toBeLessThanOrEqual(64 * 6)
    // 无墙内场景：每墙单子路径（无 NaN 分隔的双子路径）。
    expect(shadowSubpaths(ops)).toHaveLength(64)
  })

  it('keeps a wall-adjacent far region covered by the projected shadow', async () => {
    const walls = [wall(40.601, -2, 44.601, 2)]
    const { ops, cam } = await visionOps(1, 2, walls, { x: 40, y: 0 })
    const poly = shadowSubpaths(ops)[0]!
    // 自机中心距近墙面约 0.6m（机器人贴墙）：远向中心必须位于影内，不再出现窄三角漏光。
    const far = { x: cam.toPxX(50), y: cam.toPxY(0) }
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!, b = poly[j]!
      if ((a.y > far.y) !== (b.y > far.y) && far.x < ((b.x - a.x) * (far.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
    }
    expect(inside).toBe(true)
  })

  it('edge feather gradient stays after the shadow block (unchanged contract)', async () => {
    const { ops, cam } = await visionOps(1, 2, [wall(46, -2, 50, 2)])
    // 最后一块纯圆填充 = 边缘渐变（自机圆心 + 视野半径）。
    const discs = discFills(ops)
    expect(discs[discs.length - 1]).toEqual({ x: cam.toPxX(40), y: cam.toPxY(0), r: 20 * cam.scale })
  })
})
// Uplink 锚定 def.pos：进度变化不改变实体坐标（进度环与交互圈同坐标），
// lift 恒为 0（悬浮表现归 art.ts 内部，不改变实体位置）。
describe('render() uplink anchoring', () => {
  /** 全路径 render()：记录 art 绘制序列，从进度环/阴影椭圆反推实体坐标。 */
  async function renderUplink(progressX10: number, self = { x: 40, y: 0 }): Promise<{ ops: Op[]; cam: Camera }> {
    const { Renderer } = await import('./render')
    const { ctx, ops } = recordingCtx()
    const renderer = new Renderer({ getContext: () => ctx, width: 800, height: 500 } as unknown as HTMLCanvasElement)
    const cam = new Camera()
    cam.resize(800, 500, 80)
    cam.follow(self.x, self.y)
    const m = map(2)
    m.uplinks = [{ id: 1, pos: { x: 36, y: 0 }, main: true, interactR: 2.5, activePhase: 1 }]
    const world = worldAt(2, self.x, self.y)
    world.uplinks.set(1, { base: undefined, ready: false, hackingId: 0, progressX10, myCooldownS: 0, seenAt: 0 } as never)
    renderer.render(world, m, cam, { bubbles: [] })
    return { ops, cam }
  }

  it('keeps the armored chassis centered at def.pos across progress changes, lift stays 0', async () => {
    for (const px10 of [0, 40, 80]) {
      const { ops, cam } = await renderUplink(px10)
      const px = cam.toPxX(36), py = cam.toPxY(0)
      const size = Math.max(12, 2.1 * cam.scale)
      // 主 Uplink 使用装甲路径而非旧圆形 sprite；中心舱矩形直接锁定权威坐标。
      const center = ops.find(o => o.op === 'fillRect'
        && Math.abs((o.args[0] as number) - (px - size * 0.04)) < 1e-9
        && Math.abs((o.args[1] as number) - (py - size * 0.04)) < 1e-9
        && Math.abs((o.args[2] as number) - size * 0.08) < 1e-9
        && Math.abs((o.args[3] as number) - size * 0.08) < 1e-9)
      expect(center).toBeDefined()
      if (px10 > 0) {
        const pct = ops.filter(o => o.op === 'fillText' && String(o.args[0]).endsWith('%'))
        expect(pct).toHaveLength(1)
        expect(pct[0]!.args.slice(1)).toEqual([px, py + size + 5])
      }
      // lift=0：不出现任何悬浮投影阴影椭圆。
      expect(ops.filter(o => o.op === 'ellipse')).toHaveLength(0)
    }
  })

  it('anchors the interact ring at def.pos when self is in range (no drift with progress)', async () => {
    for (const px10 of [0, 40]) {
      const { ops, cam } = await renderUplink(px10, { x: 37, y: 0 })
      // 交互圈：setLineDash([5,7]) 后的 arc(def.pos, interactR*scale)。
      const dash = ops.findIndex(o => o.op === 'setLineDash' && JSON.stringify(o.args[0]) === '[5,7]')
      expect(dash).toBeGreaterThanOrEqual(0)
      const ring = ops.slice(dash).find(o => o.op === 'arc')!
      expect(ring.args[0]).toBe(cam.toPxX(36))
      expect(ring.args[1]).toBe(cam.toPxY(0))
      expect(ring.args[2]).toBeCloseTo(2.5 * cam.scale, 6)
      // 交互圈与装甲主机身共享同一权威中心；进度只改变内部能量格。
      const size = Math.max(12, 2.1 * cam.scale)
      const center = ops.find(o => o.op === 'fillRect'
        && Math.abs((o.args[0] as number) - (cam.toPxX(36) - size * 0.04)) < 1e-9
        && Math.abs((o.args[1] as number) - (cam.toPxY(0) - size * 0.04)) < 1e-9
        && Math.abs((o.args[2] as number) - size * 0.08) < 1e-9
        && Math.abs((o.args[3] as number) - size * 0.08) < 1e-9)
      expect(center).toBeDefined()
      expect(ops.filter(o => o.op === 'ellipse')).toHaveLength(0)
    }
  })
})

// 64 人房间固定相机夹具：世界状态可含 64 台，但机器人本体/白条热路径只处理
// 当前画布附近的实体。20m 视野与阴影仍由 render() 的统一遮罩在后续层约束。
describe('render() 64-player viewport work budget', () => {
  it('draws and samples delayed health only for the visible robot subset', async () => {
    const { Renderer } = await import('./render')
    const { ctx } = recordingCtx()
    const renderer = new Renderer({ getContext: () => ctx, width: 800, height: 500 } as unknown as HTMLCanvasElement)
    const cam = new Camera()
    cam.resize(800, 500, 80)
    cam.follow(0, 0)
    const world = emptyWorld()
    world.phase = 2
    world.self = { robotId: 1 } as WorldState['self']
    for (let id = 1; id <= 64; id++) {
      const visible = id <= 8
      world.robots.set(id, {
        base: { id, pos: { x: visible ? (id - 4) * 2 : 60 + id, y: visible ? 0 : 60 } },
        hpX10: 1000, energyX10: 1000, shieldOn: false, dashing: false, dead: false, respawnInS: 0,
        nick: `R${id}`, color: '#22d3ee', seenAt: 0, invulnerable: false,
      } as RobotEnt)
    }
    let delayedReads = 0
    const feedback = {
      cameraShake: () => ({ x: 0, y: 0 }),
      drawTrails: () => {},
      draw: () => {},
      delayedHealth: (_id: number, hpX10: number) => { delayedReads++; return hpX10 / 10 },
    }
    renderer.render(world, map(2), cam, { bubbles: [], feedback: feedback as never })
    expect(renderer.lastFrameStats).toEqual({ robots: 64, culledRobots: 56, drawnRobots: 8, delayedHealthReads: 8 })
    expect(delayedReads).toBe(8)
  })
})
