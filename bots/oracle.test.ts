import { describe, expect, it, beforeEach } from 'vitest'
import type { BotContext, Observation, Vec2, WallRef } from '@omb/bot-api'
import { __resetState, buildNodes, healthWeight, leadAngle, shotBlocked, solveRoute, tick } from './oracle'
import type { NodeBuildInput, PlanNode } from './oracle'

function node(kind: PlanNode['kind'], id: number, x: number, y: number, value: number, extraCostM = 0, reachR = 2): PlanNode {
  return { kind, id, x, y, value, extraCostM, reachR }
}

const SELF: Vec2 = { x: 0, y: 0 }

describe('healthWeight —— 线性血量权重', () => {
  it('满血为 0，不会提前触发', () => {
    expect(healthWeight(100)).toBe(0)
    expect(healthWeight(120)).toBe(0)
  })
  it('随血量线性递增，hp=50 时恰好等于 Uplink 分值 15', () => {
    expect(healthWeight(50)).toBeCloseTo(15, 10)
    expect(healthWeight(0)).toBeCloseTo(30, 10)
    expect(healthWeight(80)).toBeCloseTo(6, 10)
  })
  it('线性性：等血量区间权重增量相等', () => {
    const a = healthWeight(90) - healthWeight(80)
    const b = healthWeight(50) - healthWeight(40)
    expect(a).toBeCloseTo(b, 10)
  })
})

describe('buildNodes —— 节点抽象', () => {
  const base: NodeBuildInput = {
    self: SELF,
    selfId: 7,
    hp: 100,
    phase: 'OUTER_RING',
    tickNow: 1000,
    obs: frame({ tick: 1000 }),
    cdUntil: {},
    backoff: {},
  }
  function input(over: Partial<NodeBuildInput>): NodeBuildInput {
    return { ...base, ...over }
  }

  it('外环 Core 正常入图，锁区 Core 在 OUTER_RING 被剔除', () => {
    const obs = frame({
      tick: 1000,
      cores: [ { id: 5, x: 40, y: 0 }, { id: 6, x: 12, y: 0 } ],
    })
    const nodes = buildNodes(input({ obs }))
    expect(nodes).toHaveLength(1)
    expect(nodes[0].kind).toBe('core')
    expect(nodes[0].value).toBe(10)
  })

  it('Mega Core：仅中心垫 ID 29/30 记 25 分，其余中心垫仍 10 分', () => {
    const obs = frame({
      tick: 1000,
      cores: [ { id: 29, x: 12, y: 0 }, { id: 30, x: -12, y: 0 }, { id: 31, x: 0, y: 12 } ],
    })
    const nodes = buildNodes(input({ obs, phase: 'CORE_OPEN' }))
    expect(nodes).toHaveLength(3)
    expect(nodes[0].value).toBe(25)
    expect(nodes[1].value).toBe(25)
    expect(nodes[2].value).toBe(10)
  })

  it('Uplink：ready 才可选；原点为主桩（25 分、半径 3）；冷却/回避中剔除；被自己占坑保留', () => {
    const obs = frame({
      tick: 1000,
      uplinks: [
        { id: 1, x: 40, y: 0, ready: true },
        { id: 2, x: -40, y: 0, ready: false },
        { id: 3, x: 0, y: 40, ready: true },
        { id: 4, x: 0, y: -40, ready: true },
        { id: 5, x: 0, y: 0, ready: false, holder: 7 },
      ],
    })
    // id 3 冷却中、id 4 回避中 → 只剩 id 1 与被自己占着的 id 5
    const nodes = buildNodes(input({
      obs,
      phase: 'CORE_OPEN',
      cdUntil: { 3: 2000 },
      backoff: { 4: 2000 },
    }))
    expect(nodes.map(n => n.id).sort()).toEqual([1, 5])
    const main = nodes.find(n => n.id === 5)
    expect(main?.value).toBe(25)
    expect(main?.reachR).toBe(3)
    const normal = nodes.find(n => n.id === 1)
    expect(normal?.value).toBe(15)
    expect(normal?.extraCostM).toBeGreaterThan(0) // 站桩时间折算里程
  })

  it('血包：低血量才入图且权重随血量降低而升高；不可用的剔除', () => {
    const obs = frame({
      tick: 1000,
      healthPacks: [
        { id: 1, x: 10, y: 0, available: true, respawnInS: 0 },
        { id: 2, x: -10, y: 0, available: false, respawnInS: 12 },
      ],
    })
    expect(buildNodes(input({ obs, hp: 100 }))).toHaveLength(0) // 满血不触发
    const low = buildNodes(input({ obs, hp: 40 }))
    expect(low).toHaveLength(1)
    expect(low[0].value).toBeCloseTo(18, 10) // K·(1−0.4) = 18
    const lower = buildNodes(input({ obs, hp: 10 }))
    expect(lower[0].value).toBeCloseTo(27, 10)
  })
})

