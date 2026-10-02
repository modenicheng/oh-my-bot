import { describe, expect, it } from 'vitest'
import {
  CONSOLE_HEIGHT_STEP,
  MAX_CONSOLE_ENTRIES,
  MIN_CONSOLE_HEIGHT,
  STRUCTURED_CONSOLE_PREFIX,
  ScriptConsoleBuffer,
  clampConsoleHeight,
  consoleHeightForKey,
  parseStructuredConsoleMessage,
} from './script-console'

describe('console drawer sizing', () => {
  it('clamps persisted and dragged heights to the available range', () => {
    expect(clampConsoleHeight(40, 520)).toBe(MIN_CONSOLE_HEIGHT)
    expect(clampConsoleHeight(260.4, 520)).toBe(260)
    expect(clampConsoleHeight(900, 520)).toBe(520)
    expect(clampConsoleHeight(900, 80)).toBe(MIN_CONSOLE_HEIGHT)
  })

  it('supports keyboard resizing with Home and End boundaries', () => {
    expect(consoleHeightForKey('ArrowUp', 200, 360)).toBe(200 + CONSOLE_HEIGHT_STEP)
    expect(consoleHeightForKey('ArrowDown', MIN_CONSOLE_HEIGHT, 360)).toBe(MIN_CONSOLE_HEIGHT)
    expect(consoleHeightForKey('Home', 240, 360)).toBe(MIN_CONSOLE_HEIGHT)
    expect(consoleHeightForKey('End', 240, 360)).toBe(360)
    expect(consoleHeightForKey('Enter', 240, 360)).toBeUndefined()
  })
})

describe('structured console messages', () => {
  it('parses nested object and array snapshots without trusting arbitrary text', () => {
    const parsed = parseStructuredConsoleMessage(STRUCTURED_CONSOLE_PREFIX + JSON.stringify({
      a: [
        { k: 's', v: 'state' },
        { k: 'o', p: [['self', { k: 'o', p: [['hp', { k: 'n', v: '75' }]], m: 0 }], ['targets', { k: 'a', p: [['0', { k: 's', v: 'alpha' }]], m: 2 }]], m: 0 },
      ],
      m: 1,
    }))
    expect(parsed?.args[0]).toEqual({ kind: 'string', value: 'state' })
    expect(parsed?.args[1]).toMatchObject({ kind: 'object', omitted: 0 })
    expect(parsed?.omitted).toBe(1)
    expect(parseStructuredConsoleMessage('ordinary text')).toBeUndefined()
    expect(parseStructuredConsoleMessage(STRUCTURED_CONSOLE_PREFIX + '{bad')).toBeUndefined()
  })
})

describe('ScriptConsoleBuffer', () => {
  it('folds only adjacent identical messages and preserves their raw count', () => {
    const buffer = new ScriptConsoleBuffer()
    const base = { robotId: 1, scriptRev: 2, level: 'log', text: 'same', truncated: false }
    buffer.push({ ...base, tick: 10 })
    buffer.push({ ...base, tick: 11 })
    buffer.push({ ...base, tick: 12 })
    expect(buffer.entries).toHaveLength(1)
    expect(buffer.entries[0]).toMatchObject({ tick: 12, repeat: 3 })
    expect(buffer.messageCount).toBe(3)

    buffer.push({ ...base, tick: 13, level: 'warn' })
    buffer.push({ ...base, tick: 14 })
    buffer.push({ ...base, tick: 15, scriptRev: 3 })
    expect(buffer.entries).toHaveLength(4)
    expect(buffer.messageCount).toBe(6)
  })

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
