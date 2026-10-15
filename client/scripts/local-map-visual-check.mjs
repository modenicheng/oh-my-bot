import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const base = process.env.OMB_CLIENT_URL || 'http://127.0.0.1:5173'
const artifacts = resolve(import.meta.dirname, '../../.artifacts/local-map')
mkdirSync(artifacts, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 750 }, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.route('**/__local-map-visual-check', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body></body></html>',
  }))
  await page.goto(`${base}/__local-map-visual-check`, { waitUntil: 'domcontentloaded' })
  const pixels = await page.evaluate(async () => {
    const [{ Renderer }, { Camera }, { emptyWorld }, { parseMapDef }, { artReady }] = await Promise.all([
      import('/src/game/render.ts'), import('/src/game/camera.ts'), import('/src/game/world.ts'),
      import('/src/game/mapdef.ts'), import('/src/game/art.ts'),
    ])
    await artReady
    document.body.replaceChildren()
    document.body.style.margin = '0'
    const canvas = document.createElement('canvas')
    canvas.width = 1200; canvas.height = 750
    document.body.append(canvas)
    const map = parseMapDef(JSON.stringify({ version: 1, partial: true,
      walls: [{ id: 1, min: { X: 146, Y: -3 }, max: { X: 146, Y: 3 } }],
    }))
    const camera = new Camera()
    camera.resize(1200, 750, map.extent)
    camera.follow(140, 0)
    const world = emptyWorld()
    world.tick = 600; world.phase = 1; world.initialized = true; world.visionRadius = 20
    world.self = { robotId: 1 }
    world.localMap = map
    world.robots.set(1, { base: { id: 1, pos: { x: 140, y: 0 }, heading: 0 }, hpX10: 1000,
      energyX10: 1000, color: '#22d3ee', nick: 'local vision', seenAt: 0 })
    new Renderer(canvas).render(world, map, camera, { bubbles: [] })
    const context = canvas.getContext('2d')
    const sample = (worldX, worldY) => Array.from(context.getImageData(
      Math.round(camera.toPxX(worldX)), Math.round(camera.toPxY(worldY)), 1, 1).data).slice(0, 3)
    return { floor: sample(137, 3), grid: sample(136, 3), wall: sample(146.1, 0), contactFloor: sample(145.8, 1),
      shadow: sample(150, 0), fog: sample(120.5, 11.5), cameraX: camera.cx }
  })
  assert.deepEqual(pixels.floor, [16, 27, 37])
  assert.notDeepEqual(pixels.grid, pixels.floor)
  assert.ok(pixels.wall[1] > pixels.floor[1] + 20, `wall invisible: ${JSON.stringify(pixels)}`)
  assert.deepEqual(pixels.contactFloor, pixels.floor)
  assert.deepEqual(pixels.shadow, [5, 9, 14])
  assert.deepEqual(pixels.fog, [5, 9, 14])
  assert.equal(pixels.cameraX, 140)
  await page.screenshot({ path: resolve(artifacts, 'local-terrain.png') })
  console.log(JSON.stringify(pixels))
  const checks = await page.evaluate(async () => {
    const [{ Renderer }, { Camera }, { emptyWorld }, { parseMapDef }, { GameFeedback }, { audio }] = await Promise.all([
      import('/src/game/render.ts'), import('/src/game/camera.ts'), import('/src/game/world.ts'), import('/src/game/mapdef.ts'),
      import('/src/game/feedback/index.ts'), import('/src/audio.ts'),
    ])
    const canvas = document.querySelector('canvas'), context = canvas.getContext('2d')
    const camera = new Camera(); camera.resize(1200, 750, Infinity); camera.follow(0, 0)
    const renderer = new Renderer(canvas), world = emptyWorld()
    world.tick = 600; world.phase = 1; world.initialized = true; world.visionRadius = 20; world.self = { robotId: 1 }
    world.robots.set(1, { base: { id: 1, pos: { x: 0, y: 0 }, heading: 0 }, hpX10: 1000, energyX10: 1000, color: '#22d3ee', nick: 'effects', seenAt: 0 })
    let map = parseMapDef(JSON.stringify({ partial: true, walls: [
      { min: { X: 5, Y: 4 }, max: { X: 5, Y: 10 } }, { min: { X: 5, Y: 4 }, max: { X: 12, Y: 4 } },
      { min: { X: -8, Y: -4 }, max: { X: -8, Y: 4 } }, { min: { X: -3, Y: -7 }, max: { X: 5, Y: -7 } },
    ] }))
    world.localMap = map
    const sample = (worldX, worldY) => Array.from(context.getImageData(Math.round(camera.toPxX(worldX)), Math.round(camera.toPxY(worldY)), 1, 1).data).slice(0, 3)
    renderer.render(world, map, camera, { bubbles: [] })
    const corners = { vertical: sample(5.1, 6.3), horizontal: sample(8.3, 4.1), left: sample(-8.1, 1.3), top: sample(1.3, -7.1), contact: sample(4.8, 6.3), hidden: sample(8, 7) }
    window.localWallShot = canvas.toDataURL()
    const boundaries = []
    for (const [kind, radius, observerX] of [['arena', 80, 77], ['lock', 28, 32]]) {
      const edges = []
      for (let index = -15; index < 15; index++) {
        const startAngle = index / 100, endAngle = (index + 1) / 100
        edges.push({ kind, start: { X: Math.cos(startAngle) * radius, Y: Math.sin(startAngle) * radius }, end: { X: Math.cos(endAngle) * radius, Y: Math.sin(endAngle) * radius } })
      }
      map = parseMapDef(JSON.stringify({ partial: true, boundaries: edges }))
      world.localMap = map; world.robots.get(1).base.pos.x = observerX; camera.follow(observerX, 0)
      renderer.render(world, map, camera, { bubbles: [] })
      boundaries.push({ kind, contact: sample(radius, 0), floor: sample(observerX, 3), hidden: sample(kind === 'arena' ? radius + 2 : radius - 2, 0) })
    }
    world.robots.get(1).base.pos.x = 0; camera.follow(0, 0)
    const played = [], messages = []
    audio.play = (...args) => played.push(args[0]); audio.setUplink = () => {}; audio.stopGame = () => {}
    const feedback = new GameFeedback(text => messages.push(text))
    const now = performance.now()
    Object.defineProperty(performance, 'now', { configurable: true, value: () => now })
    map = parseMapDef(JSON.stringify({ partial: true, core_zone: { radius: 0, unlock_phase: 2 }, walls: [{ min: { X: 6, Y: -3 }, max: { X: 6, Y: 3 } }] }))
    world.localMap = map
    const paint = () => renderer.render(world, map, camera, { bubbles: [], feedback })
    const image = () => context.getImageData(0, 0, canvas.width, canvas.height).data
    const difference = (before, after, centerX, centerY, radius = 80) => {
      const pixelX = Math.round(camera.toPxX(centerX)), pixelY = Math.round(camera.toPxY(centerY))
      let changed = 0
      for (let row = Math.max(0, pixelY - radius); row < Math.min(canvas.height, pixelY + radius); row++) {
        for (let column = Math.max(0, pixelX - radius); column < Math.min(canvas.width, pixelX + radius); column++) {
          const index = (row * canvas.width + column) * 4
          if (before[index] !== after[index] || before[index + 1] !== after[index + 1] || before[index + 2] !== after[index + 2]) changed++
        }
      }
      return changed
    }
    const results = []
    const events = [
      ['shot', { owner: 42, projectile: 99, at: { x: 3, y: -2 }, color: '#a78bfa' }],
      ['wallHit', { robot: 42, at: { x: 5.4, y: 0 }, impact: 8 }],
      ['projectileImpact', { projectile: 100, at: { x: 6, y: 1 }, color: '#fbbf24' }],
      ['projectileImpact', { projectile: 101, target: 1, at: { x: 2, y: 1 }, shield: true }],
      ['corePickup', { by: 1, coreId: 22, value: 10, at: { x: -3, y: 2 } }],
      ['pointDropPickup', { by: 1, dropId: 23, points: 2, at: { x: -4, y: -2 } }],
      ['heal', { by: 1, id: 7, healX10: 200, at: { x: -3, y: -3 } }],
      ['uplinkHack', { by: 1, uplinkId: 9, value: 15, at: { x: 1, y: 4 } }],
      ['kill', { killer: 1, victim: 42, at: { x: 3, y: 3 } }],
      ['projectileImpact', { projectile: 102, at: { x: 9, y: 0 }, color: '#ff00ff' }],
    ]
    for (const [kind, payload] of events) {
      feedback.reset(); played.length = 0; messages.length = 0; paint()
      const before = image()
      feedback.event({ tick: 601, kind: { case: kind, value: payload } }, world, map, true)
      paint()
      results.push({ kind, hidden: payload.at.x === 9, pixels: difference(before, image(), payload.at.x, payload.at.y), cues: [...played] })
    }
    feedback.reset()
    feedback.snapshot(world, map, { tick: 600, full: true }, true)
    paint(); const still = image()
    world.tick = 601; world.robots.get(1).dashing = true
    feedback.snapshot(world, map, { tick: 601 }, true)
    paint(); const dashPixels = difference(still, image(), 0, 0)
    world.robots.get(1).hpX10 = 200; world.tick = 602
    feedback.snapshot(world, map, { tick: 602 }, true)
    paint(); const screenLow = Array.from(context.getImageData(2, 200, 1, 1).data).slice(0, 3)
    world.phase = 2; world.tick = 603; played.length = 0
    feedback.snapshot(world, map, { tick: 603 }, true)
    const opening = played.includes('innerOpen')
    feedback.reset(); world.robots.get(1).dashing = false; world.robots.get(1).hpX10 = 1000
    for (const [kind, payload] of events.slice(0, -1)) feedback.event({ tick: 610, kind: { case: kind, value: payload } }, world, map, true)
    paint()
    return { corners, boundaries, results, dashPixels, screenLow, opening }
  })
  for (const key of ['vertical', 'horizontal', 'left', 'top']) assert.ok(checks.corners[key][1] > 40, `missing ${key} face`)
  assert.deepEqual(checks.corners.contact, pixels.floor)
  assert.deepEqual(checks.corners.hidden, pixels.fog)
  for (const boundary of checks.boundaries) {
    assert.ok(boundary.contact[1] > 60, `${boundary.kind} surface invisible`)
    assert.ok(boundary.floor[1] > pixels.fog[1])
    assert.deepEqual(boundary.hidden, pixels.fog)
  }
  for (const result of checks.results) assert.ok(result.hidden ? result.pixels === 0 : result.pixels > 8, JSON.stringify(result))
  assert.ok(checks.dashPixels > 30)
  assert.ok(checks.screenLow[0] > checks.screenLow[1], 'low health frame was swallowed by fog')
  assert.equal(checks.opening, true)
  await page.screenshot({ path: resolve(artifacts, 'local-effects.png') })
  const cornerData = await page.evaluate(() => window.localWallShot)
  writeFileSync(resolve(artifacts, 'local-corners.png'), Buffer.from(cornerData.split(',')[1], 'base64'))
  const complete = await page.evaluate(async () => {
    const [{ GameController }, { Renderer }, { Camera }, { emptyWorld }, { parseMapDef }, { GameFeedback }] = await Promise.all([
      import('/src/game/controls.ts'), import('/src/game/render.ts'), import('/src/game/camera.ts'),
      import('/src/game/world.ts'), import('/src/game/mapdef.ts'), import('/src/game/feedback/index.ts'),
    ])
    const canvas = document.querySelector('canvas'), context = canvas.getContext('2d')
    const terrain = parseMapDef(JSON.stringify({ version: 1, generator_ver: 8, arena_radius: 80,
      core_zone: { radius: 28, unlock_phase: 2 }, walls: [
        { id: 1, min: { X: 46, Y: -3 }, max: { X: 49, Y: 7 } },
        { id: 2, min: { X: 46, Y: 7 }, max: { X: 55, Y: 10 } },
        { id: 3, min: { X: 30, Y: -5 }, max: { X: 32, Y: 4 } },
        { id: 4, min: { X: 37, Y: -8 }, max: { X: 44, Y: -6 } },
      ], uplinks: [{ id: 10, pos: { X: 44, Y: 6 }, main: false, interact_r: 2.5, active_phase: 1 }],
    }))
    const local = { partial: true, core_zone: { unlock_phase: 2 }, walls: [
      { id: 1, min: { X: 46, Y: -3 }, max: { X: 46, Y: 7 } },
    ] }
    const world = emptyWorld(), camera = new Camera(), renderer = new Renderer(canvas)
    camera.resize(canvas.width, canvas.height, terrain.extent); camera.follow(40, 0)
    const feedback = new GameFeedback(() => {})
    const controller = Object.assign(Object.create(GameController.prototype), {
      map: terrain, world, cam: camera, feedback, active: true, ended: false,
      scores: { observe() {} }, input: { acknowledge() {} }, stage: { requestDraw() {} },
    })
    const snapshot = { tick: 600, baseTick: 0, full: true, phase: 1, timeLeftS: 480, ackSeq: 0,
      self: { robotId: 1 }, robots: [{ base: { id: 1, pos: { x: 40, y: 0 }, heading: 0 }, hpX10: 1000,
        energyX10: 1000, color: '#22d3ee', nick: 'full terrain', invulnS: 0 }],
      projectiles: [], cores: [], uplinks: [], healthPacks: [], pointDrops: [],
      robotGone: [], projectileGone: [], coreGone: [], uplinkGone: [], healthPackGone: [], pointDropGone: [],
      mapJson: JSON.stringify(local), visionRadius: 20,
    }
    controller.onMessage({ payload: { case: 'snapshot', value: snapshot } })
    const sample = (worldX, worldY) => Array.from(context.getImageData(
      Math.round(camera.toPxX(worldX)), Math.round(camera.toPxY(worldY)), 1, 1).data).slice(0, 3)
    const paint = extras => renderer.render(world, controller.map, camera, { bubbles: [], ...extras })
    const image = () => context.getImageData(0, 0, canvas.width, canvas.height).data
    const differences = (before, after) => after.reduce((count, value, index) => count + (value !== before[index] ? 1 : 0), 0)
    paint()
    const before = image()
    const colors = { floor: sample(37, 3), face: sample(46.15, 1.3), body: sample(47.5, 1.3),
      contact: sample(45.8, 1.3), shadow: sample(51, 0), fog: sample(59.5, 11.5) }
    controller.onMessage({ payload: { case: 'snapshot', value: { ...snapshot, tick: 601, baseTick: 600, full: false,
      mapJson: JSON.stringify({ ...local, walls: [] }), robots: [],
    } } })
    paint()
    const stablePixels = differences(before, image())
    window.completeTerrainShot = canvas.toDataURL()
    paint({ feedback }); const beforeContact = image()
    feedback.event({ tick: 602, kind: { case: 'wallHit', value: { robot: 42, at: { x: 46, y: 0 }, impact: 8 } } }, world, terrain, true)
    feedback.event({ tick: 602, kind: { case: 'projectileImpact', value: { projectile: 99, at: { x: 46, y: 1 }, color: '#fbbf24' } } }, world, terrain, true)
    paint({ feedback })
    const contactPixels = differences(beforeContact, image())
    feedback.reset()
    world.phase = 2; Object.assign(world.robots.get(1).base.pos, { x: 73, y: 30 }); camera.follow(73, 30); paint()
    const fence = { edge: sample(Math.sqrt(80 ** 2 - 30 ** 2), 30), floor: sample(72, 30), outside: sample(76, 30) }
    return { colors, stablePixels, contactPixels, fence, extent: camera.extent, retained: controller.map === terrain,
      local: world.localMap.partial, observedWalls: world.localMap.walls.length, observedUplinks: world.uplinks.size }
  })
  assert.equal(complete.retained, true, 'local snapshots replaced the bootstrap terrain')
  assert.equal(complete.extent, 80, 'local snapshots changed camera bounds')
  assert.equal(complete.local, true)
  assert.equal(complete.observedWalls, 0)
  assert.equal(complete.observedUplinks, 0)
  assert.equal(complete.stablePixels, 0, 'wall bodies changed with local wall segments')
  assert.ok(complete.colors.body[1] > complete.colors.floor[1] + 10, JSON.stringify(complete.colors))
  assert.ok(complete.colors.face[1] > complete.colors.floor[1] + 10, JSON.stringify(complete.colors))
  assert.ok(complete.colors.shadow[1] > 9 && complete.colors.fog[1] > 9, 'terrain was replaced by opaque black fog')
  assert.ok(complete.contactPixels > 30, 'full terrain swallowed authorized collision effects')
  assert.ok(complete.fence.edge[1] > complete.fence.floor[1] + 20, 'complete arena fence invisible')
  const terrainData = await page.evaluate(() => window.completeTerrainShot)
  writeFileSync(resolve(artifacts, 'full-terrain.png'), Buffer.from(terrainData.split(',')[1], 'base64'))
  await page.screenshot({ path: resolve(artifacts, 'full-arena-fence.png') })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify(checks))
  console.log(JSON.stringify(complete))
} finally {
  await browser.close()
}
