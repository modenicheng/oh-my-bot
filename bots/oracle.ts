/**
 * Oracle —— 单文件作战脚本：定向路线规划 + 线性血量权重 + 二阶提前量火控。
 *
 * 三块能力：
 *  ① 路线规划：把 Core / Uplink / 血包统一抽象为带权节点，用「定向问题
 *     (Orienteering)」模型求一条"得分高、里程短"的路径——目标函数
 *     maximize Σ价值 − λ·里程（外加硬里程预算），节点 ≤ 9 个时用
 *     Held-Karp 状压 DP 精确求解，更多时按性价比预选再 DP。
 *  ② 血包权重：价值 = K·(1 − hp/MaxHP)，关于血量严格线性——满血恒 0
 *     不会误触发，血越低权重越高，自然压过普通的 Core/Uplink；
 *     hp < EMERGENCY_HP 时再叠加一层"直奔最近血包"的兜底。
 *  ③ 火控：恒加速度目标模型 X(τ) = P + V·τ + ½A·τ²，加速度由相邻帧
 *     速度差分 + EMA 平滑估计，飞行时间用不动点迭代解出，实现二阶提前
 *     量瞄准；开火前对预测弹道做墙体/锁区遮挡校验。
 *
 * 用法：编辑器 TS 模式整页粘贴提交，保持辅助（Assist）开启。
 * 全部可调参数集中在下方 CONFIG 区。
 */
import type { BotContext, HealthPackRef, Observation, RobotRef, Vec2, WallRef } from '@omb/bot-api'

// ============================== CONFIG ==============================

// ---- 路线规划 ----
const REPLAN_TICKS = 30 // 每 0.5s 重排路线
const LAMBDA = 0.25 // 「汇率」：每多走 1m，需要 ≥ 0.25 分才值得绕路
const MAX_ROUTE_M = 90 // 单条路线硬上限（米），防止规划出横穿全图的死路线
const MAX_DP_NODES = 9 // 进入精确 DP 的节点上限（超出按性价比预选）
const UPLINK_STAND_COST_M = 16 // 站桩 8s 折算里程（约半个 Core 的机会成本）
const CORE_ZONE_R = 28 // 锁区半径（mapgen coreZoneR；区内 = 主桩 / Mega Core）
const CORE_VALUE = 10
const MEGA_VALUE = 25
const UPLINK_VALUE = 15
const MAIN_UPLINK_VALUE = 25
/** GeneratorVer 6 的 Mega 垫 ID：垫按 外环→中环→中心 顺序编号（1..34），
 *  中心 6 垫中字典序最小的两个被赋 Value=25（generator.go 尾部赋值）。
 *  若 mapgen 版本变化导致编号漂移，此处按新规则调整即可。 */
const MEGA_PAD_IDS: Record<number, boolean> = { 29: true, 30: true }

// ---- 血包权重（线性，避免高血量提前触发）----
const K_HEALTH = 30 // v = K·(1 − hp/100)：hp100→0，hp50→15，hp0→30
const HEALTH_MIN_VALUE = 1.5 // 低于该权重的血包不进节点（hp ≥ 95 忽略）
const EMERGENCY_HP = 22 // 危急血量：无视路线直接奔最近可用血包

// ---- 站桩（Uplink 黑入）----
const HACK_DURATION_TICKS = 480 // 8s
const HACK_COOLDOWN_TICKS = 1800 // 完成后该桩 30s 个人冷却
const HACK_GRACE_TICKS = 45 // 中断断档 ≤ 此值视为连续（服务器 0.5s 宽限保留进度）
const HACK_BREAK_HP_LOSS = 18 // 站桩期间掉血超过此值 → 放弃去应付
const SELF_DEFENSE_R = 12 // 近敌自卫半径：站桩被逼近到此距离就打断开火
const BACKOFF_TICKS = 150 // 打断后 2.5s 内不再选这个桩

