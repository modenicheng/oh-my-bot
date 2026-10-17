# Compact Network Implementation Plan

> **For agentic workers:** Use test-driven implementation and disjoint codec/transport write scopes. Preserve concurrent gameplay and mobile-control changes.

**Goal:** Reduce realtime bytes and WebSocket message count without general-purpose compression or changing the 60 Hz simulation.

**Architecture:** Negotiate `omb.binary.v1` as a WebSocket subprotocol. Legacy connections retain Protobuf; negotiated connections use compact stateful snapshots and bounded batches of existing control/event messages. Publish the same snapshot objects to application consumers, so gameplay and replay schemas remain independent.

**Tech Stack:** Go, TypeScript, WebSocket, existing Protobuf for control messages.

## Global Constraints

- Preserve unrelated gameplay/mobile changes. Commit isolation includes only the shared optional `SelfState.input_generation` contract and its regenerated bindings, not discrete-shot messages or gameplay.
- Keep authoritative simulation, script observations, AOI, reliable queues, bootstrap epochs, full resync and explicit zero semantics.
- All integers are little endian; validate ranges, lengths, versions and masks.
- Compression remains disabled. Binary mode is opt-in through negotiation, enabled by the updated browser and load tool.
- Coordinates: signed 16-bit centimetres, range -327.68 to 327.67 m. Reject overflow/non-finite values rather than clamp.
- Angles: unsigned 16-bit turns, round modulo 65536, decode as radians in [0, 2*pi).
- Low-frequency JSON static-map bootstrap remains; compact snapshots never carry local geometry JSON.
- Writers encode only selected, delivered snapshots. Readers validate complete frames before committing baselines.

## Wire Contract

`protocol/binary-v1.md` defines the exact normative layout. Both codecs consume the current generated snapshot type, including input generation. Use golden fixtures and truncation tests on both sides.

## Tasks

- [x] 1. Go codec: `server/internal/wire/`, encoder/decoder, field masks, quantization, self changes, malformed input tests, golden bytes and size benchmarks.
- [x] 2. TS codec: `packages/protocol/src/binary/`, stateful decoder and batch dispatch, direct typed objects (no Protobuf decoding on compact snapshots), tests consuming the same fixture.
- [x] 3. Snapshot payload: compact client-local metadata, health-pack/self sparse updates where compatible; preserve script geometry and legacy paths. Keep modifications narrow in `snapshot/encoder.go`.
- [x] 4. Transport: negotiate subprotocol, encode at writer boundary, batch already-queued reliable events with <=1 ms collection and bounded bytes/count, preserve bootstrap/epoch/close semantics, support multiple decoded messages in RoomSession.
- [x] 5. Client projection: reconstruct local visible map metadata from bootstrap plus AOI entity tables; no JSON stringify/parse in compact snapshot path.
- [x] 6. Load/observability: decode compact/batched messages, correct Mbps units, report message rate, validate baseline continuity and measure bytes/message counts on target-like local fixtures.
- [x] 7. Run Go/TS tests, typecheck/build, cross-language fixture validation, focused race checks, performance checks and independent review. Update docs with measured results and remaining limits.

## Verification Notes

- Final layout widens timeLeftS and aiRoundsLeft to u32 to retain existing valid warmup/config ranges. Header is 22 bytes.
- Standalone protobuf control frames retain legacy size acceptance, including large script histories; only new compact/batch formats have a 64 KiB codec cap.
- Full Vitest suite: 1476 tests across 136 files with maxWorkers=4. Unbounded workers caused an unrelated art-cache beforeAll import timeout; no timeout assertion was weakened.
- Go internal/cmd package tests, vet and focused race checks pass; typecheck and production build pass.
- Real Go writer -> TS decoder -> application world smoke passes compact/legacy/spectator/resync/large history. Browser GUI verification was unavailable in this session; no UI smoke result is claimed.
- Isolated 200-client battle runs: 300.2 -> 54.6 Mbps application payload, 32844 -> 22031 WS messages/s, no snapshot gaps or transport queue drops. Not a stable-60Hz or target-host guarantee.
- Same-stream measurements, allocation caveats and deployment instructions are documented in `docs/network-binary.md`.

Commit only protocol/network work and its minimal shared schema prerequisite; concurrent gameplay/mobile work remains unstaged.
