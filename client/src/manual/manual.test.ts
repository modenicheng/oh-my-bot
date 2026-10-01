import { describe, expect, it } from 'vitest'
import { parseFrontmatterBlock, splitFrontmatter, type ManualNode } from './manual'
import { normalizeManualTree, sortManualNodes } from './manual-order'

describe('splitFrontmatter', () => {
  it('returns no metadata for header-less and body-only docs', () => {
    expect(splitFrontmatter('# 写第一个 Bot\n正文')).toEqual({ body: '# 写第一个 Bot\n正文', fm: {} })
    expect(splitFrontmatter('')).toEqual({ body: '', fm: {} })
  })

  it('never treats an unterminated header as metadata or swallows the body', () => {
    const src = '---\ntitle: 未闭合\n正文仍在继续'
    const { body, fm } = splitFrontmatter(src)
    expect(fm).toEqual({})
    expect(body).toBe(src)
  })

  it('keeps body --- separators intact when frontmatter is properly closed', () => {
    const src = '---\ntitle: t\n---\n\n正文\n\n---\n\n更多正文\n'
    const { body, fm } = splitFrontmatter(src)
    expect(fm.title).toBe('t')
    expect(body).toContain('---')
    expect(body).toContain('更多正文')
  })

  it('parses plain Chinese titles overriding the filename', () => {
    expect(splitFrontmatter('---\ntitle: 写第一个 Bot\n---\n正文').fm.title).toBe('写第一个 Bot')
  })

  it('supports quoted values containing commas, colons and Chinese', () => {
    expect(splitFrontmatter('---\ntitle: "入门：准备, 环境"\n---\n').fm.title).toBe('入门：准备, 环境')
    expect(splitFrontmatter("---\ntitle: '规则：''核心'''\n---\n").fm.title).toBe("规则：'核心'")
    expect(splitFrontmatter('---\ntitle: "称号 \\"苟王\\""\n---\n').fm.title).toBe('称号 "苟王"')
  })

  it('keeps the last duplicate key and ignores unknown keys', () => {
    const fm = splitFrontmatter('---\naudience: both\ntitle: 甲\ntitle: 乙\nrandom: x\n---\n').fm
    expect(fm.title).toBe('乙')
    expect(fm.audience).toBe('both')
  })
})

describe('parseFrontmatterBlock tags', () => {
  it('parses scalar tag', () => {
    expect(parseFrontmatterBlock('tag: 入门').tags).toEqual(['入门'])
  })

  it('parses inline arrays including quoted values with commas', () => {
    expect(parseFrontmatterBlock('tags: ["新手, 必读", 入门]').tags).toEqual(['新手, 必读', '入门'])
  })

  it('parses dash lists with mixed quoting', () => {
    const block = ['tags:', '  - 新手', '  - "含, 逗号"', "  - '带''引号'"].join('\n')
    expect(parseFrontmatterBlock(block).tags).toEqual(['新手', '含, 逗号', "带'引号"])
  })

  it('merges and dedupes tag + tags while dropping empty/null items', () => {
    const fm = parseFrontmatterBlock('tag: 新手\ntags: [新手, "", null]')
    expect(fm.tags).toEqual(['新手'])
  })

  it('ignores dash lists under unknown keys', () => {
    expect(parseFrontmatterBlock('weapons:\n  - 棒子').tags).toBeUndefined()
  })

  it('single-quoted scalar with comma stays one tag', () => {
    expect(parseFrontmatterBlock("tag: 'a, b'").tags).toEqual(['a, b'])
  })
})

describe('parseFrontmatterBlock order', () => {
  it('accepts integers, zero, negatives and floats', () => {
    expect(parseFrontmatterBlock('order: 2').order).toBe(2)
    expect(parseFrontmatterBlock('order: 0').order).toBe(0)
    expect(parseFrontmatterBlock('order: -3').order).toBe(-3)
    expect(parseFrontmatterBlock('order: 1.5').order).toBe(1.5)
  })

  it('rejects invalid, NaN-like and overflow values', () => {
    expect(parseFrontmatterBlock('order: 三').order).toBeUndefined()
    expect(parseFrontmatterBlock('title: 无序').order).toBeUndefined()
    expect(parseFrontmatterBlock('order: .nan').order).toBeUndefined()
    expect(parseFrontmatterBlock('order: 1e999').order).toBeUndefined()
  })

  it('lets a later valid value replace an earlier invalid one', () => {
    expect(parseFrontmatterBlock('order: bad\norder: 4').order).toBe(4)
  })
})

describe('manual node ordering (client mirror of server rules)', () => {
  const node = (path: string, order?: number): ManualNode => ({ path, title: path, order, children: [] })

  it('sorts by order ascending, unordered last, stable path tiebreak', () => {
    const sorted = sortManualNodes([
      node('zeta', -1),
      node('later', 10),
      node('no-order'),
      node('alpha', 3),
      node('b-page', 5),
      node('a-page', 5),
    ])
    expect(sorted.map((n) => n.path)).toEqual(['zeta', 'alpha', 'a-page', 'b-page', 'later', 'no-order'])
  })
  it('keeps equal-order nodes in path order (stable)', () => {
    const sorted = sortManualNodes([node('rules/r-rules', 5), node('rules/a-page', 5)])
    expect(sorted.map((n) => n.path)).toEqual(['rules/a-page', 'rules/r-rules'])
  })
})

describe('normalizeManualTree', () => {
  it('defaults missing children arrays and sorts by order', () => {
    const tree = normalizeManualTree([
      { path: 'a', title: 'a' },
      { path: 'b', title: 'b', children: [{ path: 'b/c', title: 'c', children: [] }] },
      { path: 'z', title: 'z', order: -1, children: [] },
    ])
    expect(tree.map((n) => n.path)).toEqual(['z', 'a', 'b'])
    expect(tree[1]!.children).toEqual([])
    expect(tree[2]!.children[0]!.children).toEqual([])
  })
})
