import { describe, expect, it } from 'vitest'
import { ControlSource, type SelfState } from '@omb/protocol'
import { AIM_STATUS_TEXT, aimControlStatus, axisTakeover, isAimUnderScript } from './axis-src'

const self = (patch: Partial<SelfState>): SelfState =>
  ({ robotId: 1, moveSrc: ControlSource.CS_UNSPECIFIED, turretSrc: ControlSource.CS_UNSPECIFIED,
     aiRoundsLeft: 0, aiTokensLeftK: 0, ...patch }) as SelfState

describe('aim control mode stays distinct from per-tick output', () => {
  it('shows standby while an enabled aim module has no target', () => {
    const idle = self({ assistOn: true, manualAxesMask: 0 })
    expect(aimControlStatus(idle, true)).toBe('standby')
    expect(AIM_STATUS_TEXT[aimControlStatus(idle, true)]).toBe('辅助待机')
    expect(axisTakeover(idle).aim).toBe(false)
    expect(aimControlStatus(idle, false)).toBe('manual')
  })

  it.each([ControlSource.CS_SCRIPT, ControlSource.CS_SNIPPET])('uses one active label for aim source %s', turretSrc => {
    expect(aimControlStatus(self({ assistOn: true, turretSrc }), true)).toBe('aiming')
    expect(AIM_STATUS_TEXT.aiming).toBe('辅助瞄准')
  })

  it('keeps real manual aim higher priority than capability or stale output', () => {
    const active = self({ assistOn: true, turretSrc: ControlSource.CS_SNIPPET })
    expect(aimControlStatus({ ...active, manualAxesMask: 2 }, true)).toBe('manual')
    expect(aimControlStatus({ ...active, turretSrc: ControlSource.CS_HUMAN }, true)).toBe('manual')
    expect(aimControlStatus({ ...active, assistOn: false }, true)).toBe('manual')
    expect(AIM_STATUS_TEXT.manual).toBe('手动瞄准')
  })

  it('does not mistake other human axes for manual aiming', () => {
    expect(aimControlStatus(self({ assistOn: true, manualAxesMask: 13 }), true)).toBe('standby')
  })

  it('returns to standby when targets disappear and to manual when aim is disabled', () => {
    const idle = self({ assistOn: true, manualAxesMask: 0 })
    expect(aimControlStatus({ ...idle, turretSrc: ControlSource.CS_SNIPPET }, true)).toBe('aiming')
    expect(aimControlStatus(idle, true)).toBe('standby')
    expect(aimControlStatus(idle, false)).toBe('manual')
    expect(aimControlStatus(undefined, true)).toBe('unavailable')
  })
})

