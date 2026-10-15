import { expect, it } from 'vitest'
import { incomingThreat } from './oracle'

it('predicts an approaching projectile with actual 36m/s speed', () => {
  const threat = incomingThreat({ x: 0, y: 0 }, { x: 0, y: 0 }, [{ id: 8, owner: 2, x: 3.6, y: 0, heading: Math.PI }], 1)
  expect(threat?.time).toBeCloseTo(0.1)
})

it('ignores receding, own and safely missing projectiles', () => {
  expect(incomingThreat({ x: 0, y: 0 }, { x: 0, y: 0 }, [
    { id: 8, owner: 2, x: 3, y: 0, heading: 0 },
    { id: 9, owner: 1, x: 3, y: 0, heading: Math.PI },
    { id: 10, owner: 2, x: 3, y: 2, heading: Math.PI },
  ], 1)).toBeNull()
})
