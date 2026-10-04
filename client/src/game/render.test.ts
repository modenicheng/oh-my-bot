import { beforeAll, describe, expect, it, vi } from 'vitest'
import { emptyWorld, type RobotEnt, type WorldState } from './world'
import type { MapDefParsed } from './mapdef'
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
    rect: rec('rect'), arc: rec('arc'), fill: rec('fill'), fillRect: rec('fillRect'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'), closePath: rec('closePath'), stroke: rec('stroke'),
    set fillStyle(v: unknown) { ops.push({ op: 'fillStyle', args: [v] }) },
    get fillStyle() { return '#000' },
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

const map = (unlockPhase: number): MapDefParsed => ({
  version: 1, generatorVer: 1, seed: 1, mapHash: '', extent: 80,
  walls: [], sectors: [], uplinks: [], corePads: [], healthPacks: [],
  coreZone: { radius: 28, unlockPhase },
})

function worldAt(phase: number): WorldState {
  const world = emptyWorld()
  world.phase = phase
  world.self = { robotId: 1 } as WorldState['self']
  const robot = {} as RobotEnt
  Object.assign(robot, { base: { id: 1, pos: { x: 40, y: 0 } }, seenAt: 0 })
  world.robots.set(1, robot)
  return world
}

/** 直接驱动私有 drawVisionMask：render() 全路径需要完整 art 装配，雾罩本身自足。 */
async function visionOps(phase: number, unlockPhase: number): Promise<Op[]> {
  const { Renderer } = await import('./render')
  const { ctx, ops } = recordingCtx()
  const renderer = new Renderer({ getContext: () => ctx } as unknown as HTMLCanvasElement)
  const cam = new Camera()
  cam.resize(800, 500, 80)
  cam.follow(40, 0)
  ;(renderer as unknown as { drawVisionMask(w: WorldState, m: MapDefParsed, c: Camera): void })
    .drawVisionMask(worldAt(phase), map(unlockPhase), cam)
  return ops
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
    const ops = await visionOps(1, 2)
    // 第 0 个纯圆填充 = 锁区盘（原点圆心 + coreZone 半径）；视野圈仍是 evenodd 打孔。
    expect(discFill(ops, 0)).toEqual(CORE)
    expect(evenoddArc(ops, 0)).toEqual(VISION)
  })

  it('keeps the fog color token on the core-zone fill', async () => {
    const ops = await visionOps(1, 2)
    const styles = ops.filter(o => o.op === 'fillStyle').map(o => o.args[0])
    expect(styles).toContain('rgba(5, 9, 14, 0.78)')
  })

  it('does not cover the core zone once unlocked (phase >= unlock_phase)', async () => {
    const ops = await visionOps(2, 2)
    // 不再有纯圆锁区盘；只剩视野圈一块 evenodd。
    expect(discFill(ops, 0)).toBeUndefined()
    expect(evenoddArc(ops, 0)).toEqual(VISION)
    expect(evenoddArc(ops, 1)).toBeUndefined()
  })

  it('does not cover the core zone before the match starts (phase 0)', async () => {
    const ops = await visionOps(0, 2)
    expect(discFill(ops, 0)).toBeUndefined()
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
