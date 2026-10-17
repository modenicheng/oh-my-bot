# Host Spectator Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the room host create a room as a read-only spectator while retaining host controls, require at least one real player or configured solo Bot before launch, and let hosts start the next round directly from settlement.

**Architecture:** Keep host spectator mode on the normal `JoinRoom` control connection so host actions and reconnect identity recovery remain available. Store the host control identity separately from seated player identities, reuse the existing full-world spectator snapshot encoder without sending `self`, and expose the final room mode through `EvRoomState` so the client does not infer it from local form state.

**Tech Stack:** Go room/glue lifecycle, Protobuf/buf generated bindings, TypeScript/Vitest client, existing canvas spectator rendering and RoomAction protocol.

## Global Constraints

- Preserve unrelated worktree changes, especially telemetry/debug edits and generated files already containing `EvTickTelemetry`.
- `JoinRoom.spectator_mode` is only a first-join room-creation intent; later joins cannot change the room mode.
- A host spectator owns host control identity but is absent from `Room.members`, `Room.session`, `RoomConn.identities`, and match player rosters.
- Normal external `SpectateRoom` connections remain read-only and cannot issue room actions.
- Empty final rosters are rejected authoritatively by the server for `START`, `WARMUP`, and `RESTART` without changing room state.
- Host spectator snapshots are full-world and omit `self`; host spectator clients never send input, chat, scripts, upgrades, or player-only controls.
- Additive protobuf fields must keep old clients and old stored profiles compatible.

## File Map

- Modify `protocol/proto/omb.proto` for the two additive wire fields.
- Regenerate only `packages/protocol/src/gen/proto/omb_pb.ts` and `server/internal/protocol/gen/proto/omb.pb.go`, preserving existing telemetry output.
- Modify `server/internal/room/room.go` and its tests for room mode, host control identity, roster validation, and state broadcast.
- Modify `server/internal/glue/hub.go`, `server/internal/glue/match.go`, and `server/cmd/omb/main.go` for host control sessions, spectator publishing, join routing, and input security.
- Add focused Go tests under `server/internal/room`, `server/internal/glue`, and `server/cmd/omb`.
- Modify `client/src/route.ts`, `client/src/net.ts`, `client/src/app/lobby.ts`, `client/src/main.ts`, `client/src/game/controls.ts`, and `client/src/game/scoreboard.ts` for profile transport, mode display, read-only rendering, and next-round action.
- Modify `client/index.html` and the smallest related CSS files for the creation toggle and spectator HUD state.
- Add focused Vitest coverage to `client/src/route.test.ts`, `client/src/net.test.ts`, `client/src/game/scoreboard.test.ts`, and new lobby/game tests where existing DOM setup permits.

## Tasks

### Task 1: Add the additive protocol contract

**Files:**
- Modify: `protocol/proto/omb.proto:94-101` and `protocol/proto/omb.proto:518-526`
- Modify: `packages/protocol/src/gen/proto/omb_pb.ts`
- Modify: `server/internal/protocol/gen/proto/omb.pb.go`
- Test: `server/cmd/omb/join_validation_test.go` or a focused new protocol test

**Interfaces:**
- Produces `JoinRoom.spectatorMode: boolean` / `GetSpectatorMode()` and `EvRoomState.hostSpectator: boolean` / `GetHostSpectator()`.

- [ ] **Step 1: Write the wire compatibility assertions**

  Assert that an empty `JoinRoom` decodes `spectatorMode == false`, an empty `EvRoomState` decodes `hostSpectator == false`, and a message carrying both new fields round-trips through both generated bindings used by the existing tests.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run `go test ./server/cmd/omb -run 'Test.*Spectator|Test.*Join' -count=1`.
  Expected: compile failure because the generated Go binding has no new getters/fields.

- [ ] **Step 3: Add fields without renumbering existing fields**

  Add `bool spectator_mode = 6;` to `JoinRoom` and `bool host_spectator = 6;` to `EvRoomState`.

- [ ] **Step 4: Regenerate the language bindings**

  Run `cd protocol; npx buf generate` and inspect the diff. Keep the existing `EvTickTelemetry` additions and reject unrelated generator churn.