// ---- 火控 ----
const DT = 1 / 60
const BULLET_SPEED = 30 // m/s（ProjectileSpeed）
const FIRE_PIPELINE_TICKS = 1 // 脚本帧 T 的指令在 T+1 生效（服务器排队语义）
const FIRE_RANGE = 16 // ≤16m 无散布（accuracy falloff 从 16m 才开始）
const AIM_RANGE = 19 // 可见即预瞄；>16m 不开火
const PROJECTILE_RANGE = 20 // 子弹最大射程（预测点超出必空枪）
const MAX_INTERCEPT_S = 1.0 // 预计拦截时间超过 1s 不开火（提前量已不可信）
const FIRE_COST = 5
const FIRE_MIN_ENERGY = 15 // 远距离点射保留能量应急；近距点射不限
const ACC_EMA = 0.35 // 加速度 EMA 平滑系数
const MAX_ACC_EST = 30 // 加速度估计截断（服务器上限 24；滤 dash/撞击尖峰）

// ---- 通用 ----
const RESPAWN_INVULN_TICKS = 240 // 重生保护 4s：开火/交互会亲手打破保护，期间只走位
const MAX_HP = 100

// ============================== 类型 ==============================

export interface PlanNode {
  kind: 'core' | 'uplink' | 'health'
  id: number
  x: number
  y: number
  /** 进入该节点可获得的分数（血包为效用折算分） */
  value: number
  /** 进入节点的固定附加里程（Uplink 站桩时间折算） */
  extraCostM: number
  /** 判定"已到达"的半径 */
  reachR: number
}

interface RoutePlan {
  nodes: PlanNode[]
  /** solveRoute 返回的访问顺序（nodes 下标） */
  order: number[]
  idx: number
  builtAt: number
}

/** 敌方运动学状态：速度 + EMA 平滑后的加速度估计 */
interface Kin {
  vx: number
  vy: number
  ax: number
  ay: number
  lastTick: number
}

// ============================== 跨 tick 状态 ==============================

let lastObsTick = -1
let myId = 0
let prevHp = MAX_HP
let lastPhase: 'OUTER_RING' | 'CORE_OPEN' | null = null
let plan: RoutePlan | null = null
let hack: { uplinkId: number; progress: number; lastTick: number; startHp: number } | null = null
let respawnGuardUntil = -1
/** uplink id → 个人冷却到期 tick（API 不暴露 PersonalCDs，脚本侧自跟踪） */
const uplinkCd: Record<number, number> = {}
/** uplink id → 自卫/血线打断后的回避截止 tick */
const uplinkBackoff: Record<number, number> = {}
/** uplink id → { progress, atTick }：中断后服务器保留进度的保守记忆 */
const hackProgressMemory: Record<number, { progress: number; atTick: number }> = {}
/** 敌方 id → 运动学估计 */
const kin: Record<number, Kin> = {}

/** 测试与对局重开共用的状态清理 */
export function __resetState(): void {
  lastObsTick = -1
  myId = 0
  prevHp = MAX_HP
  lastPhase = null
  plan = null
  hack = null
  respawnGuardUntil = -1
  clearRecord(uplinkCd)
  clearRecord(uplinkBackoff)
  clearRecord(hackProgressMemory)
  clearRecord(kin)
}

function clearRecord(rec: Record<number, unknown>): void {
  for (const key of Object.keys(rec)) delete rec[Number(key)]
}

// ============================== 基础工具 ==============================

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by))
}

function distSelf(self: Vec2, x: number, y: number): number {
  return dist(self.x, self.y, x, y)
}

// ============================== ② 血包线性权重 ==============================

/**
 * 血包节点权重：关于 hp 严格线性递减，满血恒 0。
 * v = K·(1 − hp/MaxHP) ⇒ hp<67 才压过 Core(+10)、hp<50 压过 Uplink(+15)，
 * 高血量时永远不会挤占得分目标的优先级。
 */
export function healthWeight(hp: number): number {
  const frac = 1 - hp / MAX_HP
  if (frac <= 0) return 0
  return K_HEALTH * frac
}

// ============================== ① 节点构建 ==============================

