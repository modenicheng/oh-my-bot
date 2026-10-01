import { describe, expect, it } from 'vitest'
import {
  cleanEmittedJs,
  draftKeyFor,
  flattenTsMessage,
  formatTsErrors,
  isBotLanguage,
  lineStarts,
  offsetToLineColumn,
  pickEmitJs,
} from './ts-submit'

describe('cleanEmittedJs', () => {
  it('strips the export marker TS emits for type-only imports (ESNext module)', () => {
    // module: ESNext 时仅有类型导入的文件会发射 export {};，服务器
    // stripModuleSyntax 只剥关键字，不处理这种整行，必须客户端清理。
    expect(cleanEmittedJs('export {};\nfunction tick(ctx) {\n  ctx.api.moveTo(ctx.self.pos)\n}\n')).toBe(
      'function tick(ctx) {\n  ctx.api.moveTo(ctx.self.pos)\n}',
    )
  })

  it('strips named export lists while keeping the statements themselves', () => {
    expect(cleanEmittedJs('const bot = { tick() {} };\nexport { bot };\n')).toBe('const bot = { tick() {} };')
    expect(cleanEmittedJs('export { tick, bot };')).toBe('')
  })

  it('keeps export keywords before declarations for the server to strip', () => {
    const js = 'export function tick(ctx) {\n  ctx.api.shield(false)\n}\n'
    expect(cleanEmittedJs(js)).toBe('export function tick(ctx) {\n  ctx.api.shield(false)\n}')
  })

  it('does not touch object literals or destructuring that merely contain braces', () => {
    const js = 'function tick(ctx) {\n  const { x, y } = ctx.self.pos\n  ctx.api.move(x, y)\n}\n'
    expect(cleanEmittedJs(js)).toBe(js.trim())
  })
})

describe('formatTsErrors', () => {
  const source = 'import type { TickContext } from "@omb/bot-api"\n\nfunction tick(ctx: TickContext) {\n  const n: number = ctx.api.nearestCore()\n}\n'

  it('reports errors at original TS line and column numbers', () => {
    // 第 3 行 “function tick(ctx: TickContext) {” 中的注解起点。
    const starts = lineStarts(source)
    const annotationStart = source.indexOf('TickContext) {')
    const position = offsetToLineColumn(annotationStart, starts)
    expect(position.line).toBe(3)
    const lines = formatTsErrors(source, [
      { category: 1, code: 2322, messageText: "Type 'Vec2 | null' is not assignable to type 'number'.", start: annotationStart },
    ])
    expect(lines).toEqual([expect.stringContaining('第 3 行')])
    expect(lines[0]).toContain('TS2322')
    expect(lines[0]).toContain("Type 'Vec2 | null' is not assignable to type 'number'.")
  })

  it('ignores warnings and suggestions, only errors block submit', () => {
    const lines = formatTsErrors(source, [
      { category: 0, code: 6133, messageText: "'core' is declared but never used.", start: 10 },
      { category: 2, messageText: 'Suggestion only.', start: 12 },
    ])
    expect(lines).toEqual([])
  })

  it('flattens chained diagnostic messages', () => {
    const lines = formatTsErrors(source, [
      {
        category: 1,
        code: 2740,
        messageText: "Type '{ x: number; }' is missing the following properties from type 'Vec2'",
        start: 5,
      },
    ])
    expect(lines[0]).toContain("Type '{ x: number; }' is missing")
  })

  it('caps output and appends a remaining count', () => {
    const diagnostics = Array.from({ length: 5 }, (_, i) => ({ category: 1, code: 1000 + i, messageText: `错误 ${i}`, start: i * 10 }))
    const lines = formatTsErrors(source, diagnostics, 3)
    expect(lines).toHaveLength(4)
    expect(lines.at(-1)).toBe('…以及另外 2 个错误')
  })

  it('defaults missing category to error so malformed diagnostics still block submit', () => {
    expect(formatTsErrors('function tick() {}\n', [{ messageText: '未知诊断' }])).toEqual([expect.stringContaining('未知诊断')])
  })
})

describe('offsetToLineColumn / lineStarts', () => {
  it('maps offsets to 1-based line and column', () => {
    const source = 'abc\ndef\nghi'
    const starts = lineStarts(source)
    expect(offsetToLineColumn(0, starts)).toEqual({ line: 1, column: 1 })
    expect(offsetToLineColumn(4, starts)).toEqual({ line: 2, column: 1 })
    expect(offsetToLineColumn(6, starts)).toEqual({ line: 2, column: 3 })
    expect(offsetToLineColumn(8, starts)).toEqual({ line: 3, column: 1 })
  })

  it('clamps invalid offsets to the first line', () => {
    expect(offsetToLineColumn(-5, [0])).toEqual({ line: 1, column: 1 })
    expect(offsetToLineColumn(Number.NaN, [0])).toEqual({ line: 1, column: 1 })
  })
})

describe('draftKeyFor', () => {
  it('keeps the legacy two-element key for JavaScript drafts', () => {
    expect(draftKeyFor('ROUND2', 'tester', 'js')).toBe('omb.bot.draft:["ROUND2","tester"]')
  })

  it('separates TypeScript drafts under a three-element key', () => {
    expect(draftKeyFor('ROUND2', 'tester', 'ts')).toBe('omb.bot.draft:["ROUND2","tester","ts"]')
  })
})

describe('isBotLanguage', () => {
  it('accepts only js and ts', () => {
    expect(isBotLanguage('js')).toBe(true)
    expect(isBotLanguage('ts')).toBe(true)
    expect(isBotLanguage('TS')).toBe(false)
    expect(isBotLanguage('javascript')).toBe(false)
    expect(isBotLanguage(null)).toBe(false)
  })
})

describe('pickEmitJs', () => {
  it('selects the .js artifact and skips declarations and maps', () => {
    expect(pickEmitJs([
      { name: 'file:///bot.d.ts', text: 'declare function tick(): void' },
      { name: 'file:///bot.js', text: 'function tick() {}' },
      { name: 'file:///bot.js.map', text: '{}' },
    ])).toBe('function tick() {}')
  })

  it('returns undefined when no JS artifact exists', () => {
    expect(pickEmitJs([{ name: 'file:///bot.d.ts', text: '' }])).toBeUndefined()
    expect(pickEmitJs([])).toBeUndefined()
  })
})

describe('flattenTsMessage', () => {
  it('joins chained message text with spaces', () => {
    expect(flattenTsMessage({ messageText: 'outer', next: [{ messageText: 'inner' }] })).toBe('outer inner')
    expect(flattenTsMessage('plain')).toBe('plain')
  })
})
