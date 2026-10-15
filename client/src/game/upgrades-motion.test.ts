import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./upgrades.css', import.meta.url), 'utf8')

function ruleFor(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1]
  expect(rule, `missing upgrades.css rule for ${selector}`).toBeTruthy()
  return rule!
}

describe('upgrade purchase affordance motion', () => {
  it('keeps a static highlight on affordable rows without relying on animation', () => {
    const rule = ruleFor(css, '.hud-up-row[data-state="buy"]')
    expect(rule).toContain('border-left-color:')
    expect(rule).toContain('background:')
    expect(css).toContain('.hud-up-row[data-state="buy"] .hud-up-pips i:first-child:not(.on)')
    expect(css).toContain('.hud-up-row[data-state="buy"] .hud-up-pips i.on + i:not(.on)')
  })

  it('clips the decorative sweep inside the button without intercepting clicks', () => {
    const row = ruleFor(css, '.hud-up-row')
    expect(row).toContain('position: relative')
    expect(row).toContain('isolation: isolate')
    expect(row).toContain('overflow: hidden')
    const sweep = ruleFor(css, '.hud-up-row[data-state="buy"]::before')
    expect(sweep).toContain('pointer-events: none')
    expect(sweep).toContain('z-index: -1')
  })

  it('only enables the affordable-row sweep when motion is allowed', () => {
    const motion = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference)'))
    expect(ruleFor(motion, '.hud-up-row[data-state="buy"]::before'))
      .toContain('animation: hud-up-shimmer')
    expect(css).not.toMatch(/\.hud-up-row\[data-state="(?:wait|max)"\][^{]*\{[^}]*animation:/)
    expect(css).toContain('@keyframes hud-up-shimmer')
  })

  it('removes the sweep and point bounce for reduced motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(ruleFor(reduced, '.hud-up-row[data-state="buy"]::before')).toContain('display: none')
    expect(ruleFor(reduced, '.hud-upgrades[data-pop] .hud-up-points')).toContain('animation: none')
  })
})
