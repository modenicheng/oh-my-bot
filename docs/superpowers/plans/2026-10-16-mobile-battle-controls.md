# Mobile Battle Controls Implementation Plan

> For agentic workers: use test-driven development and review each bounded change before integration.

**Goal:** Implement the approved mobile battle controls specification, retaining desktop behavior and authoritative combat/replay semantics.

**Architecture:** Keep touch geometry/state independent from DOM capture. Feed touch snapshots and discrete release intents through the existing input sampler. Route discrete requests separately from held-input coalescing and use the existing authoritative projectile path.

**Tech Stack:** TypeScript, Pointer Events, CSS, protobuf, Go simulation, Vitest, Playwright.

## Global Constraints

- Preserve the visual system in `client/STYLE.md`, desktop controls, script arbitration, visibility filtering, and historical replay behavior.
- Landscape-only touch battle, safe-area-aware two-thumb controls, release-to-fire default, explicit hold-to-fire mode.
- Cancellation never creates a shot; modal/background/death/reconnect/layout changes require fresh contact.
- No boolean-pulse fallback for discrete shots. No changes to weapon balance.
- Preserve `.zcodeignore`, `balance-debug.jsonl`, and `balance-results.jsonl`.

## Task 1: Reliable Discrete Shots

Files: `protocol/proto/omb.proto`, generated protocol outputs, `server/internal/sim/single_shot.go`, simulation/control/log/replay files, `server/internal/glue/match.go`, focused Go tests.

- [x] Add failing tests for release followed by neutral input, captured heading, duplicate/freshness/generation rejection, cooldown rejection without delayed fire, lifecycle cleanup, checkpoint/replay round trips.
- [x] Extend `ClientInput` with `single_shot` (aim, observed tick, generation); bootstrap advertises support and generation; terminal result identifies robot and input sequence.
- [x] Generate Go/TypeScript bindings using the repository protobuf toolchain.
- [x] Admit bounded actions independently of coalesced held state; process once on the next simulation tick through shared combat eligibility. Record deterministic action state for replay.
- [x] Project outcomes privately to the owning player; clear actions at lifecycle boundaries.
- [x] Run `go test ./server/internal/sim ./server/internal/glue ./server/internal/snapshot`.

## Task 2: Source-Neutral Touch State

Files: `client/src/game/input/touch-state.ts`, `touch-state.test.ts`, `client/src/game/input.ts`, `input.test.ts`.

- [x] Write failing tests for independent pointer owners, radial analog mapping, single release, center cancellation, continuous mode, direct ability holds, pass-through skill targets, final-up coordinates, and system cancellation.
- [x] Implement pure state transitions with cached geometry and no DOM/network dependencies.
- [x] Add sampler touch snapshot/discrete-intent integration, preserving monotonic sequence and desktop aim guard. Suppress synthetic desktop mouse events in touch layout.
- [x] Verify sticky aim/fire takeover and held false while single-shot aiming; fresh contact after release/reset.
- [x] Run focused Vitest tests, then `pnpm typecheck`.

## Task 3: Mobile Presentation And Lifecycle

Files: `client/src/game/mobile-controls.ts`, `.css`, `orientation.ts`, focused tests, `client/src/game/controls.ts`, `client/src/main.ts`.

- [x] Test touch layout selection/override, landscape fallback, pointer cancellation, listener disposal, mode persistence, and safe multi-thumb focus.
- [x] Render two semantic circular sticks and square ability buttons within the right-thumb arc; show authoritative states and explicit firing mode.
- [x] Capture pointers on a stable root, keep direct ability hit-testing stable, and cache geometry outside the sampling loop.
- [x] Gate input on portrait, modal, readiness, connection, death and visibility; best-effort fullscreen/orientation lock never prevents already-landscape play.
- [x] Expose Assist, chat, menu, upgrades and auxiliary actions on touch. Compact HUD and side panels without hiding room-host controls.
- [x] Integrate capability/generation handshake and correlated shot feedback.

## Task 4: End-To-End Verification

Files: `client/scripts/mobile-controls-check.mjs`, existing browser fixtures, verification notes in this plan.

- [x] Add browser fixtures for multitouch move/aim/release, pass-through skill crossing, direct ability holds, mode switch, portrait transition, focus and background cancellation, missing capability and teardown. Background/pagehide and teardown also have DOM tests; native OS backgrounding is not certified by the browser fixture.
- [x] Inspect screenshots at 667x375, 844x390, 932x430, 1024x768, and portrait; fix overlap and unreachable actions.
- [x] Run `pnpm typecheck`, full Vitest, `pnpm build`, `pnpm --filter client test:startup`, focused mobile browser checks, and production Go suites. See exact commands, source times and limitations below.
- [x] Test real-server shot counts rather than relying solely on mocked browser input.
- [x] Document hardware checks separately: emulation cannot establish real Android Chrome/iPhone Safari orientation/edge-gesture behavior.
- [ ] Complete real Android Chrome and iPhone Safari acceptance with device/browser versions recorded.