export interface NodeBuildInput {
  self: Vec2
  selfId: number
  hp: number
  phase: 'OUTER_RING' | 'CORE_OPEN'
  tickNow: number
  obs: Observation
  /** uplink id → 个人冷却到期 tick */
  cdUntil: Record<number, number>
  /** uplink id → 打断回避截止 tick */
  backoff: Record<number, number>
}

/**
 * 把 Observation 抽象为带权节点集合：
 *  - Core：+10；Mega（中心垫 ID ∈ MEGA_PAD_IDS 且在锁区内）+25；锁区未开时
 *    不可达（服务器触碰无效），剔除。
 *  - Uplink：ready（激活且无人占用）才可选；主桩在原点（+25 / 交互半径 3m）；
 *    个人冷却中、自卫回避中的桩剔除；正在被自己占坑的桩保留（热替换续站）。
 *    站桩时间按 UPLINK_STAND_COST_M 计入固定附加里程。
 *  - 血包：available 且权重 ≥ HEALTH_MIN_VALUE，价值走 healthWeight 线性函数。
 */
export function buildNodes(input: NodeBuildInput): PlanNode[] {
  const nodes: PlanNode[] = []
  const { self, selfId, hp, phase, obs, tickNow, cdUntil, backoff } = input

  for (let i = 0; i < obs.cores.length; i++) {
    const c = obs.cores[i]
    const r = Math.sqrt(c.x * c.x + c.y * c.y)
    if (phase !== 'CORE_OPEN' && r < CORE_ZONE_R) continue // 锁区未开，中心 Core 触碰无效
    const mega = r < CORE_ZONE_R && MEGA_PAD_IDS[c.id] === true
    nodes.push({ kind: 'core', id: c.id, x: c.x, y: c.y, value: mega ? MEGA_VALUE : CORE_VALUE, extraCostM: 0, reachR: 1.5 })
  }

  for (let i = 0; i < obs.uplinks.length; i++) {
    const u = obs.uplinks[i]
    const heldByMe = u.holder !== undefined && u.holder === selfId
    if (!u.ready && !heldByMe) continue // 未激活（主桩等 CORE_OPEN）或正被他人占用
    if (cdUntil[u.id] !== undefined && tickNow < cdUntil[u.id]) continue // 个人冷却中
    if (backoff[u.id] !== undefined && tickNow < backoff[u.id]) continue // 自卫回避中
    const main = Math.sqrt(u.x * u.x + u.y * u.y) < 5 // 主桩固定在原点
    nodes.push({
      kind: 'uplink',
      id: u.id,
      x: u.x,
      y: u.y,
      value: main ? MAIN_UPLINK_VALUE : UPLINK_VALUE,
      extraCostM: UPLINK_STAND_COST_M,
      reachR: main ? 3 : 2.5,
    })
  }

  const hw = healthWeight(hp)
  if (hw >= HEALTH_MIN_VALUE) {
    for (let i = 0; i < obs.healthPacks.length; i++) {
      const p = obs.healthPacks[i]
      if (!p.available) continue
      nodes.push({ kind: 'health', id: p.id, x: p.x, y: p.y, value: hw, extraCostM: 0, reachR: 2 })
    }
  }
  return nodes
}

// ============================== ① 定向 DP 求解器 ==============================

/**
 * Orienteering 求解：从 self 出发，选一条节点访问序列，
 * maximize Σvalue − λ·(Σ里程 + Σ附加里程)，且总里程 ≤ MAX_ROUTE_M；
 * 同分取里程更短者。空路线（0 分）是合法基线。
 *
 * 节点数 ≤ MAX_DP_NODES 时为 Held-Karp 状压精确解：
 *   dp[mask][last] = 经过 mask 集合、停在 last 的最优目标值，
 *   复杂度 O(2ⁿ·n²)；n ≤ 9 时约 4 万次转移，goja 下仍在脚本预算内。
 * 超限时先按性价比 value/(dist+8) 预选出 MAX_DP_NODES 个再求解。
 *
 * @returns 访问顺序（原 nodes 数组的下标），空数组表示不值得出门。
 */