describe('solveRoute —— 定向 DP', () => {
  it('空节点 → 空路线', () => {
    expect(solveRoute(SELF, [])).toEqual([])
  })
  it('单个近处 Core 值得一趟', () => {
    const order = solveRoute(SELF, [node('core', 1, 20, 0, 10)])
    expect(order).toEqual([0])
  })
  it('超预算的远节点被放弃（空路线优于长途）', () => {
    const order = solveRoute(SELF, [node('core', 1, 400, 0, 10)])
    expect(order).toEqual([])
  })
  it('顺路串联两个节点优于只去一个', () => {
    // 20m 处 +10，再顺路 20m 又一个 +10：总 20 − 0.25·40 = 10 > 单独 10 − 5 = 5
    const order = solveRoute(SELF, [node('core', 1, 20, 0, 10), node('core', 2, 40, 0, 10)])
    expect(order).toEqual([0, 1])
  })
  it('访问顺序影响里程时选更短的顺序', () => {
    // P=(10,0) Q=(10,30)：P→Q 里程 40（目标值 20−10=10）；Q→P 里程 61.6（目标值 4.6）
    const order = solveRoute(SELF, [node('core', 1, 10, 0, 10), node('core', 2, 10, 30, 10)])
    expect(order).toEqual([0, 1])
  })
  it('λ 汇率：太远的 Uplink（含站桩折算）不划算', () => {
    // 30m：15 − 0.25·(30+16) = 3.5 > 0 → 去
    expect(solveRoute(SELF, [node('uplink', 1, 30, 0, 15, 16, 2.5)])).toEqual([0])
    // 60m：15 − 0.25·76 < 0 → 不去
    expect(solveRoute(SELF, [node('uplink', 1, 60, 0, 15, 16, 2.5)])).toEqual([])
  })
  it('血包权重足够高时压过 Core', () => {
    // hp=40 时血包 v=18；Core 20m 处 v=10
    const order = solveRoute(SELF, [node('core', 1, 20, 0, 10), node('health', 2, 8, 0, 18)])
    expect(order).toEqual([1, 0]) // 先血包再顺路 Core
  })
  it('节点超限时按性价比预选，且不重复不越界', () => {
    const nodes: PlanNode[] = []
    for (let i = 0; i < 14; i++) {
      nodes.push(node('core', i + 1, 10 + i * 4, (i % 2) * 8, 10))
    }
    const order = solveRoute(SELF, nodes)
    expect(order.length).toBeLessThanOrEqual(9)
    expect(new Set(order).size).toBe(order.length)
    order.forEach(i => expect(i).toBeGreaterThanOrEqual(0))
    order.forEach(i => expect(i).toBeLessThan(14))
  })
})

