import { describe, expect, it } from 'vitest'
import { isOptionsEscape, nextFocusIndex, type OptionsKey } from './options'

const escape = (patch: Partial<OptionsKey> = {}): OptionsKey => ({
  code: 'Escape', repeat: false, isComposing: false, keyCode: 27,
  ctrlKey: false, altKey: false, metaKey: false, defaultPrevented: false,
  ...patch,
})

describe('game options keyboard policy', () => {
  it('opens only for a fresh unconsumed Escape key', () => {
    expect(isOptionsEscape(escape())).toBe(true)
    expect(isOptionsEscape(escape({ repeat: true }))).toBe(false)
    expect(isOptionsEscape(escape({ isComposing: true }))).toBe(false)
    expect(isOptionsEscape(escape({ keyCode: 229 }))).toBe(false)
    expect(isOptionsEscape(escape({ defaultPrevented: true }))).toBe(false)
    expect(isOptionsEscape(escape({ ctrlKey: true }))).toBe(false)
    expect(isOptionsEscape(escape({ code: 'Enter' }))).toBe(false)
  })

  it('wraps focus only at the first and last menu controls', () => {
    expect(nextFocusIndex(5, 4, false)).toBe(0)
    expect(nextFocusIndex(5, 0, true)).toBe(4)
    expect(nextFocusIndex(5, 2, false)).toBe(3)
    expect(nextFocusIndex(5, -1, false)).toBe(0)
    expect(nextFocusIndex(0, -1, false)).toBe(-1)
  })
})