export function solveRoute(self: Vec2, nodes: PlanNode[]): number[] {
  const n = nodes.length
  if (n === 0) return []

  // ---- 性价比预选（超限时）----
  const sel: number[] = []
  if (n <= MAX_DP_NODES) {
    for (let i = 0; i < n; i++) sel.push(i)
  } else {
    const scored: { i: number; q: number }[] = []
    for (let i = 0; i < n; i++) {
      scored.push({ i, q: nodes[i].value / (distSelf(self, nodes[i].x, nodes[i].y) + 8) })
    }
    scored.sort((a, b) => b.q - a.q)
    for (let k = 0; k < MAX_DP_NODES; k++) sel.push(scored[k].i)
  }

  const K = sel.length
  const size = (1 << K) * K
  const NEG = -1e18
  const dp = new Array<number>(size).fill(NEG)
  const lenM = new Array<number>(size).fill(0)
  const par = new Array<number>(size).fill(-1)

  // 初始状态：self → 第一个节点
  for (let k = 0; k < K; k++) {
    const node = nodes[sel[k]]
    const d0 = distSelf(self, node.x, node.y) + node.extraCostM
    if (d0 > MAX_ROUTE_M) continue
    dp[(1 << k) * K + k] = node.value - LAMBDA * d0
    lenM[(1 << k) * K + k] = d0
  }

  let bestQ = 0 // 空路线基线：0 分 0 里程
  let bestMask = 0
  let bestLast = -1
  const qOf = (obj: number, L: number): number => obj - 1e-9 * L // 同分偏好更短

  for (let mask = 1; mask < 1 << K; mask++) {
    for (let last = 0; last < K; last++) {
      const cur = mask * K + last
      if (!(mask & (1 << last))) continue
      const obj = dp[cur]
      if (obj <= NEG / 2) continue
      const L = lenM[cur]
      const q = qOf(obj, L)
      if (q > bestQ) {
        bestQ = q
        bestMask = mask
        bestLast = last
      }
      for (let j = 0; j < K; j++) {
        if (mask & (1 << j)) continue
        const node = nodes[sel[j]]
        const step = dist(nodes[sel[last]].x, nodes[sel[last]].y, node.x, node.y) + node.extraCostM
        const nl = L + step
        if (nl > MAX_ROUTE_M) continue
        const nObj = obj + node.value - LAMBDA * step
        const nIdx = (mask | (1 << j)) * K + j
        if (nObj > dp[nIdx] + 1e-12) {
          dp[nIdx] = nObj
          lenM[nIdx] = nl
          par[nIdx] = last
        }
      }
    }
  }

  if (bestLast < 0) return []
  // 回溯重建路径
  const order: number[] = []
  let mask = bestMask
  let last = bestLast
  while (last >= 0) {
    order.push(sel[last])
    const p = par[mask * K + last]
    mask ^= 1 << last
    last = p
  }
  order.reverse()
  return order
}

// ============================== ③ 二阶提前量火控 ==============================

export interface LeadResult {
  angle: number
  /** 全拦截时间（含管线延迟），秒 */
  t: number
  /** 预测命中点 */
  px: number
  py: number
}

/**
 * 二阶提前量：目标按恒加速度模型运动 X(τ) = P + V·τ + ½A·τ²，
 * 子弹 τ0（管线延迟）后从 S = 自机预测位置射出，飞行 |X(τ)−S|/v_b。
 * 拦截时间满足 τ = τ0 + |X(τ)−S|/v_b，用不动点迭代（目标径向速度 < 弹速
 * 时收敛）解出，再取 atan2 得到射击角。
 */