- [ ] **Step 5: Run protocol and focused tests**

  Run `go test ./server/cmd/omb -run 'Test.*Spectator|Test.*Join' -count=1` and `pnpm exec vitest run client/src/net.test.ts client/src/route.test.ts`.
  Expected: PASS for default values and round-trip construction.

### Task 2: Model a host spectator in the room state machine

**Files:**
- Modify: `server/internal/room/room.go`
- Test: `server/internal/room/room_test.go`
- Test: `server/internal/room/host_spectator_test.go`

**Interfaces:**
- Produces `Room.SetHostSpectator(bool)`, `Room.HostSpectator() bool`, and a host-control identity that is independent from seated members.
- `Room.HostCommand` continues to accept the host control ID while `prepareLaunchLocked` validates `len(playerIDs) > 0 || soloBots > 0`.

- [ ] **Step 1: Add failing room tests**

  Cover: a spectator host is not counted by `MemberCount`, `StateBroadcast.RobotsOnline`, or `SessionScores`; a normal member can join afterward; an empty spectator room rejects `START`, `WARMUP`, and `RESTART` with `ErrNoPlayers`; and a configured solo Bot permits launch.

- [ ] **Step 2: Run the tests to observe the expected failure**

  Run `go test ./server/internal/room -run 'Test.*Spectator' -count=1`.
  Expected: FAIL or compile failure because room mode and launch filtering do not exist.

- [ ] **Step 3: Implement the smallest room changes**

  Store `hostSpectator` and preserve the host control ID without inserting it into `members`, keep `SetDurationConfig` creation-window semantics based on seated members, build launch IDs only from seated members, and treat solo bots as satisfying the non-empty launch requirement.

- [ ] **Step 4: Run room tests and the existing room suite**

  Run `go test ./server/internal/room -count=1`.
  Expected: PASS, including all existing host/member transition tests.

### Task 3: Bind and publish the host control session safely

**Files:**
- Modify: `server/internal/glue/hub.go`
- Modify: `server/internal/glue/match.go`
- Modify: `server/cmd/omb/main.go`
- Test: `server/internal/glue/host_spectator_test.go`
- Test: `server/internal/glue/spectate_test.go`
- Test: `server/cmd/omb/host_spectator_test.go`

**Interfaces:**
- Produces a `RoomConn.hostSession` control binding and a host-spectator identity record distinct from `sessions` and `identities`.
- `RoomConn.BindHost(..., spectatorMode bool)` creates the room and returns a control session; ordinary `Bind` remains a seated-player bind.
- `Match.bootstrapSpectatorLocked` and spectator encoder helpers are reused for host spectator delivery, but host action routing remains enabled.

- [ ] **Step 1: Write failing glue tests**

  Verify first Join with `spectatorMode=true` leaves `len(rc.sessions)==0`, `rc.Room.MemberCount()==0`, retains host control rights, broadcasts `HostSpectator=true`, and publishes snapshots without `self`. Verify ordinary Join adds one match player. Verify disconnect/rebind of the same nickname restores host control without creating a member. Verify an external `BindSpectator` still cannot invoke `HostCommand`.

- [ ] **Step 2: Run the tests and confirm the missing behavior**

  Run `go test ./server/internal/glue -run 'Test.*HostSpectator|Test.*Spectator' -count=1`.
  Expected: FAIL because all Join sessions are currently seated players.

- [ ] **Step 3: Separate host control from player membership**

  Add host-session tracking, host identity metadata, and a guarded binding path. Update `Unregister`, takeover, leave, pause/resume/finish, `maybeAutoResumeLocked`, room-state broadcast, and janitor occupancy checks so a connected host spectator is a control occupant but never a player or external spectator.

- [ ] **Step 4: Route the creation intent only during the creation window**

  In `handleJoin`, pass `join.GetSpectatorMode()` only when the room has not yet selected a host mode. Once set, ignore later Join values. Do not alter `handleSpectate` or the read-only socket gate.

