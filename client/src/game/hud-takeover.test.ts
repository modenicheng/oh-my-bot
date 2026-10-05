import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// C-20 结构契约：接管标记只走 data-takeover 轨。hud.ts 不得再写
// data-state='takeover'（三轨时期 move/aim 卡双写两套属性），hud.css 不得
// 再有 [data-state='takeover'] 选择器；微光统一挂在 data-takeover 轨的
// .skill-icon 上，颜色走 var(--amber) 派生（不再硬编码 #fbbf24… 荧光）；
// aim 的 standby 语义位（data-state='standby'，手工调暗琥珀）保留。
// （CSS 走 vite ?raw 在 vitest 下返回空串，故用 node:fs 读源。）
const here = new URL('.', import.meta.url)
const read = (name: string) => readFileSync(new URL(name, here), 'utf8')
const hudTs = read('hud.ts')
const hudCss = read('hud.css')

describe('C-20: single data-takeover track for HUD script markers', () => {
  it("hud.ts no longer assigns the 'takeover' card state", () => {
    expect(hudTs).not.toContain("'takeover'")
    expect(hudTs).not.toMatch(/CardState[^\n]*takeover/)
  })

  it('hud.ts keeps the standby semantic bit and the six-card takeover writes', () => {
    expect(hudTs).toContain("'standby'")
    // 五张技能卡 + move/aim：setTakeover 覆盖六卡（与 takeover-live-check 对齐；
    // 未初始化分支的 move/aim=false 清理行合计 8 处调用）。
    const writes = hudTs.match(/this\.setTakeover\(this\.skills\.\w+,/g) ?? []
    expect(writes).toHaveLength(8)
  })

  it("hud.css has no [data-state='takeover'] selector left", () => {
    expect(hudCss).not.toContain("[data-state='takeover']")
  })

  it('takeover glow lives on .skill-icon under the data-takeover track and derives from var(--amber)', () => {
    const glow = hudCss.match(/\.skill\[data-takeover='script'\] \.skill-icon \{[^}]*\}/)?.[0] ?? ''
    expect(glow).toContain('box-shadow')
    expect(glow).toContain('var(--amber)')
    expect(glow).not.toMatch(/#fbbf24|#a68b4b|#d1b46b/)
    // 微光已并入单轨：不再存在硬编码 amber 的 box-shadow 规则。
    expect([...hudCss.matchAll(/box-shadow:[^;]*#[0-9a-f]{6}/g)]).toHaveLength(0)
  })

  it('standby keeps the hand-muted amber variant without glow', () => {
    expect(hudCss).toContain("[data-state='standby']")
    expect(hudCss).toContain('#a68b4b')
    expect(hudCss).toContain('#d1b46b')
    const standbyRule = hudCss.match(/\.skill\[data-state='standby'\] \.skill-icon[^{]*\{[^}]*\}/)?.[0] ?? ''
    expect(standbyRule).not.toContain('box-shadow')
  })
})
