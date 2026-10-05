// Shared harness helpers for the browser check scripts (client/scripts/*-check.mjs).
//
// C-2 extraction batches. Batch 1: helpers whose local copies were byte-identical
// across the migrated scripts (sleep/until/pageErrors/startStaticServer).
// Batch 2: gen2MapJson (the byte-identical gen2 minimal map builder), FixtureServer
// (the byte-identical conns/attach/onWs/send/event skeleton from the dist-fixture
// scripts) and re-exports of the protocol frame constants — still only pieces the
// migrated scripts shared verbatim. Anything with per-script semantics (server
// spawn, per-script state machine, audio/editor instrumentation, teardown policy)
// stays local on purpose.
import http from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { WebSocketServer } from 'ws'
import { create, toBinary } from '@bufbuild/protobuf'
import { ServerMsgSchema, ServerEventSchema, frame } from '../../packages/protocol/src/index.ts'

// Single source of the frame byte values the WS fixtures speak (0x00 ping /
// 0x01 pong / 0x02 up / 0x03 down). Re-exported from @omb/protocol's `frame`
// const so the fixtures can never drift from the client transport constants.
export { frame }

export const sleep = ms => new Promise(r => setTimeout(r, ms))

// Identical copy previously lived in round2 / game-feel / pickup-visual:
// 10s default timeout, 50ms poll, throws on timeout with the given label.
export async function until(fn, label, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await sleep(50) }
  throw new Error(`Timed out: ${label}`)
}

// Collect page errors the migrated scripts all asserted the same way.
export function pageErrors(page) {
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  return errors
}

// Static SPA server for the dist-based fixture checks (game-feel, pickup-visual):
// serves DIST over plain HTTP, falls back to index.html, 404s path traversal.
// Byte-identical to the startHttp() previously duplicated in both scripts.
export function startStaticServer(port, dist) {
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' }
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (p === '/' || !existsSync(join(dist, p))) p = '/index.html'
    const file = join(dist, p)
    if (!existsSync(file) || !file.startsWith(dist)) { res.writeHead(404); res.end('not found'); return }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)))
}

// The gen2 minimal valid map the dist-fixture scripts (game-feel / pickup-visual /
// capture-manual) all embedded verbatim: walls non-empty but far away and never
// blocking, two spawn sectors, one uplink at (40, 0), one core pad at (-2.4, 0),
// one health pack at (2.2, 0), core zone. Vec2/Rect use Go-style uppercase keys
// (mapdef.ts accepts both cases). Only map_hash differs per script; game-feel
// additionally moves the uplink next to self and the pad/health pack out of the
// way, via the shallow `over` overrides — everything else must stay byte-identical,
// which is why this returns the exact JSON string the scripts used to inline.
export function gen2MapJson(mapHash, over = {}) {
  return JSON.stringify({
    version: 1,
    generator_ver: 2,
    seed: 20260206,
    map_hash: mapHash,
    walls: [
      { id: 1, min: { X: -66, Y: -60 }, max: { X: -58, Y: 60 } },
      { id: 2, min: { X: 58, Y: -60 }, max: { X: 66, Y: 60 } },
    ],
    sectors: [
      { id: 1, spawn_area: { Min: { X: -50, Y: -40 }, Max: { X: -35, Y: -25 } }, center: { X: -42, Y: -32 } },
      { id: 2, spawn_area: { Min: { X: 35, Y: 25 }, Max: { X: 50, Y: 40 } }, center: { X: 42, Y: 32 } },
    ],
    uplinks: [over.uplink ?? { id: 900, pos: { X: 40, Y: 0 }, main: false, interact_r: 2.5, active_phase: 1 }],
    core_pads: [over.corePad ?? { id: 1, pos: { X: -2.4, Y: 0 }, group: 0, value: 10 }],
    health_packs: [over.healthPack ?? { id: 7, pos: { X: 2.2, Y: 0 } }],
    core_zone: { radius: 30, unlock_phase: 2 },
  })
}

// Byte-identical skeleton of the WS fixtures the dist-fixture scripts carried:
// connection tracking, /ws upgrade mounting, ping->pong answering, and 0x03
// protobuf ServerMsg/event framing. Subclasses own their state machine (what a
// join accepts, what a snapshot carries) via onFrame/accept overrides.
export class FixtureServer {
  constructor() {
    this.conns = new Set()
  }

  attach(server) {
    const wss = new WebSocketServer({ noServer: true })
    this.wss = wss
    server.on('upgrade', (req, sock, head) => {
      const { pathname } = new URL(req.url, 'http://localhost')
      if (pathname !== '/ws') { sock.destroy(); return }
      wss.handleUpgrade(req, sock, head, ws => this.onWs(ws))
    })
  }

  onWs(ws) {
    const conn = { ws, joined: false }
    this.conns.add(conn)
    ws.on('message', data => this.onFrame(conn, Buffer.from(data)))
    ws.on('close', () => this.conns.delete(conn))
    ws.on('error', () => {})
  }

  /** subclasses override to decode 0x02 ClientMsg frames; base answers ping only */
  onFrame(conn, buf) {
    if (buf[0] === frame.ping) { conn.ws.send(Buffer.from([frame.pong])); return } // ping -> pong (net.ts watchdog)
  }

  send(conn, msg) { if (conn.ws.readyState === 1) conn.ws.send(Buffer.concat([Buffer.from([frame.down]), toBinary(ServerMsgSchema, msg)])) }
  bcast(msg) { for (const c of this.conns) this.send(c, msg) }

  event(kindCase, schema, val, tick = 0) {
    return create(ServerMsgSchema, { payload: { case: 'event', value: create(ServerEventSchema, { tick, kind: { case: kindCase, value: create(schema, val) } }) } })
  }
}
