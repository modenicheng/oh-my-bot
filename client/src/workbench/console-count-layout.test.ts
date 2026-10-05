import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Console 计数排版契约：计数（开关条数、tab 条数、重复折叠徽标）会随运行
// 不断增长，1/2/3+ 位数切换时不得推挤相邻控件（"清空"/"×"、辅助 ON、
// 版本抽屉、t/level 文本）。约定与 hud-takeover.test.ts 相同：CSS 走 vite
// ?raw 在 vitest 下返回空串，故用 node:fs 读源，只锁样式约定不锁像素。
//
// 规则（与 client/STYLE.md「字体」计数器条目一致）：
//   1. 计数槽用 var(--mono)，font-variant-numeric: tabular-nums；
//   2. 预留 4ch、右对齐的 inline-block 槽位（折叠计数可上 4 位，如截图
//      2773；可扩展，不是只适配某个位数）；
//   3. 重复徽标 min-width 覆盖 3 位数（折叠从 ×2 起，无 ×1 出现）。
const here = new URL('.', import.meta.url)
const read = (name: string) => readFileSync(new URL(name, here), 'utf8')
const css = read('workbench.css')
const workbenchTs = read('workbench.ts')
const consoleTs = read('script-console.ts')

const ruleFor = (selector: string): string => {
  const rule = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1]
  expect(rule, `missing workbench.css rule for ${selector}`).toBeTruthy()
  return rule!
}

describe('console count slot layout contract', () => {
  it('renders exactly the two counter hooks in the two count-bearing surfaces', () => {
    expect(workbenchTs.match(/data-console-trigger-count/g)).toHaveLength(1)
    expect(consoleTs.match(/data-console-count>/g)).toHaveLength(1)
    expect(consoleTs.match(/'script-console-repeat'/g)).toHaveLength(1)
  })

  it.each([
    ['#workbench-console-toggle [data-console-trigger-count]'],
    ['.script-console-tab [data-console-count]'],
  ])('%s reserves a right-aligned tabular slot', selector => {
    const rule = ruleFor(selector)
    expect(rule).toContain('font-variant-numeric: tabular-nums')
    expect(rule).toContain('min-width: 4ch')
    expect(rule).toContain('text-align: right')
    expect(rule).toContain('display: inline-block')
  })

  it('count slots inherit the project monospace token rather than a hard-coded stack', () => {
    // 槽位自身不写 font-family：mono 来自 #workbench-console-toggle /
    // .script-console-tab 的 var(--mono)（STYLE.md 数据字体令牌）。
    expect(ruleFor('#workbench-console-toggle')).toContain('font-family: var(--mono)')
    expect(ruleFor('#workbench .script-console-tab')).toContain('font-family: var(--mono)')
    for (const selector of ['#workbench-console-toggle [data-console-trigger-count]', '.script-console-tab [data-console-count]']) {
      expect(ruleFor(selector)).not.toMatch(/font-family|ui-monospace|JetBrains/)
    }
  })

  it('repeat badge keeps a constant pill covering three digits with tabular figures', () => {
    const rule = ruleFor('.script-console-repeat')
    expect(rule).toContain('font-variant-numeric: tabular-nums')
    expect(rule).toContain('font: 700 10px/1 var(--mono)')
    // ≥100px 的数值文本（"100" @10px JetBrains Mono ≈ 18px）必须放得下，
    // 9→10、99→100 才不会推移相邻 meta 文本。
    expect(parseFloat(rule.match(/min-width: ([\d.]+px)/)![1])).toBeGreaterThanOrEqual(24)
  })
})