describe('leadAngle —— 二阶提前量', () => {
  it('静止目标：直指目标，t = 距离/弹速', () => {
    const r = leadAngle(0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0)
    expect(r.angle).toBeCloseTo(0, 12)
    expect(r.t).toBeCloseTo(10 / 30, 12)
    expect(r.px).toBeCloseTo(10, 12)
  })
  it('管线延迟：出膛点随自机速度前移', () => {
    const pipe = 1 / 60
    const r = leadAngle(0, 0, 8, 0, 10, 0, 0, 0, 0, 0, pipe)
    expect(r.angle).toBeCloseTo(0, 12)
    expect(r.t).toBeCloseTo(pipe + (10 - 8 * pipe) / 30, 12)
  })
  it('匀速横移目标：与解析解一致（一阶提前量）', () => {
    // 目标 12m 外以 (0,8) 匀速移动，弹速 30，τ0=1/60：
    // 由 |P+Vt| = 30(t−τ0) 展开整理得 836t² − 30t − 143.75 = 0
    const tau0 = 1 / 60
    const a = 836
    const b = -1800 * tau0
    const c = 900 * tau0 * tau0 - 144
    const t = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a)
    const expected = Math.atan2(8 * t, 12)
    const r = leadAngle(0, 0, 0, 0, 12, 0, 0, 8, 0, 0)
    expect(r.angle).toBeCloseTo(expected, 3)
    expect(r.py).toBeGreaterThan(0) // 预瞄点在目标移动方向前方
  })
  it('加速目标：二阶项生效，与数值求根一致', () => {
    // 目标 (16,0)、V=(0,8)、A=(0,24)：拦截方程 √(256+(8t+12t²)²) = 30t
    const f = (t: number): number => Math.sqrt(256 + (8 * t + 12 * t * t) ** 2) - 30 * t
    let lo = 0.3
    let hi = 1.2
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2
      if (f(mid) > 0) lo = mid
      else hi = mid
    }
    const t = (lo + hi) / 2
    const expected = Math.atan2(8 * t + 12 * t * t, 16)
    const r = leadAngle(0, 0, 0, 0, 16, 0, 0, 8, 0, 24, 0)
    expect(r.angle).toBeCloseTo(expected, 3)
    // 二阶项显著改变瞄准点（相对一阶解偏移大于 1m）
    const firstOrder = leadAngle(0, 0, 0, 0, 16, 0, 0, 8, 0, 0, 0)
    expect(Math.abs(r.py - firstOrder.py)).toBeGreaterThan(1)
  })
})

describe('shotBlocked —— 弹道遮挡', () => {
  const wall: WallRef = { id: 1, min: { x: 4, y: -1 }, max: { x: 5, y: 1 } }
  it('墙挡住弹道', () => {
    expect(shotBlocked(0, 0, 10, 0, [wall], false, 28)).toBe(true)
  })
  it('绕开墙的弹道通畅', () => {
    expect(shotBlocked(0, 5, 10, 5, [wall], false, 28)).toBe(false)
  })
  it('锁区未开时穿越中心的弹道被挡，CORE_OPEN 后通畅', () => {
    expect(shotBlocked(40, 0, 20, 0, [], true, 28)).toBe(true)
    expect(shotBlocked(40, 0, 35, 0, [], true, 28)).toBe(false)
    expect(shotBlocked(40, 0, 20, 0, [], false, 28)).toBe(false)
  })
})

// ============================== tick 集成 ==============================

interface BotState {
  obs: Observation
  self: { id: number; hp: number; energy: number; position: Vec2; velocity: Vec2 }
  phase: 'OUTER_RING' | 'CORE_OPEN'
}

function makeBot(state: BotState) {
  const calls = {
    moves: [] as Vec2[],
    navs: [] as Vec2[],
    aims: [] as number[],
    fires: 0,
    interacts: 0,
  }
  const bot = {
    get self() {
      return state.self
    },
    get game() {
      return { time: state.obs.tick / 60, timeLeft: 100, phase: state.phase, mapSeed: 1 }
    },
    scan: () => state.obs,
    move: (vx: number, vy: number) => calls.moves.push({ x: vx, y: vy }),
    navigateTo: (p: Vec2) => calls.navs.push({ x: p.x, y: p.y }),
    aimAt: (arg: number | { id: number }) => {
      if (typeof arg === 'number') calls.aims.push(arg)
    },
    fire: () => {
      calls.fires++
    },
    dash: () => undefined,
    shield: () => undefined,
    interact: () => {
      calls.interacts++
    },
    say: () => undefined,
    moveTo: () => undefined,
    nearestEnemy: () => null,
    nearestCore: () => null,
    nearestUplink: () => null,
    pulseScan: () => state.obs,
  } as unknown as BotContext
  return { bot, calls }
}

