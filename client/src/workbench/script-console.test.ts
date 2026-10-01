import { describe, expect, it } from 'vitest'
import { MAX_CONSOLE_ENTRIES, ScriptConsoleBuffer } from './script-console'

describe('ScriptConsoleBuffer', () => {
  it('keeps a bounded tail and reports locally discarded entries', () => {
    const buffer = new ScriptConsoleBuffer()
    for (let i = 0; i < MAX_CONSOLE_ENTRIES + 17; i++) {
      buffer.push({ robotId: 1, scriptRev: i < 10 ? 1 : 2, tick: i, level: 'log', text: `m${i}`, truncated: false })
    }
    expect(buffer.entries).toHaveLength(MAX_CONSOLE_ENTRIES)
    expect(buffer.entries[0]?.tick).toBe(17)
    expect(buffer.entries.at(-1)?.scriptRev).toBe(2)
    expect(buffer.dropped).toBe(17)
  })

  it('clears entries and discard accounting between matches', () => {
    const buffer = new ScriptConsoleBuffer()
    buffer.push({ robotId: 9, scriptRev: 3, tick: 7, level: 'warn', text: 'x', truncated: true })
    buffer.clear()
    expect(buffer.entries).toEqual([])
    expect(buffer.dropped).toBe(0)
  })
})
