// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initObservability } from './runtime'
import { clearLogs, getLogs, setLogLevel } from './logger'

let cleanup: (() => void) | undefined

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  clearLogs()
  setLogLevel('info')
  vi.restoreAllMocks()
})

describe('runtime diagnostics', () => {
  it('installs once, captures errors and removes listeners on teardown', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setLogLevel('debug')
    cleanup = initObservability()
    expect(initObservability()).toBe(cleanup)
    window.dispatchEvent(new ErrorEvent('error', { message: 'broken', error: new Error('broken') }))
    const rejection = new Event('unhandledrejection')
    Object.defineProperty(rejection, 'reason', { value: new Error('rejected /ws?token=private-token') })
    window.dispatchEvent(rejection)
    expect(getLogs().filter(record => record.event === 'runtime.error')).toHaveLength(1)
    expect(getLogs().filter(record => record.event === 'runtime.unhandled_rejection')).toHaveLength(1)
    expect(window.ombDebug.export()).not.toContain('private-token')
    const size = getLogs().length
    cleanup()
    window.dispatchEvent(new ErrorEvent('error', { message: 'after cleanup' }))
    expect(getLogs()).toHaveLength(size)
  })

  it('captures resource errors and exposes runtime level controls', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    cleanup = initObservability()
    const image = document.createElement('img')
    image.src = '/missing.png?token=private-token'
    document.body.append(image)
    image.dispatchEvent(new Event('error'))
    image.remove()
    expect(getLogs().some(record => record.event === 'resource.failed')).toBe(true)
    expect(window.ombDebug.export()).not.toContain('private-token')
    window.ombDebug.setLevel('error')
    expect(window.ombDebug.getLevel()).toBe('error')
    window.ombDebug.clear()
    expect(window.ombDebug.logs()).toEqual([])
  })
})
