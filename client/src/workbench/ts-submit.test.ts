import { describe, expect, it } from 'vitest'
import { ScriptLanguage } from '@omb/protocol'
import { INITIAL_SOURCE, INITIAL_SOURCE_TS } from './workbench'
import {
  MAX_FRAME_BYTES,
  cleanEmittedJs,
  draftKeyFor,
  flattenTsMessage,
  formatTsErrors,
  isBotLanguage,
  languageToProto,
  lineStarts,
  offsetToLineColumn,
  oversizeScriptMessage,
  pickEmitJs,
  scriptFrameTooLarge,
  scriptSubmitPayload,
} from './ts-submit'

describe('default editor templates', () => {
  it.each([
    ['JavaScript', INITIAL_SOURCE],
    ['TypeScript', INITIAL_SOURCE_TS],
  ])('%s uses the flat BotContext API and health-pack priority', (_language, source) => {
    expect(source).toContain('navigateTo')
    expect(source).toContain('healthPacks')
    expect(source).toContain('bot.scan()')
    expect(source).toContain('bot.self.position')
    expect(source).not.toMatch(/\bctx\.(?:api|obs)\b|\bself\.pos\b|pickup\s*\(/)
  })

  it('keeps the intended JS JSDoc and TS type import', () => {
    expect(INITIAL_SOURCE).toContain("@param {import('@omb/bot-api').BotContext} bot")
    expect(INITIAL_SOURCE_TS).toContain("import type { BotContext } from '@omb/bot-api'")
  })
})

describe('cleanEmittedJs', () => {
  it('strips the export marker TS emits for type-only imports (ESNext module)', () => {
    // module: ESNext 时仅有类型导入的文件会发射 export {};，服务器
    // stripModuleSyntax 只剥关键字，不处理这种整行，必须客户端清理。
    expect(cleanEmittedJs('export {};\nfunction tick(bot) {\n  bot.navigateTo(bot.self.position)\n}\n')).toBe(
      'function tick(bot) {\n  bot.navigateTo(bot.self.position)\n}',
    )
  })

  it('strips named export lists while keeping the statements themselves', () => {
    expect(cleanEmittedJs('const bot = { tick() {} };\nexport { bot };\n')).toBe('const bot = { tick() {} };')
    expect(cleanEmittedJs('export { tick, bot };')).toBe('')
  })

  it('keeps export keywords before declarations for the server to strip', () => {
    const js = 'export function tick(bot) {\n  bot.shield(false)\n}\n'
    expect(cleanEmittedJs(js)).toBe('export function tick(bot) {\n  bot.shield(false)\n}')
  })

  it('does not touch object literals or destructuring that merely contain braces', () => {
    const js = 'function tick(bot) {\n  const { x, y } = bot.self.position\n  bot.move(x, y)\n}\n'
    expect(cleanEmittedJs(js)).toBe(js.trim())
  })
})

describe('formatTsErrors', () => {
  const source = 'import type { BotContext } from "@omb/bot-api"\n\nfunction tick(bot: BotContext) {\n  const n: number = bot.nearestCore()\n}\n'

  it('reports errors at original TS line and column numbers', () => {
    // 第 3 行 “function tick(ctx: TickContext) {” 中的注解起点。
    const starts = lineStarts(source)
    const annotationStart = source.indexOf('BotContext) {')
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

describe('languageToProto / scriptSubmitPayload', () => {
  it('maps editor language to the protocol enum', () => {
    expect(languageToProto('js')).toBe(ScriptLanguage.JS)
    expect(languageToProto('ts')).toBe(ScriptLanguage.TS)
  })

  it('JS submit: source = editorSource = 编辑器原文，language = JS', () => {
    const payload = scriptSubmitPayload('js', 'function tick() {}')
    expect(payload).toEqual({ clientScriptId: 0, source: 'function tick() {}', editorSource: 'function tick() {}', language: ScriptLanguage.JS })
  })

  it('TS submit: source = 编译产物 JS，editorSource = TS 原文，language = TS', () => {
    const payload = scriptSubmitPayload('ts', 'const n: number = 1', 'const n = 1;')
    expect(payload).toEqual({ clientScriptId: 0, source: 'const n = 1;', editorSource: 'const n: number = 1', language: ScriptLanguage.TS })
  })

  it('TS submit without compiled JS is refused (no frame leaves the browser)', () => {
    expect(scriptSubmitPayload('ts', 'const n: number = 1', undefined)).toEqual({ error: expect.any(String) })
    expect(scriptSubmitPayload('ts', 'const n: number = 1', '')).toEqual({ error: expect.any(String) })
  })

  it('payload pairs runtime JS with the editor source the server stores for restore', () => {
    // 服务器版本链用 editorSource+language 恢复编辑器；两条通道不可互换。
    const ts = scriptSubmitPayload('ts', INITIAL_SOURCE_TS, 'function tick(bot) {\n}\n')
    if (!('error' in ts)) expect(ts.source).not.toBe(ts.editorSource)
    const js = scriptSubmitPayload('js', INITIAL_SOURCE)
    if (!('error' in js)) expect(js.source).toBe(js.editorSource)
  })
})

describe('MAX_FRAME_BYTES 边界（64 KiB 单帧上限）', () => {
  it('上限取自协议权威源 TransportTiming，为 65536 字节（非字符数）', () => {
    expect(MAX_FRAME_BYTES).toBe(65536)
  })

  it('恰好 65536 字节不超限，65537 字节超限（真实编码帧字节数）', () => {
    // 逐字节逼近：找到使帧长恰为 65536 与 65537 的源码长度（JS 双份同串）。
    // source/editor_source 同串，帧长随源码严格单调增 2 字节/字符，故可二分。
    const frameFor = (n: number) => frameBytesOf('x'.repeat(n), 'x'.repeat(n), ScriptLanguage.JS)
    let lo = 0, hi = 40000
    while (frameFor(hi) < 65536) hi *= 2
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (frameFor(mid) < 65536) lo = mid + 1
      else hi = mid
    }
    const atLimit = frameFor(lo)
    // 帧长步进为 2，奇数 65537 不可达时用 >= 65537 的最小帧验证超限侧。
    if (atLimit === 65536) {
      expect(scriptFrameTooLarge(atLimit)).toBe(false) // 恰好上限不拒
      const over = frameFor(lo + 1)
      expect(over).toBeGreaterThanOrEqual(65537)
      expect(scriptFrameTooLarge(over)).toBe(true) // 超一字节即拒
    } else {
      expect(atLimit).toBeGreaterThan(65536) // 跳过恰好 65536：首帧已超
      expect(scriptFrameTooLarge(65536)).toBe(false)
      expect(scriptFrameTooLarge(atLimit)).toBe(true)
    }
    expect(scriptFrameTooLarge(65536)).toBe(false)
    expect(scriptFrameTooLarge(65537)).toBe(true)
  })

  it('多字节 UTF-8：字符数远小于字节数时按字节判定', () => {
    // 「超」= 3 字节/字符：20,000 个字符 = 60,000 字节，字符数在限内但帧超限。
    const multiByte = '// ' + '超'.repeat(20000) + '\nfunction tick() {}'
    expect(multiByte.length).toBeLessThan(65536)
    const payload = scriptSubmitPayload('js', multiByte)
    if ('error' in payload) throw new Error('payload failed')
    const frame = frameBytesOf(payload.source, payload.editorSource, payload.language)
    expect(frame).toBeGreaterThan(65536)
    expect(scriptFrameTooLarge(frame)).toBe(true)
  })

  it('TS 编译膨胀：27 KB TS 原文 + 25 KB 编译 JS 超旧 32 KiB、在 64 KiB 内放行', () => {
    // 用户实测场景（oracle.ts）：源码 27,364 B + 编译产物 25,484 B ≈ 52.8 KB 帧。
    const tsSource = 'const x: number = 1\n' + 'y'.repeat(27364)
    const compiled = 'const x = 1;\n' + 'y'.repeat(25484)
    const payload = scriptSubmitPayload('ts', tsSource, compiled)
    if ('error' in payload) throw new Error('payload failed')
    const frame = frameBytesOf(payload.source, payload.editorSource, payload.language)
    expect(frame).toBeGreaterThan(32768)
    expect(frame).toBeLessThanOrEqual(65536)
    expect(scriptFrameTooLarge(frame)).toBe(false)
  })

  it('超限文案显示实际字节数、上限与检测阶段，TS 附双源码说明', () => {
    const js = oversizeScriptMessage(70001, 'js')
    expect(js).toContain('70001 字节')
    expect(js).toContain('65536 字节（64 KiB）')
    expect(js).toContain('已在本地预检拦截')
    expect(js).not.toContain('TS 提交')
    const ts = oversizeScriptMessage(70001, 'ts')
    expect(ts).toContain('TS 提交同帧携带编译 JS 与 TS 原文')
  })
})

/** 与 encodeClient(toBinary) 等价的手工 wire 长度计算（不依赖 DOM/protobuf 运行时）。 */
function frameBytesOf(source: string, editorSource: string, language: ScriptLanguage): number {
  const src = byteLength(source)
  const ed = byteLength(editorSource)
  const langLen = language === ScriptLanguage.TS ? 2 : 0 // tag(4,VARINT)+TS(2)；JS=0 缺省不编码
  const payloadLen = varintLen(2) + varintLen(src) + src + varintLen(3) + varintLen(ed) + ed + langLen
  const submitLen = varintLen(6) + varintLen(payloadLen) + payloadLen // ClientMsg field 6
  return 1 + submitLen // encodeClient 首字节 frame.up
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

function varintLen(n: number): number {
  let l = 0
  let x = n
  do { l++; x = Math.floor(x / 128) } while (x > 0)
  return l
}