function frame(over: Partial<Observation> & { tick: number }): Observation {
  return {
    robots: over.robots ?? [],
    cores: over.cores ?? [],
    uplinks: over.uplinks ?? [],
    projectiles: over.projectiles ?? [],
    healthPacks: over.healthPacks ?? [],
    walls: over.walls ?? [],
    tick: over.tick,
  }
}

const baseSelf = { id: 7, hp: 100, energy: 100, position: { x: 0, y: 0 } as Vec2, velocity: { x: 0, y: 0 } as Vec2 }

function runTicks(state: BotState, bot: BotContext, n: number): void {
  for (let i = 0; i < n; i++) {
    state.obs = { ...state.obs, tick: state.obs.tick + 1 }
    tick(bot)
  }
}

describe('tick —— 执行器', () => {
  beforeEach(() => __resetState())

  it('有 Core 时导航前往', () => {
    const state: BotState = {
      obs: frame({ tick: 1, cores: [{ id: 1, x: 40, y: 0 }] }),
      self: { ...baseSelf, position: { x: 60, y: 0 } },
      phase: 'OUTER_RING',
    }
    const { bot, calls } = makeBot(state)
    tick(bot)
    expect(calls.navs).toHaveLength(1)
    expect(calls.navs[0].x).toBeCloseTo(40, 6)
    expect(calls.navs[0].y).toBeCloseTo(0, 6)
  })

  it('可见横移敌人：开火且瞄准为提前量解（不是直指）', () => {
    const state: BotState = {
      obs: frame({
        tick: 1,
        robots: [{ id: 3, position: { x: 52, y: 0 }, hp: 80, velocity: { x: 0, y: 8 } }],
      }),
      self: { ...baseSelf, position: { x: 40, y: 0 } },
      phase: 'OUTER_RING',
    }
    const { bot, calls } = makeBot(state)
    tick(bot)
    expect(calls.fires).toBe(1)
    expect(calls.aims).toHaveLength(1)
    const direct = Math.atan2(0, 12)
    expect(calls.aims[0]).toBeGreaterThan(direct + 0.05) // 明显往移动方向抬
    // 与解析解一致（相对几何与纯函数测试相同：12m 间距 + (0,8) 横移）
    const tau0 = 1 / 60
    const a = 836
    const b = -1800 * tau0
    const c = 900 * tau0 * tau0 - 144
    const t = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a)
    expect(calls.aims[0]).toBeCloseTo(Math.atan2(8 * t, 12), 3)
  })

  it('墙后敌人：预瞄但不浪费子弹', () => {
    const state: BotState = {
      obs: frame({
        tick: 1,
        robots: [{ id: 3, position: { x: 52, y: 0 }, hp: 80, velocity: { x: 0, y: 0 } }],
        walls: [{ id: 1, min: { x: 45, y: -2 }, max: { x: 46, y: 2 } }],
      }),
      self: { ...baseSelf, position: { x: 40, y: 0 } },
      phase: 'OUTER_RING',
    }
    const { bot, calls } = makeBot(state)
    tick(bot)
    expect(calls.aims).toHaveLength(1)
    expect(calls.fires).toBe(0)
  })

  it('站桩：持续 interact、不开火、不移动；远敌只预瞄', () => {
    const state: BotState = {
      obs: frame({
        tick: 1,
        uplinks: [{ id: 1, x: 5, y: 0, ready: true }],
        robots: [{ id: 3, position: { x: 18, y: 0 }, hp: 80, velocity: { x: 0, y: 0 } }],
      }),
      self: { ...baseSelf, position: { x: 4, y: 0 } },
      phase: 'OUTER_RING',
    }
    const { bot, calls } = makeBot(state)
    tick(bot) // 起始站桩 tick
    expect(calls.interacts).toBe(1)
    expect(calls.fires).toBe(0)
    expect(calls.aims).toHaveLength(1) // 预瞄但不打
    runTicks(state, bot, 100)
    expect(calls.interacts).toBe(101) // 每 tick 一次
    expect(calls.fires).toBe(0)
    expect(calls.moves[calls.moves.length - 1]).toEqual({ x: 0, y: 0 }) // 原地站定
  })

  it('黑入完成：约 480 tick 后停止 interact 并进入 30s 冷却（不再选该桩）', () => {
    const state: BotState = {
      obs: frame({ tick: 1, uplinks: [{ id: 1, x: 5, y: 0, ready: true }] }),
      self: { ...baseSelf, position: { x: 4, y: 0 } },
      phase: 'OUTER_RING',
    }
    const { bot, calls } = makeBot(state)
    runTicks(state, bot, 600)
    expect(calls.interacts).toBeGreaterThanOrEqual(470)
    expect(calls.interacts).toBeLessThanOrEqual(485)
    const after = calls.interacts
    runTicks(state, bot, 60)
    expect(calls.interacts).toBe(after) // 冷却中不再站桩
  })

  it('站桩中血线危急：打断并直奔最近血包', () => {
    const state: BotState = {
      obs: frame({
        tick: 1,
        uplinks: [{ id: 1, x: 5, y: 0, ready: true }],
        healthPacks: [{ id: 9, x: 8, y: 0, available: true, respawnInS: 0 }],
      }),
      self: { ...baseSelf, position: { x: 4, y: 0 }, hp: 30 },
      phase: 'OUTER_RING',
    }
    const { bot, calls } = makeBot(state)
    tick(bot) // 开始站桩
    expect(calls.interacts).toBe(1)
    state.self.hp = 20 // 跌破危急线
    runTicks(state, bot, 3)
    expect(calls.interacts).toBe(1) // 站桩已打断
    expect(calls.navs.length).toBeGreaterThan(0)
    const lastNav = calls.navs[calls.navs.length - 1]
    expect(lastNav.x).toBeCloseTo(8, 6) // 直奔血包
    expect(lastNav.y).toBeCloseTo(0, 6)
  })

  it('重生保护期：预瞄但不开火，保护结束后恢复开火', () => {
    const state: BotState = {
      obs: frame({
        tick: 1,
        robots: [{ id: 3, position: { x: 50, y: 0 }, hp: 80, velocity: { x: 0, y: 0 } }],
      }),
      self: { ...baseSelf, position: { x: 40, y: 0 }, hp: 0 },
      phase: 'OUTER_RING',
    }
    const { bot, calls } = makeBot(state)
    tick(bot) // 死亡帧
    expect(calls.fires).toBe(0)
    state.self.hp = 100
    tick(bot) // 重生帧：设置保护
    expect(calls.aims.length).toBeGreaterThan(0)
    expect(calls.fires).toBe(0)
    runTicks(state, bot, 245) // 保护 240 ticks 过后
    expect(calls.fires).toBeGreaterThan(0)
  })

  it('对局重开（tick 倒退）：状态重置，冷却中的桩可重新站', () => {
    const state: BotState = {
      obs: frame({ tick: 1, uplinks: [{ id: 1, x: 5, y: 0, ready: true }] }),
      self: { ...baseSelf, position: { x: 4, y: 0 } },
      phase: 'OUTER_RING',
    }
    const { bot, calls } = makeBot(state)
    runTicks(state, bot, 600) // 完成一次黑入，桩进入冷却
    const after = calls.interacts
    runTicks(state, bot, 30)
    expect(calls.interacts).toBe(after)
    state.obs = { ...state.obs, tick: 1 } // 新对局开始（下一 tick 检测到倒退）
    runTicks(state, bot, 10)
    expect(calls.interacts).toBeGreaterThan(after) // 冷却被清空，重新开始站桩
  })
})
