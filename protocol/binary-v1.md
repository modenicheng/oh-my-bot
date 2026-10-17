# Realtime Binary V1

The negotiated WebSocket subprotocol is `omb.binary.v1`. Control messages retain `0x03 + ServerMsg protobuf`. Upstream remains `0x02 + ClientMsg protobuf`. No compression extension is enabled. Without negotiation the legacy wire format remains in use.

All integers are little endian. Strings are `u16 byteLength + UTF-8 bytes` (strict UTF-8). Counts are u16. Reject unknown versions, unknown flag/mask bits, truncated values, trailing bytes and oversized realtime frames. Compact snapshots and batches are limited to 65536 bytes; batches contain at most 64 children and are never nested. Standalone `0x03` control frames retain the existing Protobuf path without a new codec size cap: script-version history can legitimately exceed 64 KiB, and AI-generated source history has no application-level aggregate bound. Such control frames are sent individually, never discarded or split by the batch collector. The upstream submission limit remains 64 KiB. Bounding/chunking existing large control histories is a separate application concern, not a silent codec truncation.

## Snapshot (0x04)

Header in order:

| Field | Type |
| --- | --- |
| type | u8 = 4 |
| version | u8 = 1 |
| flags | u8: bit0 full, bit1 self present, bit2 vision radius present |
| tick | u32 |
| base tick | u32 |
| acknowledged input sequence | u32 |
| phase | u8 |
| time left seconds | u32 (warmup starts at 86400 seconds) |
| sections | u16 |

Section bits, in ascending order: 0 robots, 1 robot gone, 2 projectiles, 3 projectile gone, 4 cores, 5 core gone, 6 uplinks, 7 uplink gone, 8 health packs, 9 health pack gone, 10 point drops, 11 point drop gone. Omitted sections are empty. Each present section starts with u16 count. Gone sections contain u32 IDs. Entity sections contain records `u32 id, u16 changedMask, values in ascending mask-bit order`.

Coordinates (`pos`) are `i16 xCentimetres, i16 yCentimetres` (round halves away from zero). Reject non-finite/out-of-range values. Heading is u16, rounded modulo 65536 turns, decoded as `value * 2*pi / 65536`. State baselines compare quantized wire values, not simulation floats. New records always include their required fields even when zero. Gone records remove the metadata baseline. Full snapshots reset entity and private-state baselines.

| Entity | Mask bits and value types | Required for first sight |
| --- | --- | --- |
| Robot | 0 pos; 1 heading; 2 hp x10 i16; 3 energy x10 i16; 4 flags u8 (shield bit0, dashing bit1, dead bit2); 5 respawn seconds u16; 6 optional invulnerability seconds u16; 7 optional max hp x10 i16; 8 optional max energy x10 i16; 9 nick string; 10 color string | 0..5, 9, 10 |
| Projectile | 0 pos; 1 heading; 2 owner u32; 3 color string | 0..3 |
| Core | 0 pos; 1 value i32 | 0..1 |
| Uplink | 0 pos; 1 ready u8 (0/1); 2 hacking robot u32; 3 progress x10 i16; 4 personal cooldown seconds u16 | 0..4 |
| Health pack | 0 pos; 1 available u8 (0/1); 2 respawn seconds u16 | 0..2 |
| Point drop | 0 pos; 1 points i32 | 0..1 |

An unchanged entity need not be serialized even if the upstream entity-level delta contained it. Decoders hydrate partial records into complete application entity updates; empty nick/color on upstream moving-entity deltas mean unchanged metadata, except on new/full records. This retains the existing entity-view contract without forcing a renderer migration. Optional robot fields remain absent when never known, and zero updates remain explicit.

After sections, if flags bit1 is present, self state is encoded as follows (whole self record, only sent when it changes):

`u16 presence, u32 robotId, u8 moveSource, u8 turretSource, u32 aiRoundsLeft, u32 aiTokensLeftK`.

Presence bits and appended values in order: 0 assist u8 bool; 1 dashReadyTick u32; 2 fireReadyTick u32; 3 fireSource u8; 4 abilitySource u8; 5 manualAxesMask u32; 6 upgrade (`u32 points, u8 levelCount, levelCount*u8 levels`, count <=5, levels <=10); 7 shieldReadyTick u32; 8 shieldStartedTick u32; 9 inputGeneration u32. Unknown presence bits are invalid. Self absence means unchanged, not cleared; full without self clears it (spectator).

After self, if flags bit2 is present: u16 vision radius centimetres. Vision radius omission means unchanged; full with omission clears the previous radius.

No local-map JSON is carried. Browser map projections use the bootstrapped static map, current phase, and current visible Uplink/health-pack entity IDs. Cores/point drops already have their own entity tables. Script Observation and hidden gameplay state are not changed.

The fixed header is 22 bytes. The codec baseline is connection-local. Reset it at MapBootstrap. Encode snapshots in writer order, not at enqueue time. Snapshot `base_tick` still refers to the producer's logical delta baseline: missing lossy snapshots MUST cause the normal resync request. Across a gap, emit a header-only nonfull snapshot with the original tick/base tick so the existing consumer requests resync. Do not advance entity baselines until a full snapshot arrives, and do not commit a malformed frame. Legacy Protobuf full snapshots also reset compact baselines.

## Batch (0x05)

`u8 type=5, u8 version=1, u16 childCount`, followed by `u32 byteLength, byteLength bytes` per child. Valid children are types 3 and 4. Decode and validate all children before publishing any or committing state. Child order is application delivery order. Do not nest batches or include ping/pong frames.

Batching bounds: at most 64 children, at most 65536 total bytes, at most 1 ms collection time after the first queued message. No extra simulation tick delay. Bootstrap frames form a batching barrier; reliable messages remain ordered and are never discarded to make a batch. Script logs retain their separate lossy priority. A single child is sent unwrapped.
