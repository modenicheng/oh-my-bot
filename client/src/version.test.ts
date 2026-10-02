import { afterEach, describe, expect, it, vi } from 'vitest'
import { appVersionLabel, initAppVersion } from './version'

afterEach(() => vi.unstubAllGlobals())

describe('appVersionLabel', () => {
  it('keeps dev as-is', () => {
    expect(appVersionLabel('dev')).toBe('dev')
  })

  it('adds v prefix to plain semver', () => {
    expect(appVersionLabel('0.1.0')).toBe('v0.1.0')
    expect(appVersionLabel('1.2.3')).toBe('v1.2.3')
  })

  it('does not double the v prefix on prerelease tags', () => {
    expect(appVersionLabel('v0.1.0-rc.1')).toBe('v0.1.0-rc.1')
  })

  it('falls back to dev for missing values', () => {
    expect(appVersionLabel(null)).toBe('dev')
    expect(appVersionLabel(undefined)).toBe('dev')
    expect(appVersionLabel('')).toBe('dev')
  })
})

describe('initAppVersion', () => {
  function stubFooter() {
    const footer = { textContent: 'dev' }
    vi.stubGlobal('document', { getElementById: () => footer })
    return footer
  }

  it('updates the footer only after the version request completes', async () => {
    const footer = stubFooter()
    let complete!: (response: unknown) => void
    const fetchVersion = vi.fn(() => new Promise(resolve => { complete = resolve }))
    vi.stubGlobal('fetch', fetchVersion)

    const pending = initAppVersion()
    expect(fetchVersion).toHaveBeenCalledWith('/api/version')
    expect(footer.textContent).toBe('dev')
    complete({ ok: true, json: async () => ({ version: 'v0.1.0-rc.1' }) })
    await pending
    expect(footer.textContent).toBe('v0.1.0-rc.1')
  })

  it.each([
    { name: 'HTTP failure', ok: false, payload: { version: '1.2.3' } },
    { name: 'invalid payload', ok: true, payload: { version: 123 } },
    { name: 'invalid JSON shape', ok: true, payload: null },
  ])('keeps dev on $name', async ({ ok, payload }) => {
    const footer = stubFooter()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok, json: async () => payload }))
    await initAppVersion()
    expect(footer.textContent).toBe('dev')
  })

  it('absorbs network failures without blocking startup', async () => {
    const footer = stubFooter()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(initAppVersion()).resolves.toBeUndefined()
    expect(footer.textContent).toBe('dev')
  })
})
