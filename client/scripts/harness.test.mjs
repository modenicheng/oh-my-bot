// Unit tests for the shared check-script harness (C-2 batches 1+2).
// Covers the exact behaviors the migrated *-check.mjs scripts relied on:
// sleep resolution, until polling/timeout semantics with the label in the
// error, pageErrors collection shape, the static server's MIME lookup,
// SPA fallback, and traversal guard; gen2MapJson's byte layout and key order
// (the fixtures must emit the exact JSON strings the scripts used to inline);
// the protocol frame constants re-export; and FixtureServer against a real
// http+ws upgrade (path guard, ping->pong, conns tracking, 0x03 framing,
// bcast, event helper).
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import WebSocket from 'ws'
import { toBinary, fromBinary } from '@bufbuild/protobuf'
import { ServerMsgSchema, EvRoomStateSchema } from '../../packages/protocol/src/index.ts'
import { sleep, until, pageErrors, startStaticServer, gen2MapJson, FixtureServer, frame } from './harness.mjs'

let servers = []
afterEach(() => { for (const s of servers) s.close(); servers = [] })

describe('sleep', () => {
  it('resolves after at least the requested delay', async () => {
    const start = Date.now()
    await sleep(60)
    expect(Date.now() - start).toBeGreaterThanOrEqual(50)
  })
})

describe('until', () => {
  it('returns as soon as the predicate is truthy', async () => {
    let n = 0
    await until(() => ++n >= 3, 'count to three')
    expect(n).toBe(3)
  })

  it('awaits async predicates', async () => {
    await until(async () => true, 'async predicate')
  })

  it('throws with the label when the timeout expires', async () => {
    await expect(until(() => false, 'never true', 130))
      .rejects.toThrow('Timed out: never true')
  })
})

describe('pageErrors', () => {
  it('collects pageerror events as strings', () => {
    const listeners = {}
    const fakePage = { on: (event, fn) => { listeners[event] = fn } }
    const errors = pageErrors(fakePage)
    listeners.pageerror(new Error('boom'))
    listeners.pageerror('raw string')
    expect(errors).toEqual(['Error: boom', 'raw string'])
  })
})

describe('startStaticServer', () => {
  it('serves files with the right MIME type and falls back to index.html', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'omb-harness-'))
    writeFileSync(join(dist, 'index.html'), '<html>spa</html>')
    writeFileSync(join(dist, 'app.js'), 'console.info(1)')
    servers.push(await startStaticServer(0, dist))
    const { address, port } = servers[0].address()
    const base = `http://127.0.0.1:${port}`
    const root = await fetch(base)
    expect(root.status).toBe(200)
    expect(root.headers.get('content-type')).toBe('text/html')
    expect(await root.text()).toBe('<html>spa</html>')
    const spaRoute = await fetch(`${base}/some/client/route`)
    expect(spaRoute.status).toBe(200)
    expect(spaRoute.headers.get('content-type')).toBe('text/html')
    const js = await fetch(`${base}/app.js`)
    expect(js.headers.get('content-type')).toBe('text/javascript')
    const unknown = await fetch(`${base}/unknown.bin`)
    expect(unknown.status).toBe(200)
    expect(unknown.headers.get('content-type')).toBe('text/html')
    expect(await unknown.text()).toBe('<html>spa</html>')
    rmSync(dist, { recursive: true, force: true })
  })

  it('404s decoded traversal outside dist', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'omb-harness-p-'))
    const dist = join(parent, 'dist')
    mkdirSync(dist)
    writeFileSync(join(parent, 'secret.txt'), 'nope')
    writeFileSync(join(dist, 'index.html'), 'ok')
    servers.push(await startStaticServer(0, dist))
    const { port } = servers[0].address()
    // fetch()/Node http normalize '/%2e%2e/' client-side (it would hit the SPA
    // fallback); '/%2e%2e%2f' reaches the server raw so the decodeURIComponent +
    // startsWith(dist) guard is what's actually tested.
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/%2e%2e%2fsecret.txt' }, res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(404)
    rmSync(parent, { recursive: true, force: true })
  })
})

