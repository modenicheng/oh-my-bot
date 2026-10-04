// Shared harness helpers for the browser check scripts (client/scripts/*-check.mjs).
//
// C-2 first extraction batch: ONLY helpers whose local copies were byte-identical
// across the migrated scripts. Anything with per-script semantics (server spawn,
// WS frame decoding, fixtures, map JSON) stays local on purpose.
import http from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

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
