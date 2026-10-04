import { describe, expect, it } from 'vitest'
import { nextHelpOpen } from './help-toggle'

describe('nextHelpOpen', () => {
  it('toggles the folded controls help', () => {
    expect(nextHelpOpen(false, 'toggle')).toBe(true)
    expect(nextHelpOpen(true, 'toggle')).toBe(false)
  })

  it('closes on Escape or when leaving the game view', () => {
    expect(nextHelpOpen(true, 'escape')).toBe(false)
    expect(nextHelpOpen(true, 'leave')).toBe(false)
    expect(nextHelpOpen(false, 'escape')).toBe(false)
  })
})