describe('gen2MapJson', () => {
  it('emits the exact byte string the pickup/capture fixtures inlined (default layout)', () => {
    expect(gen2MapJson('pickup01')).toBe(JSON.stringify({
      version: 1,
      generator_ver: 2,
      seed: 20260206,
      map_hash: 'pickup01',
      walls: [
        { id: 1, min: { X: -66, Y: -60 }, max: { X: -58, Y: 60 } },
        { id: 2, min: { X: 58, Y: -60 }, max: { X: 66, Y: 60 } },
      ],
      sectors: [
        { id: 1, spawn_area: { Min: { X: -50, Y: -40 }, Max: { X: -35, Y: -25 } }, center: { X: -42, Y: -32 } },
        { id: 2, spawn_area: { Min: { X: 35, Y: 25 }, Max: { X: 50, Y: 40 } }, center: { X: 42, Y: 32 } },
      ],
      uplinks: [{ id: 900, pos: { X: 40, Y: 0 }, main: false, interact_r: 2.5, active_phase: 1 }],
      core_pads: [{ id: 1, pos: { X: -2.4, Y: 0 }, group: 0, value: 10 }],
      health_packs: [{ id: 7, pos: { X: 2.2, Y: 0 } }],
      core_zone: { radius: 30, unlock_phase: 2 },
    }))
  })

  it('preserves the top-level key order the fixtures relied on', () => {
    // JSON.stringify key order is insertion order: pin it so a reorder here can
    // never silently change the bytes mapBootstrap carries.
    expect(Object.keys(JSON.parse(gen2MapJson('pickup01')))).toEqual([
      'version', 'generator_ver', 'seed', 'map_hash', 'walls', 'sectors',
      'uplinks', 'core_pads', 'health_packs', 'core_zone',
    ])
  })

  it('applies shallow overrides without touching the shared skeleton', () => {
    const base = JSON.parse(gen2MapJson('x'))
    const moved = JSON.parse(gen2MapJson('y', { uplink: { id: 1, pos: { X: 0, Y: 6 }, main: false, interact_r: 2.5, active_phase: 1 } }))
    expect(moved.uplinks).toEqual([{ id: 1, pos: { X: 0, Y: 6 }, main: false, interact_r: 2.5, active_phase: 1 }])
    expect(moved.core_pads).toEqual(base.core_pads)
    expect(moved.health_packs).toEqual(base.health_packs)
    expect(moved.walls).toEqual(base.walls)
    expect(moved.sectors).toEqual(base.sectors)
    expect(moved.map_hash).toBe('y')
  })
})

describe('frame', () => {
  it('re-exports the protocol transport frame bytes', () => {
    // Values are pinned on both sides by packages/protocol/test/golden.test.ts
    // <-> server netws/handler_test.go; the harness must not fork them.
    expect(frame).toEqual({ ping: 0x00, pong: 0x01, up: 0x02, down: 0x03 })
  })
})

describe('FixtureServer', () => {
  it('mounts /ws on a real http server, tracks conns, answers ping with pong', async () => {
    const server = http.createServer((req, res) => { res.writeHead(200); res.end('ui') })
    servers.push(server)
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const fix = new FixtureServer()
    fix.attach(server)
    const { port } = server.address()

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const frames = []
    ws.on('message', data => frames.push(Buffer.from(data)))
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
    ws.send(Buffer.from([frame.ping]))
    await until(() => frames.length >= 1, 'pong frame')
    expect(frames[0]).toEqual(Buffer.from([frame.pong]))
    expect(fix.conns.size).toBe(1)
    ws.close()
    await until(() => fix.conns.size === 0, 'conn removed on close')
    fix.wss.close()
  })

  it('destroys upgrades to non-/ws paths', async () => {
    const server = http.createServer((req, res) => { res.writeHead(200); res.end() })
    servers.push(server)
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const fix = new FixtureServer()
    fix.attach(server)
    const { port } = server.address()

    await expect(new Promise(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/other`)
      ws.once('open', () => resolve('opened'))
      ws.once('error', () => resolve('rejected'))
      ws.once('unexpected-response', () => resolve('rejected'))
    })).resolves.toBe('rejected')
    expect(fix.conns.size).toBe(0)
    fix.wss.close()
  })

  it('sends/bcasts 0x03-framed protobuf ServerMsg and builds events', async () => {
    const server = http.createServer((req, res) => { res.writeHead(200); res.end() })
    servers.push(server)
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const { port } = server.address()

    class EchoFixture extends FixtureServer {
      onFrame(conn, buf) {
        super.onFrame(conn, buf) // keep ping->pong
        if (buf[0] === frame.up && buf[1] === 0x7b) {
          this.bcast(this.event('roomState', EvRoomStateSchema, { state: 2, robotsOnline: 3, hostNick: 't' }, 42))
        }
      }
    }
    const fix = new EchoFixture()
    fix.attach(server)

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const frames = []
    ws.on('message', data => frames.push(Buffer.from(data)))
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
    // 0x02 | protobuf body starting with byte 0x7b triggers the subclass send
    ws.send(Buffer.concat([Buffer.from([frame.up, 0x7b])]))
    await until(() => frames.some(f => f[0] === frame.down), '0x03-framed event')
    const down = frames.find(f => f[0] === frame.down)
    expect(down.length).toBeGreaterThan(1)
    const msg = fromBinary(ServerMsgSchema, down.subarray(1))
    expect(msg.payload.case).toBe('event')
    expect(msg.payload.value.tick).toBe(42)
    expect(msg.payload.value.kind.case).toBe('roomState')
    expect(msg.payload.value.kind.value.robotsOnline).toBe(3)

    // inherited helpers produce the same framing; non-open conns are skipped
    const direct = fix.event('roomState', EvRoomStateSchema, { state: 1, robotsOnline: 1, hostNick: 'd' }, 7)
    const bytes = Buffer.concat([Buffer.from([frame.down]), toBinary(ServerMsgSchema, direct)])
    expect(bytes[0]).toBe(frame.down)
    fix.send({ ws: { readyState: 3 } }, direct) // readyState!==OPEN must not throw
    ws.close()
    fix.wss.close()
  })
})