- [ ] **Step 5: Reuse the spectator encoder for host snapshots**

  Include the host control session in the full-world snapshot publication lists and resync/settlement paths using a separate connection key. Never add it to `robotOf`, `playerOf`, `SessionInfo`, script maps, or input paths.

- [ ] **Step 6: Enforce host-spectator input security**

  Gate `RouteInput`, `Say`, `SubmitScript`, `ScriptRollback`, `BuyUpgrade`, `AiPrompt`, `ToggleAssist`, and snippet configuration for host spectator sessions. Permit only host room actions, `ResyncRequest`, and `LeaveRoom`.

- [ ] **Step 7: Run focused and full server tests**

  Run `go test ./server/internal/room ./server/internal/glue ./server/cmd/omb -count=1`.
  Expected: PASS with existing external spectator and reconnect tests unchanged.

### Task 4: Add the client profile and join-form mode

**Files:**
- Modify: `client/src/route.ts`
- Modify: `client/src/net.ts`
- Modify: `client/src/app/lobby.ts`
- Modify: `client/index.html`
- Modify: `client/src/app.css`
- Test: `client/src/route.test.ts`
- Test: `client/src/net.test.ts`
- Test: `client/src/app/lobby.test.ts`

**Interfaces:**
- Produces `JoinProfile.spectatorMode?: boolean`, `JoinOptions.spectatorMode?: boolean`, and JoinRoom encoding of `spectatorMode` while preserving the existing `spectator` option for `SpectateRoom`.
- Lobby exposes `hostSpectator` state from `EvRoomState.hostSpectator` and sends `spectatorMode` only from the creation toggle.

- [ ] **Step 1: Add failing profile and handshake tests**

  Assert profile round-trip/default false, normal profiles omit or encode false, spectator-host profiles encode `spectatorMode=true`, reconnect repeats the exact same Join frame, and existing read-only spectator handshakes remain `SpectateRoom`.

- [ ] **Step 2: Run focused Vitest tests and verify failure**

  Run `pnpm exec vitest run client/src/route.test.ts client/src/net.test.ts client/src/app/lobby.test.ts`.
  Expected: FAIL because the profile and Join encoder do not expose the new option.

- [ ] **Step 3: Implement profile persistence and Join transport**

  Preserve `spectatorMode` in `saveProfile`, `loadProfile`, `joinWith`, and RoomSession reconnect options. Keep `spectator` as the existing read-only transport role and never use it for host spectator mode.

- [ ] **Step 4: Add the form toggle and room-state presentation**

  Add an unchecked creation-only checkbox labeled `观战模式开房`, restore it from profile, clear it on normal form reset, and show a compact room notice when `hostSpectator` is true. Keep ordinary player actions and external live-watch links unchanged.

- [ ] **Step 5: Run focused client tests**

  Run `pnpm exec vitest run client/src/route.test.ts client/src/net.test.ts client/src/app/lobby.test.ts`.
  Expected: PASS.

### Task 5: Render host spectator matches as read-only full-world games

**Files:**
- Modify: `client/src/main.ts`
- Modify: `client/src/game/controls.ts`
- Modify: `client/src/game/hud.ts`
- Modify: `client/src/game/render.ts`
- Modify: `client/src/game/scoreboard.ts`
- Modify: `client/index.html`
- Modify: `client/src/game/hud.css`
- Test: `client/src/game/controls-spectator.test.ts`
- Test: `client/src/game/scoreboard.test.ts`

**Interfaces:**
- `GameDeps.hostSpectator: () => boolean` and `GameController` read-only mode keep `world.self` undefined, follow a deterministic full-world camera, disable input/mobile/chat/workbench/player HUD, and continue consuming scoreboard/match-end events.
- `showMatchEnd(..., actions?)` can render a host-only `开始下一局` action while normal players retain `回到房间`.

- [ ] **Step 1: Write failing presentation tests**

  Assert a host spectator match does not attach input or emit `ClientInput`, does not render player-only HUD/workbench affordances, accepts snapshots without `self`, and renders a settlement button whose callback is invoked exactly once. Assert a normal settlement still renders only `回到房间`.

