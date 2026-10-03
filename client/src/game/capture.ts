// 手册资产截取页（仅本地 vite dev / capture 脚本使用，不进入生产构建路由）。
// 用与游戏完全相同的 draw* 函数与 SVG sprite 渲染 sprite sheet，供截图嵌入玩家文档。
import { artReady, drawArena, drawCover, drawRobot, drawCore, drawHealthPack, drawUplink, drawProjectile, drawVitals, ink } from './art'
import { Camera } from './camera'
import { drawIcon } from '../icons'
import type { MapDefParsed } from './mapdef'
import type { IconName } from '../icons'

// 与真实地图一致的极简 fixture：外环 80m、若干墙体，让 drawArena/drawCover 画真实结构。
function fixtureMap(): MapDefParsed {
  return {
    version: 1,
    generatorVer: 1,
    seed: 20260206,
    mapHash: 'capture01',
    walls: [
      { id: 1, min: { x: -2.5, y: -1 }, max: { x: -1.5, y: 1 } },
      { id: 2, min: { x: 1.5, y: -1 }, max: { x: 2.5, y: 1 } },
    ],
    sectors: [],
    uplinks: [{ id: 1, pos: { x: 0, y: 6 }, activePhase: 1 }],
    corePads: [
      { id: 1, pos: { x: -3, y: 0 }, value: 10 },
      { id: 2, pos: { x: 3, y: 0 }, value: 25, mega: true },
    ],
    healthPacks: [{ id: 1, pos: { x: 0, y: -6 } }],
    coreZone: { radius: 30, unlockPhase: 2 },
    extent: 80,
  } as unknown as MapDefParsed
}

function makeCamera(canvas: HTMLCanvasElement, cx: number, cy: number, scalePxPerM: number): Camera {
  // Camera 构造基于画布尺寸 + 地图 extent；截取页手动设 scale 后定位。
  const cam = new Camera()
  cam.resize(canvas.width, canvas.height, 80)
  cam.scale = scalePxPerM
  cam.cx = cx
  cam.cy = cy
  return cam
}

function cell(sheet: HTMLElement, label: string, w: number, h: number): { box: HTMLElement; canvas: HTMLCanvasElement } {
  const cellEl = document.createElement('div')
  cellEl.className = 'cell'
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const span = document.createElement('span')
  span.textContent = label
  cellEl.append(canvas, span)
  sheet.appendChild(cellEl)
  return { box: cellEl, canvas }
}

function row(sheet: HTMLElement): HTMLElement {
  const r = document.createElement('div')
  r.className = 'row'
  sheet.appendChild(r)
  return r
}

// ---------- 手册示意图（SVG，只用于截图）----------

const FG = '#d8dee9'
const DIM = '#8b98a9'
const LINE = '#1f2733'
const BG = '#0a0e14'
const PANEL = '#10141a'
const CYAN = '#22d3ee'
const LIME = '#a3e635'
const AMBER = '#fbbf24'
const STEEL = '#293e4c'

function svgEl(tag: string, attrs: Record<string, string | number> = {}, text?: string): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  if (text !== undefined) el.textContent = text
  return el
}

