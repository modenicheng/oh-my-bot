// Unit tests for the shared check-script harness (C-2 first batch).
// Covers the exact behaviors the migrated *-check.mjs scripts relied on:
// sleep resolution, until polling/timeout semantics with the label in the
// error, pageErrors collection shape, and the static server's MIME lookup,
// SPA fallback, and traversal guard.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { sleep, until, pageErrors, startStaticServer } from './harness.mjs'

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