export function leadAngle(
  sx: number, sy: number, svx: number, svy: number,
  tx: number, ty: number, tvx: number, tvy: number,
  ax: number, ay: number,
  pipeSec: number = FIRE_PIPELINE_TICKS * DT,
): LeadResult {
  const px0 = sx + svx * pipeSec
  const py0 = sy + svy * pipeSec
  let t = dist(px0, py0, tx, ty) / BULLET_SPEED
  let px = tx
  let py = ty
  for (let i = 0; i < 8; i++) {
    px = tx + tvx * t + 0.5 * ax * t * t
    py = ty + tvy * t + 0.5 * ay * t * t
    const tn = pipeSec + dist(px0, py0, px, py) / BULLET_SPEED
    if (Math.abs(tn - t) < 1e-6) {
      t = tn
      break
    }
    t = tn
    if (t > 3) {
      t = 3 // 无解/远离情形：钳制后由射程与拦截时长闸门拒射
      break
    }
  }
  px = tx + tvx * t + 0.5 * ax * t * t
  py = ty + tvy * t + 0.5 * ay * t * t
  return { angle: Math.atan2(py - py0, px - px0), t, px, py }
}

/** 线段与 AABB 相交（Liang-Barsky 裁剪），true = 弹道被该墙挡住 */
function segHitsRect(x0: number, y0: number, x1: number, y1: number, minX: number, minY: number, maxX: number, maxY: number): boolean {
  const dx = x1 - x0
  const dy = y1 - y0
  let t0 = 0
  let t1 = 1
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0
    const r = q / p
    if (p < 0) {
      if (r > t1) return false
      if (r > t0) t0 = r
    } else {
      if (r < t0) return false
      if (r < t1) t1 = r
    }
    return true
  }
  return clip(-dx, x0 - minX) && clip(dx, maxX - x0) && clip(-dy, y0 - minY) && clip(dy, maxY - y0)
}

/**
 * 弹道遮挡校验：预测弹道（自机 → 预测命中点）是否被墙或锁区挡住。
 * 服务器里子弹撞墙/撞锁区即消失，打保险枪只会浪费能量和开火间隔。
 */
export function shotBlocked(
  x0: number, y0: number, x1: number, y1: number,
  walls: readonly WallRef[], zoneLocked: boolean, zoneR: number,
): boolean {
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i]
    if (segHitsRect(x0, y0, x1, y1, w.min.x, w.min.y, w.max.x, w.max.y)) return true
  }
  if (zoneLocked) {
    // 与圆（锁区，圆心为原点）相交：端点在内或最近点距离 ≤ R
    const dx = x1 - x0
    const dy = y1 - y0
    const l2 = dx * dx + dy * dy
    let t = 0
    if (l2 > 1e-12) t = Math.max(0, Math.min(1, -(x0 * dx + y0 * dy) / l2))
    const cx = x0 + dx * t
    const cy = y0 + dy * t
    if (cx * cx + cy * cy <= zoneR * zoneR) return true
  }
  return false
}

/** 敌方运动学：速度差分 → 截断 → EMA；dash（速度 > 8.5）按匀速处理 */
function updateKinematics(obs: Observation, now: number): void {
  for (let i = 0; i < obs.robots.length; i++) {
    const r = obs.robots[i]
    const prev = kin[r.id]
    let ax = 0
    let ay = 0
    if (prev !== undefined && now === prev.lastTick + 1) {
      ax = (r.velocity.x - prev.vx) / DT
      ay = (r.velocity.y - prev.vy) / DT
      const m = Math.sqrt(ax * ax + ay * ay)
      if (m > MAX_ACC_EST) {
        ax *= MAX_ACC_EST / m
        ay *= MAX_ACC_EST / m
      }
      ax = prev.ax + ACC_EMA * (ax - prev.ax)
      ay = prev.ay + ACC_EMA * (ay - prev.ay)
    }
    const speed2 = r.velocity.x * r.velocity.x + r.velocity.y * r.velocity.y
    if (speed2 > 8.5 * 8.5) {
      ax = 0 // dash 期间匀速 16m/s，二阶项反而有害
      ay = 0
    }
    kin[r.id] = { vx: r.velocity.x, vy: r.velocity.y, ax, ay, lastTick: now }
  }
  if (now % 60 === 0) {
    for (const key of Object.keys(kin)) {
      const id = Number(key)
      if (now - kin[id].lastTick > 120) delete kin[id] // 丢失视野 2s 即遗忘
    }
  }
}

