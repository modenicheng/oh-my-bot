import { describe, expect, it, vi, afterEach } from 'vitest'
import { $, el, fmtClock, requireEl, setText } from './dom'

// 等值守卫写入与两种取元素策略（假定存在 vs 缺失抛错）是 HUD/回放/观战
// 共用的叶子行为。仓库单测无 jsdom，按 net.test.ts 惯例用最小 DOM 桩：
// 只实现被测路径用到的 getElementById / querySelector('#id') / textContent。
// textContent 用访问器计数而非 vi.spyOn：桩是普通对象的数据属性，
// spyOn 会把它换成初值丢失的 getter/setter。

interface FakeNode {
  id: string
  readonly textContent: string
  readonly writes: number
  children: FakeNode[]
  querySelector: (selector: string) => FakeNode | null
}

function makeNode(id: string, children: FakeNode[] = []): FakeNode {
  let text = ''
  let writes = 0
  const node: FakeNode = {
    id,
    get textContent() { return text },
    set textContent(value: string) { text = value; writes++ },
    get writes() { return writes },
    children,
    querySelector(selector) {
      if (!selector.startsWith('#')) return null
      const want = selector.slice(1)
      for (const child of node.children) {
        if (child.id === want) return child
        const hit = child.querySelector(selector)
        if (hit) return hit
      }
      return null
    },
  }
  return node
}

const registry = new Map<string, FakeNode>()

afterEach(() => {
  registry.clear()
  vi.unstubAllGlobals()
})

function makeRoot(): FakeNode {
  const root = makeNode('root', [makeNode('child')])
  registry.set('root', root)
  registry.set('child', root.children[0]!)
  vi.stubGlobal('document', {
    getElementById: (id: string) => registry.get(id) ?? null,
  })
  return root
}

const asHtml = (node: FakeNode) => node as unknown as HTMLElement

describe('setText', () => {
  it('同值不写、异值才写', () => {
    const node = makeNode('n')
    ;(node as { textContent: string }).textContent = 'a'
    const writesBefore = node.writes
    setText(asHtml(node), 'a')
    expect(node.writes).toBe(writesBefore)
    setText(asHtml(node), 'b')
    expect(node.writes).toBe(writesBefore + 1)
    expect(node.textContent).toBe('b')
  })

  it('undefined 静默跳过（回放视图 DOM 可裁剪）', () => {
    expect(() => setText(undefined, 'x')).not.toThrow()
  })
})

describe('fmtClock', () => {
  it('秒 → m:ss，负数钳 0', () => {
    expect(fmtClock(0)).toBe('0:00')
    expect(fmtClock(65)).toBe('1:05')
    expect(fmtClock(600)).toBe('10:00')
    expect(fmtClock(-3)).toBe('0:00')
  })
})

describe('$ / el / requireEl', () => {
  it('$ 在全文档按 id 取元素', () => {
    const root = makeRoot()
    expect($('child')).toBe(root.children[0])
  })

  it('el 在子树内取元素，假定存在（缺失得 null 的调用方自担）', () => {
    const root = makeRoot()
    expect(el(asHtml(root), 'child').id).toBe('child')
  })

  it('requireEl 缺失时抛出带 id 的错误', () => {
    const root = makeRoot()
    expect(() => requireEl(asHtml(root), 'missing')).toThrow(/#missing/)
    expect(requireEl(asHtml(root), 'child').id).toBe('child')
  })
})
