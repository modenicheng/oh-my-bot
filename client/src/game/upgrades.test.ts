// @vitest-environment happy-dom
// 升级面板（ADR-0016）：渲染状态全由服务器快照驱动（SelfState.upgrade +
// SimTuning.upgrade 曲线）；本测试钉住显隐门、计数/赏金标、五行状态
// （buy/wait/max）、pip 填充、增量文案与购买回调。按键路由见 shortcut.test.ts。
import { describe, expect, it, vi } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { UpgradeTuningSchema } from '@omb/protocol'
import { UpgradePanel, BOUNTY_LEVEL } from './upgrades'
import { emptyWorld, applySnapshot } from './world'
import { SnapshotDeltaSchema, SelfStateSchema } from '@omb/protocol'
import { FALLBACK_UPGRADE_COSTS, FALLBACK_UPGRADE_STEPS } from './tuning'

function panelWith() {
  const buy = vi.fn()
  const returnFocus = vi.fn()
  const host = document.createElement('div')
  host.id = 'hud-left'
  const hudRoot = document.createElement('div')
  hudRoot.append(host)
  const panel = new UpgradePanel(hudRoot, { buy, returnFocus })
  return { panel, buy, returnFocus, host }
}

function worldWithUpgrade(points: number, levels: number[]) {
  const world = emptyWorld()
  const snap = create(SnapshotDeltaSchema, {
    tick: 1, full: true, phase: 1,
    self: create(SelfStateSchema, { robotId: 7, upgrade: { points, levels } }),
  })
  applySnapshot(world, snap)
  return world
}

// 兜底 tuning 已携带与服务器同值的升级曲线（tuning.ts X-3 兜底语义）。
const curve = create(UpgradeTuningSchema, { costs: [...FALLBACK_UPGRADE_COSTS], stepsX10: [...FALLBACK_UPGRADE_STEPS] })

describe('UpgradePanel', () => {
  it('旧服务器（SelfState.upgrade 缺失）整块隐藏', () => {
    const { panel, host } = panelWith()
    const world = emptyWorld()
    const snap = create(SnapshotDeltaSchema, { tick: 1, full: true, self: create(SelfStateSchema, { robotId: 7 }) })
    applySnapshot(world, snap)
    panel.update(world)
    const root = host.querySelector<HTMLElement>('.hud-upgrades')
    expect(root?.hidden).toBe(true)
  })

  it('计数/赏金标/pip 填充与五行状态（buy/wait/max）', () => {
    const { panel, host } = panelWith()
    const world = worldWithUpgrade(6, [3, 10, 0, 1, 4])
    panel.update(world)
    const root = host.querySelector<HTMLElement>('.hud-upgrades')!
    expect(root.hidden).toBe(false)
    expect(root.querySelector<HTMLElement>('.hud-up-points b')?.textContent).toBe('6')
    // 任一轨 ≥4（这里是 3/10/0/1/4）→ 赏金标可见。
    expect(root.querySelector<HTMLElement>('.hud-up-bounty')?.hidden).toBe(false)

    const rows = [...root.querySelectorAll<HTMLButtonElement>('.hud-up-row')]
    expect(rows).toHaveLength(5)
    const pipsOf = (row: HTMLButtonElement) =>
      [...row.querySelectorAll('.hud-up-pips i')].filter(el => el.classList.contains('on')).length
    expect(pipsOf(rows[0]!)).toBe(3)
    expect(pipsOf(rows[1]!)).toBe(10)
    // 6 点：hp L4 成本 8 → wait；盾 L1 成本 2 → buy；移速已满 → max。
    expect(rows[0]!.dataset.state).toBe('wait')
    expect(rows[2]!.dataset.state).toBe('buy')
    expect(rows[1]!.dataset.state).toBe('max')
    expect(rows[1]!.querySelector('.hud-up-delta')?.textContent).toBe('MAX')
    // 增量文案：盾轨首级 = 承伤 −5%；hp L4 → +20。
    expect(rows[2]!.querySelector('.hud-up-delta')?.textContent).toBe('−5%')
    expect(rows[0]!.querySelector('.hud-up-delta')?.textContent).toBe('+20')
    expect(rows[0]!.querySelector('.hud-up-cost b')?.textContent).toBe('8')
  })

  it('点击行触发购买回调并归还画布焦点', () => {
    const { panel, host, buy, returnFocus } = panelWith()
    const world = worldWithUpgrade(10, [0, 0, 0, 0, 0])
    panel.update(world)
    const rows = [...host.querySelectorAll<HTMLButtonElement>('.hud-up-row')]
    rows[3]!.click()
    expect(buy).toHaveBeenCalledExactlyOnceWith(4)
    expect(returnFocus).toHaveBeenCalledExactlyOnceWith()
  })

  it('BOUNTY_LEVEL 门=4：低于门槛不显示赏金标', () => {
    expect(BOUNTY_LEVEL).toBe(4)
    const { panel, host } = panelWith()
    const world = worldWithUpgrade(0, [3, 3, 3, 3, 3])
    panel.update(world)
    expect(host.querySelector<HTMLElement>('.hud-up-bounty')?.hidden).toBe(true)
  })
})