function findUplink(obs: Observation, id: number): { x: number; y: number; ready: boolean; holder?: number } | null {
  for (let i = 0; i < obs.uplinks.length; i++) {
    if (obs.uplinks[i].id === id) return obs.uplinks[i]
  }
  return null
}

function findCore(obs: Observation, id: number): boolean {
  for (let i = 0; i < obs.cores.length; i++) {
    if (obs.cores[i].id === id) return true
  }
  return false
}

function findPack(obs: Observation, id: number): HealthPackRef | null {
  for (let i = 0; i < obs.healthPacks.length; i++) {
    if (obs.healthPacks[i].id === id) return obs.healthPacks[i]
  }
  return null
}

function nearestEnemy(obs: Observation, self: Vec2): RobotRef | null {
  let best: RobotRef | null = null
  let bestD = Infinity
  for (let i = 0; i < obs.robots.length; i++) {
    const r = obs.robots[i]
    const d = distSelf(self, r.position.x, r.position.y)
    if (d < bestD) {
      bestD = d
      best = r
    }
  }
  return best
}

// ============================== 路线维护 ==============================

function rebuildPlan(self: Vec2, hp: number, phase: 'OUTER_RING' | 'CORE_OPEN', obs: Observation, now: number): void {
  const nodes = buildNodes({ self, selfId: myId, hp, phase, tickNow: now, obs, cdUntil: uplinkCd, backoff: uplinkBackoff })
  const order = solveRoute(self, nodes)
  plan = { nodes, order, idx: 0, builtAt: now }
}

function nodeStillValid(obs: Observation, node: PlanNode, now: number): boolean {
  if (node.kind === 'core') return findCore(obs, node.id)
  if (node.kind === 'health') {
    const pack = findPack(obs, node.id)
    return pack !== null && pack.available
  }
  const u = findUplink(obs, node.id)
  if (u === null) return false
  if (!u.ready && u.holder !== undefined && u.holder !== myId) return false // 被别人抢走占坑
  if (uplinkCd[node.id] !== undefined && now < uplinkCd[node.id]) return false
  if (uplinkBackoff[node.id] !== undefined && now < uplinkBackoff[node.id]) return false
  return true
}

/** 当前应前往的节点；必要时重建路线。无可规划节点返回 null。 */
function currentTarget(self: Vec2, hp: number, phase: 'OUTER_RING' | 'CORE_OPEN', obs: Observation, now: number): PlanNode | null {
  if (lastPhase !== phase) {
    lastPhase = phase
    plan = null // 阶段切换：锁区 Core / 主桩价值突变，立即重排
  }
  if (plan === null || now - plan.builtAt >= REPLAN_TICKS) rebuildPlan(self, hp, phase, obs, now)
  if (plan === null) return null
  while (plan.idx < plan.order.length) {
    const node = plan.nodes[plan.order[plan.idx]]
    if (nodeStillValid(obs, node, now)) return node
    plan.idx++ // 已被别人拿走/失效：跳到路线下一站
  }
  if (plan.builtAt < now) {
    // 路线在本 tick 之前建成且已走完：立即重排一次
    rebuildPlan(self, hp, phase, obs, now)
    if (plan !== null && plan.idx < plan.order.length) {
      const node = plan.nodes[plan.order[plan.idx]]
      if (nodeStillValid(obs, node, now)) return node
    }
  }
  return null
}

// ============================== 站桩（Uplink 黑入）维护 ==============================

function isMainUplink(x: number, y: number): boolean {
  return Math.sqrt(x * x + y * y) < 5 // 主桩固定在原点
}

/**
 * 开始于站桩（已在交互半径内）。起点进度参考中断记忆：服务器在中断后
 * 保留进度并按秒衰减，从「记忆进度 − 衰减估计」续跑，避免每次重站 8s。
 */