describe('isAimUnderScript truth table (single source for HUD and guard)', () => {
  // 全组合真值表：16 行覆盖 assistOn × aimCapable × turretSrc(script|other) × holdsAim。
  // turretSrc 只分「脚本系」与「非脚本系」（CS_HUMAN/CS_UNSPECIFIED/undefined 同栏）。
  const CS: ControlSource[] = [ControlSource.CS_SCRIPT, ControlSource.CS_SNIPPET]
  const NOT_CS: (ControlSource | undefined)[] = [ControlSource.CS_HUMAN, ControlSource.CS_UNSPECIFIED, undefined]
  const table: { assistOn: boolean; aimCapable: boolean; turretSrc: ControlSource | undefined; holdsAim: boolean; under: boolean }[] = []
  for (const assistOn of [false, true])
    for (const aimCapable of [false, true])
      for (const turretSrc of [...CS, ...NOT_CS])
        for (const holdsAim of [false, true])
          table.push({ assistOn, aimCapable, turretSrc, holdsAim,
            under: assistOn && (aimCapable || CS.includes(turretSrc as ControlSource)) && !holdsAim })

  it('matches the frozen 40-row truth table', () => {
    expect(table).toHaveLength(40)
    for (const row of table) {
      expect(isAimUnderScript(row.assistOn, row.aimCapable, row.turretSrc, row.holdsAim)).toBe(row.under)
    }
  })

  it('guard lets the human keep the axis once seized (R), regardless of capability', () => {
    for (const turretSrc of [...CS, ...NOT_CS]) {
      for (const aimCapable of [false, true]) {
        expect(isAimUnderScript(true, aimCapable, turretSrc, true)).toBe(false)
      }
    }
  })

  it('script turret echoes keep the guard on even with no local capability signal', () => {
    for (const turretSrc of CS) {
      expect(isAimUnderScript(true, false, turretSrc, false)).toBe(true)
    }
  })

  it('assist off or no signal and no script echo never guards', () => {
    for (const turretSrc of NOT_CS) {
      expect(isAimUnderScript(true, false, turretSrc, false)).toBe(false)
    }
    for (const turretSrc of [...CS, ...NOT_CS]) {
      expect(isAimUnderScript(false, true, turretSrc, false)).toBe(false)
    }
  })

  it('agrees with aimControlStatus standby (HUD and guard share one projection)', () => {
    // 未被权威 manual 证据拦截时：standby ⇔ isAimUnderScript(…, holdsAim=false)
    const idle = self({ assistOn: true, manualAxesMask: 0 })
    for (const aimCapable of [false, true]) {
      for (const turretSrc of [ControlSource.CS_SCRIPT, ControlSource.CS_SNIPPET, ControlSource.CS_UNSPECIFIED, undefined] as (ControlSource | undefined)[]) {
        const state = { ...idle, turretSrc }
        const status = aimControlStatus(state as SelfState, aimCapable)
        const under = isAimUnderScript(true, aimCapable, turretSrc, false)
        expect(status === 'standby').toBe(under && !CS.includes(turretSrc as ControlSource))
      }
    }
  })
})

describe('axisTakeover: per-axis script takeover markers', () => {
  it('no self state (uninitialized world) marks nothing', () => {
    expect(axisTakeover(undefined)).toEqual({ move: false, aim: false, fire: false, ability: false })
  })

  it('script and snippet sources both count as takeover on their axis', () => {
    const t = axisTakeover(self({
      moveSrc: ControlSource.CS_SCRIPT,
      turretSrc: ControlSource.CS_SNIPPET,
      fireSrc: ControlSource.CS_SCRIPT,
      abilitySrc: ControlSource.CS_SNIPPET,
    }))
    expect(t).toEqual({ move: true, aim: true, fire: true, ability: true })
  })

  it('human axes and idle axes are not marked', () => {
    const t = axisTakeover(self({
      moveSrc: ControlSource.CS_HUMAN,
      turretSrc: ControlSource.CS_HUMAN,
      fireSrc: ControlSource.CS_UNSPECIFIED,
      abilitySrc: ControlSource.CS_UNSPECIFIED,
    }))
    expect(t).toEqual({ move: false, aim: false, fire: false, ability: false })
  })

  it('mixed arbitration: human drives while script aims and fires', () => {
    const t = axisTakeover(self({
      moveSrc: ControlSource.CS_HUMAN,
      turretSrc: ControlSource.CS_SCRIPT,
      fireSrc: ControlSource.CS_SCRIPT,
      abilitySrc: ControlSource.CS_HUMAN,
    }))
    expect(t).toEqual({ move: false, aim: true, fire: true, ability: false })
  })

  it('legacy server (optional fire/ability src missing) never guesses those axes', () => {
    const t = axisTakeover(self({
      moveSrc: ControlSource.CS_SCRIPT,
      turretSrc: ControlSource.CS_SCRIPT,
      fireSrc: undefined,
      abilitySrc: undefined,
      assistOn: true,
      manualAxesMask: 0,
    }))
    expect(t).toEqual({ move: true, aim: true, fire: false, ability: false })
  })

  it('assist off means no script output even if stale mask bits linger', () => {
    const t = axisTakeover(self({
      moveSrc: ControlSource.CS_UNSPECIFIED,
      turretSrc: ControlSource.CS_UNSPECIFIED,
      assistOn: false,
      manualAxesMask: 0b1010,
    }))
    expect(t).toEqual({ move: false, aim: false, fire: false, ability: false })
  })
})
