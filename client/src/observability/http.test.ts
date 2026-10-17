import { afterEach, describe, expect, it, vi } from 'vitest'
import { observedFetch } from './http'
import { setLogLevel } from './logger'

afterEach(() => {
  setLogLevel('info')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('observedFetch', () => {
  it('preserves options, correlates errors and returns the original response without consuming it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const response = new Response('missing', { status: 404, headers: { 'X-Request-ID': 'server-request-123' } })
    const fetch = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetch)
    expect(await observedFetch('/api/replay/example?token=hidden', { cache: 'no-store', headers: { 'X-Custom': 'keep' } })).toBe(response)
    const options = fetch.mock.calls[0]![1] as RequestInit
    const headers = new Headers(options.headers)
    expect(headers.get('X-Request-ID')).toBeTruthy()
    expect(headers.get('X-Custom')).toBe('keep')
    expect(options.cache).toBe('no-store')
    expect(response.bodyUsed).toBe(false)
    expect(JSON.stringify(warn.mock.calls)).toContain('server-request-123')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('hidden')
  })

  it('logs network failures and rethrows the original error', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new TypeError('network failed')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error))
    await expect(observedFetch('/api/manual')).rejects.toBe(error)
    expect(errorLog).toHaveBeenCalledOnce()
    expect(JSON.stringify(errorLog.mock.calls)).toContain('request_id')
  })

  it('does not add correlation headers to cross-origin requests', async () => {
    const response = new Response('ok')
    const fetch = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('location', { origin: 'https://app.example' })
    vi.stubGlobal('fetch', fetch)
    await observedFetch('https://external.example/public')
    const options = fetch.mock.calls[0]![1] as RequestInit
    expect(new Headers(options.headers).has('X-Request-ID')).toBe(false)
  })

  it('treats an intentional abort as debug rather than an error', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const controller = new AbortController()
    controller.abort()
    const error = new DOMException('cancelled', 'AbortError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error))
    await expect(observedFetch('/api/manual', { signal: controller.signal })).rejects.toBe(error)
    expect(errorLog).not.toHaveBeenCalled()
  })
})