function startHack(node: PlanNode, selfHp: number, now: number): void {
  let begin = 0
  const mem = hackProgressMemory[node.id]
  if (mem !== undefined) {
    const overdue = now - mem.atTick - HACK_GRACE_TICKS
    const decayed = overdue > 0 ? overdue * 0.5 : 0 // 每秒衰减 30 ticks 进度 = 0.5/tick
    begin = Math.max(0, Math.floor(mem.progress - decayed))
  }
  hack = { uplinkId: node.id, progress: begin, lastTick: now, startHp: selfHp }
}

/**
 * 站桩 tick 维护：验证桩归属/距离/血线/近敌，推进本地进度。
 * 返回 true 表示本 tick 继续站桩（调用方发出 interact 后结束 tick）；
 * 返回 false 表示站桩结束（完成/放弃），已按需记账，常规流程接管。
 */
function maintainHack(self: Vec2, selfHp: number, obs: Observation, now: number, eDist: number): boolean {
  if (hack === null) return false
  const hid = hack.uplinkId
  const u = findUplink(obs, hid)
  if (u === null) {
    hack = null
    plan = null
    return false
  }
  const reach = isMainUplink(u.x, u.y) ? 3 : 2.5
  if (!u.ready && u.holder !== undefined && u.holder !== myId) {
    hack = null // 被别人抢走占坑；ready=false 已让重排自动避开
    plan = null
    return false
  }
  if (distSelf(self, u.x, u.y) > reach + 1) {
    // 被击退/漂出半径：服务器保留进度，记住进度走回去接着站
    hackProgressMemory[hid] = { progress: hack.progress, atTick: now }
    hack = null
    return false
  }
  if (selfHp < EMERGENCY_HP || selfHp < hack.startHp - HACK_BREAK_HP_LOSS) {
    // 血线告急：保命优先（应急血包 / 线性权重接管）
    hackProgressMemory[hid] = { progress: hack.progress, atTick: now }
    hack = null
    plan = null
    uplinkBackoff[hid] = now + BACKOFF_TICKS
    return false
  }
  if (eDist <= SELF_DEFENSE_R) {
    // 近敌自卫：先打后站（服务器有 0.5s 进度宽限）
    hackProgressMemory[hid] = { progress: hack.progress, atTick: now }
    hack = null
    plan = null
    uplinkBackoff[hid] = now + BACKOFF_TICKS
    return false
  }

  // 推进本地进度（容忍 ≤ HACK_GRACE_TICKS 的断档，视为连续站桩）
  const gap = now - hack.lastTick
  if (gap > HACK_GRACE_TICKS) hack.progress = 0
  else hack.progress += gap
  hack.lastTick = now

  if (hack.progress >= HACK_DURATION_TICKS) {
    // 完成一次黑入：记账 30s 个人冷却，立刻重排路线
    uplinkCd[hid] = now + HACK_COOLDOWN_TICKS
    delete hackProgressMemory[hid]
    hack = null
    plan = null
    return false
  }
  return true
}

// ============================== 火控执行 ==============================

function energyOk(energy: number, distM: number): boolean {
  if (energy < FIRE_COST) return false
  if (distM < 10) return true // 近距点射不限，保命要紧
  return energy >= FIRE_MIN_ENERGY
}

/** 瞄准（二阶提前量）；canFire 时再过射程/时长/遮挡/能量四道闸才开火 */
function aimWithLead(
  bot: BotContext, obs: Observation, self: Vec2, enemy: RobotRef, canFire: boolean,
): void {
  const k = kin[enemy.id]
  const ax = k !== undefined ? k.ax : 0
  const ay = k !== undefined ? k.ay : 0
  const sol = leadAngle(
    self.x, self.y, bot.self.velocity.x, bot.self.velocity.y,
    enemy.position.x, enemy.position.y, enemy.velocity.x, enemy.velocity.y,
    ax, ay,
  )
  bot.aimAt(sol.angle)
  if (!canFire) return
  const shotDist = dist(self.x, self.y, sol.px, sol.py)
  if (shotDist > FIRE_RANGE + 0.5) return // 命中点超出无散布区，命中率不经济
  if (sol.t > MAX_INTERCEPT_S) return
  if (shotDist > PROJECTILE_RANGE - 0.5) return // 预测点超出弹程
  const locked = bot.game.phase !== 'CORE_OPEN'
  if (shotBlocked(self.x, self.y, sol.px, sol.py, obs.walls, locked, CORE_ZONE_R)) return
  bot.fire()
}