## Execution Notes

The user has requested implementation, authorizing execution of this plan. Work is split into disjoint server/protocol, pure input/integration, and presentation tasks; review and integrated verification remain on the main worker.

## Verification Record (2026-10-17, Asia/Shanghai)

- `pnpm build` passes, including TypeScript checks, on the 01:30 client source state with the parallel compact-protocol implementation present. Artifacts are `main-C5JhlPw-.js` and `main-CL-Tnvo6.css`. The existing large Monaco chunks still produce Vite's size warning.
- `pnpm exec vitest run --maxWorkers=4 --reporter=dot` passes 136 files / 1476 tests at 01:31. An unrestricted concurrent run hit the 15-second art-cache import hook timeout; the bounded-worker run passes without changing that test or extending its timeout. Earlier network handshake/backoff test failures were resolved by the parallel session, whose files were not edited here.
- `go test -p 1 ./cmd/... ./internal/...` passes on the combined backend source at 01:19. `go build -o ../.artifacts/mobile-compact/omb.exe ./cmd/omb` passes at 01:22. Earlier production sim/glue/snapshot SingleShot race tests and `go vet` also passed. A broader `go test -p 1 ./...` at 01:16 failed two tests in the parallel session's ignored scratch package `server/tmp/network-binary-replay-20261017`; that scratch package was not changed by this task. The green Go claim covers production packages only.
- `test:startup` passes at 01:26 with capability-absence/layout fallback and battle teardown assertions. A pre-existing fixture race was fixed by waiting for the mock server's PREL room subscription before sending bootstrap, rather than relying on room-view visibility.
- Follow-up mobile feel fix: a right-stick gesture now remains aim/fire-owned when it passes over dash/shield/Uplink hit rectangles; only a direct pointer-down on a skill acquires the held skill. The mobile upgrade drawer is 300px max width, outside taps dismiss it without starting a new gesture, and the home screen exposes a shared PC/mobile fullscreen toggle.
- `test:assist-focus` previously passed against the real server: applying a movement Snippet returns canvas focus and a fresh WASD edge regains the movement axis.
- `OMB_MOBILE_EXPECT_COMPACT=1 pnpm --filter client test:mobile` passes 21 checks against the real server on the 01:30 build: 10 authoritative shots (7 single / 3 continuous), 7 correlated fired outcomes, no page/WS errors. The per-connection production decoder observes 3991 compact snapshots, 30 protobuf frames and 9 batch frames. This verifies actual compact delivery, not only negotiation.
- The real UI transitions from Warmup to Running while two contacts are held. It confirms a fresh bootstrap/generation, neutral old contacts, and one shot from a fresh release. Touch host pause/resume stays reachable with old contacts down, including closing and reopening the menu while paused; recovery cannot reuse the old contacts.
- Trusted keyboard Tab/Enter cancels chat without sending, while Send produces one command and one server echo. Four landscape sizes plus 667x375 with injected 47px side / 21px bottom safe insets have non-overlapping control targets and correct sampled hit regions. Expanded help fits and wraps readable mobile instructions in all five variants, with native touch scrolling retained.
- Artifacts: `.artifacts/mobile-compact/report.json`, screenshots and layout/hit-test JSON in the same directory. The earlier legacy delivery report remains in `.artifacts/mobile-controls/`. Focused mobile/input/focus/chat/options tests pass 10 matching files / 104 tests at 01:28; subsequent native-menu activation tests are included in the final full suite.
- Review fixes include spawn-protection parity with held fire, bounded duplicate-feedback suppression, pause/settlement cancellation, nonprimary auxiliary contacts, keyboard Cancel activation, safe-area target separation, compact score labels, and expanded mobile-help sizing. Real touch tests additionally exposed missing nonprimary activation on existing host/HUD/options buttons. Activation now cancels held input before using the existing click handler, deduplicates a later compatibility click, preserves native mouse/keyboard behavior, and removes listeners on disposal. Touch options targets are at least 44 CSS px.
- The parallel bandwidth session's protocol/network implementation was preserved, not regenerated or reverted in this continuation. The mobile browser observer alone was adapted to the production per-connection decoder. Results describe the recorded combined source snapshots, not any later unverified parallel edits.

### Remaining Hardware Gate

No real Android/iPhone was available. Chromium CDP multitouch proves the tested event paths, not physical two-thumb reach, OS background/resume, browser bars, native notch insets, home-indicator/edge gestures, or iPhone Safari orientation behavior. Keep overall mobile acceptance open until those checks are recorded in the [hardware acceptance checklist](2026-10-17-mobile-hardware-acceptance.md).
