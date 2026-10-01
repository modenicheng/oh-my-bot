// 手册资产截取页（仅本地 vite dev / capture 脚本使用，不进入生产构建路由）。
// 用与游戏完全相同的 draw* 函数与 SVG sprite 渲染 sprite sheet，供截图嵌入玩家文档。
import { artReady, drawArena, drawCover, drawRobot, drawCore, drawHealthPack, drawUplink, drawProjectile, drawVitals, ink } from './art'
import { Camera } from './camera'
import { drawIcon } from '../icons'
import type { MapDefParsed } from './mapdef'

// 与真实地图一致的极简 fixture：外环 80m、若干墙体，让 drawArena/drawCover 画真实结构。
function fixtureMap(): MapDefParsed {
  return {
    version: 1,
    generatorVer: 1,
    seed: 20260206,
    mapHash: 'capture01',
    walls: [
      { id: 1, rect: { min: { x: -2.5, y: -1 }, max: { x: -1.5, y: 1 } } },
      { id: 2, rect: { min: { x: 1.5, y: -1 }, max: { x: 2.5, y: 1 } } },
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
    const names = ['play', 'pause', 'book', 'code', 'spectator', 'replay', 'heart', 'energy', 'dash', 'shield', 'uplink', 'target', 'trophy', 'skull', 'fire', 'sound'] as const
    const { canvas } = cell(sheet, 'HUD / 控件图标（16 网格放大 2x）', names.length * 40 + 16, 56)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = ink.floor
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    names.forEach((n, i) => {
      drawIcon(ctx, n, 28 + i * 40, 28, 32)
    })
  }

  document.documentElement.setAttribute('data-capture-ready', '1')
}

void main()