function diagram(slug: string, w: number, h: number): SVGSVGElement {
  const box = document.createElement('div')
  box.className = 'diagram'
  box.id = `diagram-${slug}`
  const s = svgEl('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` }) as SVGSVGElement
  box.append(s)
  document.getElementById('diagrams')!.append(box)
  return s
}

function dRect(s: SVGSVGElement, x: number, y: number, w: number, h: number, stroke = LINE, fill = PANEL): void {
  s.append(svgEl('rect', { x, y, width: w, height: h, fill, stroke, 'stroke-width': 1 }))
}

function dText(s: SVGSVGElement, x: number, y: number, text: string, cls = 'd-mono', anchor = 'start'): void {
  s.append(svgEl('text', { x, y, class: cls, 'text-anchor': anchor }, text))
}

function dArrow(s: SVGSVGElement, x1: number, y1: number, x2: number, y2: number, color = DIM): void {
  s.append(svgEl('line', { x1, y1, x2, y2, stroke: color, 'stroke-width': 1 }))
  const a = Math.atan2(y2 - y1, x2 - x1)
  const p1 = `${x2},${y2}`
  const p2 = `${x2 - 7 * Math.cos(a - 0.4)},${y2 - 7 * Math.sin(a - 0.4)}`
  const p3 = `${x2 - 7 * Math.cos(a + 0.4)},${y2 - 7 * Math.sin(a + 0.4)}`
  s.append(svgEl('polygon', { points: `${p1} ${p2} ${p3}`, fill: color }))
}

function diagramTimeline(): void {
  const s = diagram('timeline', 760, 200)
  dText(s, 0, 18, '一局 8 分钟：两段，一条边界', 'd-title')
  dRect(s, 0, 62, 380, 42, CYAN)
  dRect(s, 380, 62, 380, 42, AMBER)
  dText(s, 16, 88, 'OUTER_RING 外环争夺', 'd-strong')
  dText(s, 396, 88, 'CORE_OPEN 核心开放', 'd-strong')
  dText(s, 0, 54, '0:00', 'd-mono')
  dText(s, 380, 54, '4:00', 'd-mono', 'middle')
  dText(s, 760, 54, '8:00', 'd-mono', 'end')
  s.append(svgEl('line', { x1: 380, y1: 44, x2: 380, y2: 124, stroke: DIM, 'stroke-dasharray': '3 3' }))
  dText(s, 392, 40, '4:00 转段，只发生三件事', 'd-sub')
  dText(s, 392, 142, '· 中央区域解锁（半径 28m）', 'd-mono')
  dText(s, 392, 158, '· 主 Uplink 激活，值 +25', 'd-mono')
  dText(s, 392, 174, '· Core 刷新更密', 'd-mono')
  dText(s, 0, 190, '基础规则全程不变：伤害、能量、冷却、复活都不动。', 'd-sub')
}

function diagramMapRings(): void {
  const s = diagram('map-rings', 720, 720)
  const cx = 320
  const cy = 320
  const k = 3.5 // px per meter（80m → 280px）
  const P = (m: number, deg: number) => ({
    x: cx + m * k * Math.cos((deg * Math.PI) / 180),
    y: cy - m * k * Math.sin((deg * Math.PI) / 180),
  })
  s.append(svgEl('circle', { cx, cy, r: 80 * k, fill: BG, stroke: LINE }))
  s.append(svgEl('circle', { cx, cy, r: 55 * k, fill: PANEL, stroke: LINE }))
  s.append(svgEl('circle', { cx, cy, r: 28 * k, fill: '#fbbf2412', stroke: AMBER, 'stroke-dasharray': '4 4' }))

  // 8 个扇区：中心角 k*45°，界线在 22.5°+k*45°；出生方块 13×13m 轴对齐。
  for (let i = 0; i < 8; i++) {
    const a = 22.5 + i * 45
    const p1 = P(28, a)
    const p2 = P(80, a)
    s.append(svgEl('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke: LINE }))
    const c = P(67.5, i * 45)
    const side = 13 * k
    dRect(s, c.x - side / 2, c.y - side / 2, side, side, '#2c3a49', '#0d141c')
    const n = P(78, i * 45)
    dText(s, n.x, n.y + 4, String(i + 1), 'd-mono', 'middle')
  }

  // 中环 6 根 Uplink：22.5° 系列角，半径 40–45m。
  const uplinkAngles = [22.5, 67.5, 112.5, 202.5, 247.5, 292.5]
  const uplinkRadii = [40, 43, 45, 40, 43, 45]
  uplinkAngles.forEach((deg, i) => {
    const p = P(uplinkRadii[i]!, deg)
    s.append(svgEl('circle', { cx: p.x, cy: p.y, r: 6, fill: CYAN, stroke: BG }))
  })
  const legendUp = P(43, 67.5)
  dText(s, legendUp.x + 12, legendUp.y + 4, 'Uplink ×6（中环 40–45m）', 'd-mono')

  // 中央主 Uplink 与核心区。
  s.append(svgEl('circle', { cx, cy: cx, r: 12, fill: 'none', stroke: CYAN, 'stroke-dasharray': '3 3' }))
  s.append(svgEl('circle', { cx, cy: cx, r: 6, fill: CYAN }))
  dText(s, cx + 22, cy - 8, '主 Uplink', 'd-strong')
  dText(s, cx + 22, cy + 8, '+25 · 4:00 激活', 'd-mono')
  dText(s, cx - 88, cy + 12, '核心区 28m', 'd-warn')
  dText(s, cx - 88, cy + 28, '4:00 前锁死', 'd-warn')

  // 4 个固定血包点（半径 43m，对角方向）。
  ;[45, 135, 225, 315].forEach((deg) => {
    const p = P(43, deg)
    s.append(svgEl('rect', { x: p.x - 6, y: p.y - 2, width: 12, height: 4, fill: LIME }))
    s.append(svgEl('rect', { x: p.x - 2, y: p.y - 6, width: 4, height: 12, fill: LIME }))
  })
  const hp = P(43, 45)
  dText(s, hp.x + 12, hp.y - 8, '血包 ×4', 'd-mono')

  // 掩体：几段实体墙。
  const walls: Array<[number, number, number, number]> = [
    [58, 140, 34, 6],
    [520, 214, 6, 40],
    [150, 556, 60, 6],
    [120, 300, 6, 44],
  ]
  walls.forEach(([x, y, w, h]) => s.append(svgEl('rect', { x, y, width: w, height: h, fill: STEEL, stroke: BG })))
  dText(s, 96, 138, '掩体', 'd-mono')
  dText(s, 0, 680, '掩体挡人、挡子弹、挡视线；4:00 前的中央核心区同样挡人、挡视线。', 'd-sub')
  dText(s, 0, 700, '①–⑧ 是出生扇区，死亡后在所属扇区复活。', 'd-sub')
}

function diagramTickLoop(): void {
  const s = diagram('tick-loop', 760, 330)
  dText(s, 0, 18, '一帧的流水线，每秒重复 60 次', 'd-title')
  const items: Array<[number, number, string, string]> = [
    [0, 44, '第 T 帧', '服务器给你一份世界快照'],
    [270, 44, '你的 tick(bot)', '每帧最多算 10ms'],
    [540, 44, '表达意图', 'move / fire / dash / …'],
    [540, 176, '服务器裁定', '冷却、能量、护盾、距离'],
    [270, 176, '执行动作', '第 T+1 帧生效'],
    [0, 176, '下一帧', '再念一遍你的清单'],
  ]
  items.forEach(([x, y, title, sub]) => {
    dRect(s, x, y, 220, 56, LINE)
    dText(s, x + 12, y + 24, title, 'd-strong')
    dText(s, x + 12, y + 44, sub, 'd-mono')
  })
  dArrow(s, 222, 72, 266, 72)
  dArrow(s, 492, 72, 536, 72)
  dArrow(s, 650, 102, 650, 172)
  dArrow(s, 538, 204, 494, 204)
  dArrow(s, 268, 204, 224, 204)
  dArrow(s, 110, 172, 110, 104)
  dText(s, 0, 272, '没调用 = 中立，不延续上一帧；想持续开火、冲刺、举盾就每帧都调。', 'd-mono')
  dText(s, 0, 292, '超时 = 这一帧脚本动作作废，人的手操照常，下一帧恢复。', 'd-mono')
  dText(s, 0, 312, '一拍延迟：T 帧看到的世界，T+1 帧才动；到位判定留阈值，别写相等。', 'd-mono')
}

function diagramControlAxes(): void {
  const s = diagram('control-axes', 760, 400)
  dText(s, 0, 18, '四根控制轴：人一碰就抢，程序管不了', 'd-title')
  const axes = ['移动', '炮塔', '开火', '技能']
  axes.forEach((name, i) => {
    const y = 46 + i * 62
    dText(s, 0, y + 30, name, 'd-strong')
    dRect(s, 74, y, 150, 44, CYAN)
    dText(s, 149, y + 27, '你的键鼠', 'd-strong', 'middle')
    dRect(s, 244, y, 170, 44, LINE)
    dText(s, 329, y + 27, '脚本 / Snippet', 'd-mono', 'middle')
    dArrow(s, 226, y + 22, 240, y + 22, CYAN)
    dText(s, 233, y - 4, '碰一下', 'd-warn', 'middle')
    dArrow(s, 416, y + 22, 448, y + 22)
    dRect(s, 452, y, 170, 44, LINE, '#0d141c')
    dText(s, 537, y + 27, '最终控制', 'd-strong', 'middle')
  })
  dText(s, 0, 330, '人碰哪根轴，哪根轴立刻归人；脚本同 tick 的该轴指令自动失效，不需要配合。', 'd-mono')
  dText(s, 0, 350, '松手不自动归还；按 Space（或小键盘 Enter）把人工接管的轴一次交回脚本。', 'd-mono')
  dText(s, 0, 370, '没被碰的轴继续归脚本。人走位 + 程序瞄准能同时成立。', 'd-mono')
}

function diagramVision(): void {
  const s = diagram('vision', 720, 440)
  dText(s, 0, 18, '感知：看得见的和看不见的', 'd-title')
  const cx = 150
  const cy = 220
  const k = 4 // px per meter（20m → 80px）
  s.append(svgEl('circle', { cx, cy, r: 20 * k, fill: '#10141a', stroke: LINE }))
  s.append(svgEl('circle', { cx, cy, r: 20 * k, fill: 'none', stroke: CYAN, 'stroke-dasharray': '4 4' }))
  dText(s, cx + 88, cy - 66, '20m', 'd-num')
  dText(s, cx, cy + 4, '你', 'd-strong', 'middle')
  s.append(svgEl('circle', { cx, cy, r: 6, fill: CYAN }))
  // 实体墙：竖在机器人右侧，挡出一条看不见的通道
  s.append(svgEl('rect', { x: cx + 40, y: cy - 70, width: 12, height: 80, fill: STEEL, stroke: BG }))
  // 可见敌人（视线没被墙挡）
  const shownEnemies: Array<[number, number]> = [[-55, -45], [75, 45]]
  shownEnemies.forEach(([dx, dy]) => {
    s.append(svgEl('circle', { cx: cx + dx, cy: cy + dy, r: 5, fill: LIME }))
  })
  dText(s, cx - 48, cy + 34, '看得见', 'd-mono')
  // 被墙挡住的敌人：还在 20m 内，但视线穿过墙体
  s.append(svgEl('circle', { cx: cx + 58, cy: cy - 30, r: 5, fill: '#41505f' }))
  dText(s, cx + 72, cy - 26, '被墙挡：看不见', 'd-mono')
  // 圈外敌人
  s.append(svgEl('circle', { cx: cx - 135, cy: cy - 110, r: 5, fill: '#41505f' }))
  dText(s, cx - 120, cy - 106, '20m 外：看不见', 'd-mono')
  // 全图公开
  dText(s, 470, 70, '全图公开，不受视野限制', 'd-strong')
  ;['Core', 'Uplink', '血包', '墙体'].forEach((t, i) => {
    dRect(s, 470, 88 + i * 40, 220, 32, LINE)
    dText(s, 484, 108 + i * 40, t, 'd-mono')
    dText(s, 676, 108 + i * 40, '全图可见', 'd-sub', 'end')
  })
  dText(s, 470, 300, '看不见 ≠ 不存在', 'd-warn')
  dText(s, 470, 322, '机器人和炮弹：20m 内、不被墙挡才出现。', 'd-mono')
  dText(s, 470, 342, '脉冲扫描成功的那一帧，视野扩到 32m。', 'd-mono')
  dText(s, 0, 420, '自己永远看得见自己：血量、能量、位置、速度都在 bot.self 里。', 'd-sub')
}

function diagramUplinkLoop(): void {
  const s = diagram('uplink-loop', 760, 280)
  dText(s, 0, 18, 'Uplink：靠近 → 引导 → 得分 → 冷却', 'd-title')
  const steps: Array<[string, string]> = [
    ['靠近', '2.5m 内（主桩 3m）'],
    ['引导', '持续 8 秒'],
    ['得分', '+15（主桩 +25）'],
    ['个人冷却', '这根桩 30 秒'],
  ]
  steps.forEach(([title, sub], i) => {
    const x = i * 195
    dRect(s, x, 50, 175, 60, i === 3 ? AMBER : CYAN)
    dText(s, x + 14, 76, title, 'd-strong')
    dText(s, x + 14, 96, sub, 'd-mono')
    if (i < 3) dArrow(s, x + 177, 80, x + 191, 80)
  })
  dArrow(s, 672, 116, 672, 150, AMBER)
  dText(s, 664, 146, '30 秒后可再来', 'd-mono', 'end')
  s.append(svgEl('path', { d: 'M672 150 H100 V116', fill: 'none', stroke: AMBER, 'stroke-dasharray': '4 4' }))
  dArrow(s, 110, 152, 110, 116, AMBER)
  dRect(s, 200, 168, 360, 44, STEEL, '#0d141c')
  dText(s, 380, 195, '松手 / 出圈 / 开火 / 死亡 → 进度清零，不进冷却', 'd-mono', 'middle')
  dText(s, 0, 240, '挨打不打断：举盾顶住引导是合法战术，对面只能等你先开火或先撤。', 'd-mono')
  dText(s, 0, 260, '个人冷却按机器人、按桩分别记，跨死亡保留；成功事件不下发，脚本只能估算。', 'd-mono')
}

function diagramReadingPaths(): void {
  const s = diagram('reading-paths', 760, 360)
  dText(s, 0, 18, '两条读法：先走左边，想写代码再加右边', 'd-title')
  const col = (x: number, head: string, items: string[], accent: string) => {
    dRect(s, x, 40, 340, 40, accent)
    dText(s, x + 16, 66, head, 'd-strong')
    items.forEach((t, i) => {
      const y = 104 + i * 44
      dRect(s, x, y, 340, 34, LINE)
      dText(s, x + 16, y + 22, t, 'd-mono')
      if (i < items.length - 1) dArrow(s, x + 170, y + 36, x + 170, y + 42)
    })
  }
  col(0, '只想玩', ['进房前准备', '你的第一局', '游戏规则', '操作与控制仲裁', '（可选）Snippet 驾驶辅助 / AI Agent'], CYAN)
  col(410, '想写代码', ['进房前准备', '你的第一局', '写第一个 Bot', 'API 总览', '动作 / 便利层 / 数据结构 / 语义与陷阱'], LIME)
  dText(s, 0, 340, '两条线共用前两页。写代码卡住时，回左边补规则。', 'd-sub')
}

function renderDiagrams(): void {
  diagramTimeline()
  diagramMapRings()
  diagramTickLoop()
  diagramControlAxes()
  diagramVision()
  diagramUplinkLoop()
  diagramReadingPaths()
}

/** 逐枚图标导出为透明底 PNG（64×64，2× 于 HUD 的 16 网格）。 */
function exportIconDataURLs(names: readonly IconName[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = FG
    drawIcon(ctx, name, 32, 32, 64)
    out[name] = canvas.toDataURL('image/png')
  }
  return out
}

async function main() {
  await artReady
  const map = fixtureMap()
  const $ = (id: string) => document.getElementById(id)!

  // ---- 场地：外环全貌（墙 + 环 + 核心区）----
  {
    const sheet = $('sheet-arena')
    const r = row(sheet)
    const { canvas } = cell(r.parentElement === sheet ? sheet : sheet, '外环 80m · 墙体与环带', 760, 760)
    const ctx = canvas.getContext('2d')!
    const cam = new Camera()
    cam.resize(canvas.width, canvas.height, 80)
    drawArena(ctx, map, cam, 2)
    drawCover(ctx, map, cam)
  }

  // ---- 机器人与状态 ----
  {
    const sheet = $('sheet-robots')
    const r = row(sheet)
    const states: Array<[string, number]> = [
      ['本体（青）', 0], ['护盾激活', 1], ['冲刺中', 2], ['无敌帧', 3],
    ]
    for (const [label, mode] of states) {
      const { canvas } = cell(sheet, label, 220, 190)
      const ctx = canvas.getContext('2d')!
      const cam = makeCamera(canvas, 0, 0, 26)
      ctx.fillStyle = ink.floor
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      drawRobot(ctx, cam, 0, 0, 0, '#22d3ee', false, mode === 1, mode === 2, mode === 3, 0)
      drawVitals(ctx, cam, 0, 0, 7.5, 8, '示例', false)
    }
    // 阵亡重生倒计时
    const { canvas } = cell(sheet, '阵亡 · 重生倒计时', 220, 190)
    const ctx = canvas.getContext('2d')!
    const cam = makeCamera(canvas, 0, 0, 26)
    ctx.fillStyle = ink.floor
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#5f7889'
    ctx.font = '13px "Fusion Pixel", monospace'
    ctx.textAlign = 'center'
    ctx.fillText('3.2s', canvas.width / 2, canvas.height / 2)
  }

  // ---- 拾取物 ----
  {
    const sheet = $('sheet-pickups')
    row(sheet)
    {
      const { canvas } = cell(sheet, '血包 · 可拾取 (+)', 200, 200)
      const ctx = canvas.getContext('2d')!
      const cam = makeCamera(canvas, 0, 0, 30)
      ctx.fillStyle = ink.floor
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      drawHealthPack(ctx, cam, 0, 0, true, 0, 0)
    }
    {
      const { canvas } = cell(sheet, '血包 · 冷却（虚影）', 200, 200)
      const ctx = canvas.getContext('2d')!
      const cam = makeCamera(canvas, 0, 0, 30)
      ctx.fillStyle = ink.floor
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      drawHealthPack(ctx, cam, 0, 0, false, 8.5, 0)
    }
    {
      const { canvas } = cell(sheet, '普通核心 +10', 200, 200)
      const ctx = canvas.getContext('2d')!
      const cam = makeCamera(canvas, 0, 0, 30)
      ctx.fillStyle = ink.floor
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      drawCore(ctx, cam, 0, 0, false, 0)
    }
    {
      const { canvas } = cell(sheet, 'Mega 核心 +25', 200, 200)
      const ctx = canvas.getContext('2d')!
      const cam = makeCamera(canvas, 0, 0, 30)
      ctx.fillStyle = ink.floor
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      drawCore(ctx, cam, 0, 0, true, 0)
    }
    {
      const { canvas } = cell(sheet, 'Uplink · 待激活', 200, 200)
      const ctx = canvas.getContext('2d')!
      const cam = makeCamera(canvas, 0, 0, 30)
      ctx.fillStyle = ink.floor
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      drawUplink(ctx, cam, 0, 0, true, false, 0)
    }
    {
      const { canvas } = cell(sheet, 'Uplink · 破解中', 200, 200)
      const ctx = canvas.getContext('2d')!
      const cam = makeCamera(canvas, 0, 0, 30)
      ctx.fillStyle = ink.floor
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      drawUplink(ctx, cam, 0, 0, true, false, 48 / 80)
    }
  }

  // ---- 子弹：各队伍颜色 ----
  {
    const sheet = $('sheet-projectiles')
    row(sheet)
    const colors = ['#22d3ee', '#a3e635', '#f472b6', '#fbbf24', '#a78bfa', '#34d399', '#f97316', '#ff5c5c']
    const { canvas } = cell(sheet, '八色子弹（队伍色）', colors.length * 44 + 20, 110)
    const ctx = canvas.getContext('2d')!
    const cam = makeCamera(canvas, 0, 0, 30)
    ctx.fillStyle = ink.floor
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    colors.forEach((c, i) => drawProjectile(ctx, cam, -canvas.width / 60 + i * 1.5, 0, 0, c))
  }

  // ---- 常用图标 ----
  {
    const sheet = $('sheet-icons')
    row(sheet)
    const names = ['play', 'pause', 'book', 'code', 'spectator', 'replay', 'heart', 'energy', 'dash', 'shield', 'uplink', 'target', 'trophy', 'skull', 'fire', 'sound'] as const satisfies readonly IconName[]
    const { canvas } = cell(sheet, 'HUD / 控件图标（16 网格放大 2x）', names.length * 40 + 16, 56)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = ink.floor
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#d8dee9' // drawIcon 用当前 fillStyle 填充，不设就是底色画底色
    names.forEach((n, i) => {
      drawIcon(ctx, n, 28 + i * 40, 28, 32)
    })
  }

  // ---- 手册示意图 ----
  renderDiagrams()

  // ---- 图标导出（透明底 PNG，由捕获脚本解码写盘）----
  const exportNames = ['fire', 'shield', 'dash', 'uplink', 'heart', 'energy', 'skull', 'trophy', 'target', 'book', 'code', 'spectator', 'replay', 'play', 'pause', 'chevron'] as const satisfies readonly IconName[]
  ;(window as unknown as { __ombManualIcons: Record<string, string> }).__ombManualIcons = exportIconDataURLs(exportNames)

  document.documentElement.setAttribute('data-capture-ready', '1')
}

void main()