- [ ] **Step 2: Run the tests and confirm failure**

  Run `pnpm exec vitest run client/src/game/controls-spectator.test.ts client/src/game/scoreboard.test.ts`.
  Expected: FAIL because GameController always assumes a player self and settlement has one back action.

- [ ] **Step 3: Implement read-only controller behavior**

  Add a host spectator flag, skip input attachment/sampling and player-specific feedback when there is no `self`, make `preparePresentation` center/follow the map rather than `(0,0)` as a fake player, and hide/disable HUD, chat, mobile controls, upgrades, and Workbench entry points for this mode. Keep renderer full-world behavior driven by the snapshot’s absent `self`.

- [ ] **Step 4: Implement settlement actions and main routing**

  Extend `showMatchEnd` with an action list or host-next-round callback. In `main.ts`, pass the callback only when the local room state says this connection is the host and `hostSpectator` is true; send exactly one `RoomAction.START`, keep the game/session alive, and wait for the next `mapBootstrap` before resetting the overlay.

- [ ] **Step 5: Run focused client tests and fix regressions**

  Run `pnpm exec vitest run client/src/game/controls-spectator.test.ts client/src/game/scoreboard.test.ts client/src/game/controls-render.test.ts client/src/game/controls-chat.test.ts`.
  Expected: PASS.

### Task 6: Handle empty-roster errors and next-round state transitions end to end

**Files:**
- Modify: `client/src/main.ts`
- Modify: `client/src/app/lobby.ts`
- Modify: `server/internal/glue/hub.go`
- Test: `server/internal/glue/host_spectator_test.go`
- Test: `server/cmd/omb/host_spectator_test.go`
- Test: `client/src/app/lobby.test.ts`

**Interfaces:**
- Produces the user-visible error `至少需要一名真人参赛者或自动 Bot` through the existing control notice/system-say compatibility path.
- `START` from settlement uses the existing room state machine and has no client-side simulated state transition.

- [ ] **Step 1: Add failing error-path tests**

  Assert empty spectator-host `START`, `WARMUP`, and `RESTART` leave state unchanged and deliver the Chinese error; assert configuring solo Bots makes `START` legal; assert settlement next-round action sends one `START` and remains connected.

- [ ] **Step 2: Implement stable error mapping**

  Map `room.ErrNoPlayers` to the compatibility notice text in the host command path while preserving other command errors. In the client, surface the notice in the room error line and keep the game view intact when the action is rejected.

- [ ] **Step 3: Implement direct next-round behavior**

  Keep the session and `GameController` alive after the host clicks `开始下一局`; clear the old settlement only after the server announces the new map, then require the normal full snapshot before activating the view.

- [ ] **Step 4: Run end-to-end focused tests**

  Run `go test ./server/internal/room ./server/internal/glue ./server/cmd/omb -count=1` and `pnpm exec vitest run client/src/app/lobby.test.ts client/src/game/scoreboard.test.ts client/src/net.test.ts`.
  Expected: PASS.

### Task 7: Verification and scoped review

**Files:**
- Test: all changed test files
- Inspect: `git diff --stat`, `git diff --check`, and generated protocol diffs

- [ ] **Step 1: Run formatting and static checks**

  Run `gofmt -w server/internal/room/room.go server/internal/glue/hub.go server/internal/glue/match.go server/cmd/omb/main.go` and `pnpm exec prettier --check` only if the repository already defines that command; otherwise run the project TypeScript checks.

- [ ] **Step 2: Run complete targeted verification**

  Run `go test ./server/internal/room ./server/internal/glue ./server/cmd/omb -count=1`, `pnpm typecheck`, `pnpm exec vitest run`, `pnpm build`, and `pnpm --filter client test:startup`.

- [ ] **Step 3: Review for unrelated changes**

  Confirm that only requested feature files are staged or included in the final diff. Preserve `.zcodeignore`, balance logs, `server/omb-mobile-check.exe`, and all pre-existing debug/telemetry edits unless the user separately requests cleanup.

- [ ] **Step 4: Report residual risks**

  Report any browser smoke or generated-code verification that could not run, and explicitly state that external read-only spectator security and host reconnect behavior were tested.
