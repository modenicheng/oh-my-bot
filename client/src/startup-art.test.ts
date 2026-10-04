import { describe, expect, it } from 'vitest'
import { asciiField, asciiTitle, erodeText } from './startup-art'

const lines = (value: string) => value.split(String.fromCharCode(10))
const silhouette = (value: string) => value.replace(/[^ \n]/g, '#')

describe('startup ASCII artwork', () => {
  it('erodes actual characters monotonically while preserving whitespace and row widths', () => {
    const text = asciiTitle(0)
    expect(erodeText(text, 0)).toBe(text)
    let previous = text
    for (const progress of [0.15, 0.3, 0.5, 0.7, 0.9, 1]) {
      const current = erodeText(text, progress)
      expect(current.length).toBe(text.length)
      for (let i = 0; i < text.length; i++) {
        if (/\s/.test(previous[i]!)) expect(current[i]).toBe(previous[i])
      }
      previous = current
    }
    expect(previous.trim()).toBe('')
    expect(erodeText('PRESS TO START', 0.4)).not.toBe('PRESS TO START')
  })

  it('keeps equal row widths and the same title silhouette across frames', () => {
    const first = asciiTitle(0)
    expect(lines(first)).toHaveLength(14)
    expect(new Set(lines(first).map(row => row.length)).size).toBe(1)
    for (const frame of [1, 7, 50, 10000]) {
      expect(silhouette(asciiTitle(frame))).toBe(silhouette(first))
      expect(asciiTitle(frame)).toMatch(/^[ #%+=*\n]+$/)
    }
  })

  it('animates deterministic characters without replacing the wordmark shape', () => {
    expect(asciiTitle(7)).toBe(asciiTitle(7))
    expect(asciiTitle(7)).not.toBe(asciiTitle(0))
  })

  it('bounds the ambient field and changes its sparse symbols', () => {
    const first = asciiField(0, 32, 12)
    expect(lines(first)).toHaveLength(12)
    expect(lines(first).every(row => row.length === 32)).toBe(true)
    expect(asciiField(10, 32, 12)).not.toBe(first)
    expect(silhouette(asciiField(10, 32, 12))).toBe(silhouette(first))
  })
})
