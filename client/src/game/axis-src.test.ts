import { describe, expect, it } from 'vitest'
import { ControlSource, type SelfState } from '@omb/protocol'
import { AIM_STATUS_TEXT, aimControlStatus, axisTakeover } from './axis-src'

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