// ============================== 执行器（tick 入口） ==============================

/** 无节点可规划的待机行为：CORE_OPEN 向中心压近蹲 Mega 刷新，否则原地等刷新 */
function idleWander(bot: BotContext, self: Vec2): void {
  if (bot.game.phase === 'CORE_OPEN') {
    const r = Math.sqrt(self.x * self.x + self.y * self.y)
    if (r > 26) {
      const scale = 22 / r
      bot.navigateTo({ x: self.x * scale, y: self.y * scale })
      return
    }
  }
  bot.move(0, 0)
}

export function tick(bot: BotContext): void {
  const obs = bot.scan()
  const self = bot.self
  const now = obs.tick

  // ---- 对局重开检测（tick 倒退 / 身份变化）：全量清状态 ----
  if (now < lastObsTick || (myId !== 0 && self.id !== myId)) __resetState()
  myId = self.id
  lastObsTick = now

  // ---- 死亡 / 重生 ----
  if (self.hp <= 0) {
    hack = null
    plan = null
    prevHp = 0
    return
  }
  if (prevHp <= 0) {
    // 刚重生：4s 保护期只走位（开火/交互都会亲手打破保护）
    respawnGuardUntil = now + RESPAWN_INVULN_TICKS
    hack = null
    plan = null
  }
  prevHp = self.hp

  updateKinematics(obs, now)

  const enemy = nearestEnemy(obs, self.position)
  const eDist = enemy !== null ? distSelf(self.position, enemy.position.x, enemy.position.y) : Infinity

  // ---- ① 站桩维护（进行中的黑入优先，期间不重排、不开火）----
  if (hack !== null && maintainHack(self.position, self.hp, obs, now, eDist)) {
    if (enemy !== null && eDist <= AIM_RANGE) {
      aimWithLead(bot, obs, self.position, enemy, false) // fire 意图会打断 canHack
    }
    bot.interact()
    bot.move(0, 0)
    return
  }

  // ---- ② 路线目标 ----
  const target = currentTarget(self.position, self.hp, bot.game.phase, obs, now)

  // ---- ③ 应急血包：危急血量无视路线直奔最近可用血包 ----
  let moveTarget: PlanNode | null = target
  if (self.hp < EMERGENCY_HP) {
    let bestPack: PlanNode | null = null
    let bestD = Infinity
    for (let i = 0; i < obs.healthPacks.length; i++) {
      const p = obs.healthPacks[i]
      if (!p.available) continue
      const d = distSelf(self.position, p.x, p.y)
      if (d < bestD) {
        bestD = d
        bestPack = { kind: 'health', id: p.id, x: p.x, y: p.y, value: healthWeight(self.hp), extraCostM: 0, reachR: 2 }
      }
    }
    if (bestPack !== null) moveTarget = bestPack
  }

  // ---- ④ 移动 / 开始站桩 ----
  let interacting = false
  if (moveTarget !== null) {
    const d = distSelf(self.position, moveTarget.x, moveTarget.y)
    if (moveTarget.kind === 'uplink' && d <= moveTarget.reachR && now >= respawnGuardUntil) {
      startHack(moveTarget, self.hp, now)
      hack!.progress += 1 // 起始 tick 已 interact，计 1
      bot.interact()
      interacting = true
      bot.move(0, 0)
    } else {
      bot.navigateTo({ x: moveTarget.x, y: moveTarget.y })
    }
  } else {
    idleWander(bot, self.position)
  }

  // ---- ⑤ 火控叠加 ----
  if (enemy !== null && eDist <= AIM_RANGE) {
    const canFire = !interacting && now >= respawnGuardUntil && energyOk(bot.self.energy, eDist)
    aimWithLead(bot, obs, self.position, enemy, canFire)
  }
}
