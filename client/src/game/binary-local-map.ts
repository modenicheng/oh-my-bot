import type { MapDefParsed } from './mapdef'

/** Resource-only observation; the renderer keeps using bootstrap terrain. */
export function projectBinaryLocalMap(
  staticMap: MapDefParsed,
  visibleUplinkIds: Pick<ReadonlySet<number>, 'has'>,
  visibleHealthPackIds: Pick<ReadonlySet<number>, 'has'>,
): MapDefParsed {
  return {
    ...staticMap,
    partial: true,
    walls: [],
    boundaries: [],
    sectors: [],
    corePads: [],
    // Use table membership, not this tick's sparse records or distance guesses.
    uplinks: staticMap.uplinks.filter(({ id }) => visibleUplinkIds.has(id)),
    healthPacks: staticMap.healthPacks.filter(({ id }) => visibleHealthPackIds.has(id)),
    coreZone: { radius: 0, unlockPhase: staticMap.coreZone.unlockPhase },
    arenaRadius: 0,
    extent: Infinity,
  }
}
