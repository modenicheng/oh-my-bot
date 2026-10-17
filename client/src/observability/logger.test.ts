import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearLogs, createLogger, getLogLevel, getLogs, parseLogLevel, setLogLevel } from './logger'

afterEach(() => {
  setLogLevel('info')
  vi.restoreAllMocks()
})

describe('application logger', () => {
  it('filters all methods and supports changing the level at runtime', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logger = createLogger('test')
    setLogLevel('warn')
    logger.debug('hidden')
    logger.warn('visible')
    expect(debug).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    setLogLevel('debug')
    logger.debug('enabled')
    expect(debug).toHaveBeenCalledOnce()
    setLogLevel('off')
    logger.error('hidden')
    expect(error).not.toHaveBeenCalled()
    expect(() => setLogLevel('verbose' as 'info')).toThrow()
    expect(getLogLevel()).toBe('off')
  })

  it('snapshots bounded context and redacts nested credentials, URLs and error messages', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setLogLevel('debug')
    const recursive: Record<string, unknown> = { access_token: 'hidden-access' }
    recursive.self = recursive
    createLogger('http').warn('request.failed', {
      url: 'https://user:password@example.test/ws?token=hidden-token&room=ABCD#hidden-fragment',
      authorization: 'Bearer hidden-auth',
      nested: recursive,
      error: new Error('failed /auth/callback?code=hidden-code&state=hidden-state'),
    })
    const output = JSON.stringify(warn.mock.calls)
    expect(output).not.toMatch(/hidden-(access|token|auth|code|state|fragment)/)
    expect(output).not.toContain('user:password')
    expect(output).toContain('request.failed')
    expect(output).toContain('http')
    expect(output).toContain('REDACTED')
  })

  it('bounds the ring buffer and exports detached snapshots', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    setLogLevel('info')
    clearLogs()
    const fields = { nested: { value: 'initial' } }
    const log = createLogger('bounded')
    for (let i = 0; i < 205; i += 1) log.info(`event.${i}`, fields)
    fields.nested.value = 'changed'
    const records = getLogs()
    expect(records).toHaveLength(200)
    expect(records[0]?.event).toBe('event.5')
    expect(records[0]?.nested).toEqual({ value: 'initial' })
    records[0]!.event = 'mutated export'
    expect(getLogs()[0]?.event).toBe('event.5')
  })

  it('parses only supported levels', () => {
    expect(parseLogLevel(' DEBUG ')).toBe('debug')
    expect(parseLogLevel('warning')).toBeUndefined()
    expect(parseLogLevel('__proto__')).toBeUndefined()
    expect(parseLogLevel(null)).toBeUndefined()
  })
})
