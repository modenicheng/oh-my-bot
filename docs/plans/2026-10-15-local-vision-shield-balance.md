# Local vision and shield balance

Approved scope: share local perception between players and scripts; no hidden map, resources, seed, navigation or events. Spectators and offline replays remain isolated omniscient feeds.

Rendering adjustment approved on 2026-10-15: send the complete static map in the reliable client bootstrap. Keep its authored walls, floor, arena boundary and camera bounds stable across local snapshot updates; use translucent fog to retain terrain context. Client entity rendering, HUD and feedback still consume the locally filtered observation. Script observations, navigation, AI perception and event delivery remain range/occlusion limited, with no map seed or hidden geometry exposed through script APIs.

1. Test and implement a 3-tick minimum shield, then cooldown interpolated from 12 ticks at 3 active ticks to 180 ticks at 600 active ticks (clamped). Exhaustion also ends the shield with cooldown. Requests during cooldown do not extend it.
2. Version simulation semantics; preserve old replay behavior. Change dash acceleration to 60, retaining speed 15, projectile speed 36, damage, energy and upgrade curves.
3. Centralize distance/occlusion filtering for every entity and expose only local wall surfaces, never complete hidden wall bounds or generation metadata. Constrain navigation to observed space.
4. Add local-map transport, effective vision radius, own shield state and tombstones. Update the client without resetting matches on map changes.
5. Update generated API definitions, documentation and Oracle: exploration, local projectile prediction, short shields, current constants.
6. Run reproducible real-simulation/script experiments measuring damage, energy and timing sensitivity, then full focused Go/TypeScript verification. Human feel remains user-owned.

Preserve existing dirty work, especially upgrades/UI. No commits requested. Conditional changes to max shield reduction, uplink rules and weapons are excluded.
