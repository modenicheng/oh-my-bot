import { describe, expect, it } from 'vitest'
import { ControlSource, type SelfState } from '@omb/protocol'
import { axisTakeover } from './axis-src'

const self = (patch: Partial<SelfState>): SelfState =>
  ({ robotId: 1, moveSrc: ControlSource.CS_UNSPECIFIED, turretSrc: ControlSource.CS_UNSPECIFIED,
     aiRoundsLeft: 0, aiTokensLeftK: 0, ...patch }) as SelfState

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
