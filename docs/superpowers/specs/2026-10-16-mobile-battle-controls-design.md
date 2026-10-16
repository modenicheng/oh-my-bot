# Mobile Battle Controls Design

Date: 2026-10-16

Status: interaction proposal confirmed in conversation; written specification awaiting review. This document does not authorize implementation.

Confirmed firing-mode decision: continuous fire requires holding the right stick outside its dead zone. Releasing or returning to the dead zone stops firing. Enabling the mode never starts firing by itself.

## 1. Goal And Scope

Make browser-based manual play practical with two thumbs: move with the left stick, aim with the right stick, release to request one shot by default, and use abilities within the right thumb's reach.

V1 includes:

- Touch controls in Warmup and Running player views, with landscape-only battle interaction.
- A bounded floating left movement stick and a fixed right aiming/firing stick.
- Single-shot and hold-to-fire modes, with an explicit, always-visible mode switch.
- Hold-to-use dash, shield, and Uplink interaction controls.
- A compact mobile HUD, touch-accessible auxiliary actions, and safe cancellation across lifecycle changes.
- Server-authoritative one-shot semantics, protocol capability detection, and deterministic replay support.

V1 does not include native packaging, controller support, automatic target selection, aim assistance changes, new abilities, custom control-layout editing, or new weapon/balance rules. Spectator/replay gesture redesign and a mobile code-editor redesign are separate work. Existing manual, editor, chat, upgrade, and room-management actions must remain reachable.

## 2. Current Integration Constraints

The design is based on repository HEAD `7e28841`.

- `client/src/game/input.ts` currently combines keyboard/mouse capture, camera-based pointer aiming, sticky takeover axes, and input sampling.
- `client/src/game/controls.ts` samples and sends input at 60 Hz and supplies the local aim preview to rendering.
- `client/src/main.ts` currently enables manual input only while the game canvas itself has focus. Touching a new HUD button must not inadvertently disable the other thumb's control.
- `protocol/proto/omb.proto` models `ClientInput.fire` as a held boolean, not a discrete shot request.
- `server/internal/sim/sim.go` and `control.go` coalesce pending input by axis before simulation ticks. A short `fire=true` followed by `fire=false` can disappear before a tick; holding true until acknowledgement can instead cause repeated firing.
- `server/internal/sim/combat.go` owns projectile creation, cooldown, energy, shield restrictions, and combat events. Mobile input must use the same authority.
- `server/internal/sim/log.go` serializes inputs, and replay/checkpoints preserve simulation semantics. A new discrete action must not exist only in the live network path.
- `client/STYLE.md` defines the existing dark technical visual language, pixel icons, restrained cyan highlights, square panels/buttons, and semantic circular elements. Preserve these conventions.

## 3. Landscape Policy And Input Availability

Landscape is mandatory for touch-controlled Warmup and Running battle views. Join, lobby, settings, and full-page manual views may remain portrait. Desktop keyboard/mouse play is not landscape-gated.

On an explicit user gesture, attempt fullscreen and then landscape orientation lock when those APIs are available. Failure is a supported path, not an error that prevents landscape play. A device that is already landscape may play without fullscreen or a successful orientation lock.

In portrait, show a localized rotate-device overlay above the battlefield and controls. It must explain that local manual control is suspended and provide access to leaving/settings; do not rotate the entire document with CSS. Portrait gating does not pause the server or automatically disable Driving Assist.

Entering portrait, losing visibility/focus, opening a modal or text-entry panel, disconnecting, awaiting a full snapshot, dying, or leaving the battle cancels all owned gestures. Attempt an explicit neutral update for operated axes while the connection is usable. Clear unsent shot requests, held abilities, continuous fire, and pointer ownership. Do not synthesize a release-to-fire action.

After recovery, require a new pointer-down gesture. An old finger still on the glass, a repeated key event, or an acknowledgement cannot rearm controls. Only the firing-mode preference survives; held state and pending actions do not.

Orientation and viewport geometry changes must invalidate cached control geometry. They cancel active gestures before moving hit regions. Browser toolbar or keyboard resizing must not be mistaken for a new user input.

## 4. Layout And Control Discovery

Prefer the touch layout for touch-primary/coarse-pointer devices, not solely for narrow viewports or a mobile user-agent string. Provide an input-layout override in settings for hybrid devices. Switching input layouts cancels the previous source before enabling the next; touch must not emit synthetic mouse fire through the desktop path.

| Region | Content |
| --- | --- |
| Top left | Compact HP, EN, and available Skill Points |
| Top center | Match time and phase |
| Top edge | Menu, Driving Assist, and expandable score summary |
| Bottom left | Movement activation area and floating stick |
| Bottom right | Fixed aiming/firing stick |
| Inner/upper arc around right stick | Dash, shield, and contextual Uplink interaction buttons |
| Upper edge of right control cluster | Explicit single-shot / continuous-fire switch |

Use the current Chinese product terminology in visible labels. On touch, do not rely on keyboard hints such as Q, Shift, E/F, R, or Space to explain actions. The mode switch must display its selected mode in text as well as visual state.

Initial prototype dimensions are 112-128 CSS px for a stick, 52-60 CSS px for ability targets, and at least 8 CSS px between distinct targets. These are UI tuning defaults, not combat constants. Preserve semantic circles for sticks and keep ability buttons consistent with the existing square-button system.

Use viewport safe-area insets plus an additional content margin; no interactive target may sit under the home indicator, notch, rounded corners, or a system edge-gesture strip. Use the actual battle viewport rather than the full physical screen. A short landscape viewport gets a compact layout rather than overlapping targets.

The scoreboard is collapsed by default on touch. Upgrades and auxiliary actions open touch-sized drawers/overlays instead of consuming permanent stick space. Opening a non-battle panel releases manual input but does not pause the simulation or scripts.

The left stick origin appears at first contact within its bounded lower-left activation region. Clamp the origin so the entire stick stays inside that region and outside reserved HUD/overlay targets. Once acquired, its origin does not drift until the gesture ends. The right origin stays fixed relative to the safe-area-aware control cluster.

## 5. Pointer Ownership And Movement

Use Pointer Events with a separate owner `pointerId` for the left role and the right role. Do not filter by `isPrimary`, because the second thumb must work. A touch cannot switch from left to right merely by crossing the screen midpoint. Additional contacts cannot steal an occupied role.

Capture each acquired pointer on a stable interaction root. Since capture suppresses normal cross-element hover targeting, skill transfer uses the pointer's coordinates against cached hit regions, not `pointerenter`/`pointerleave` on the ability button. Refresh those regions on layout changes, not on every sample.

Apply `touch-action: none` and text-selection suppression to active battle control surfaces, not to the entire application or document reader. Do not globally disable browser zoom in the viewport meta tag.

Movement mapping for stick radius R and initial radial dead zone D = 0.18R:

1. Compute displacement from the captured origin in CSS coordinates.
2. For displacement length <= D, output zero movement.
3. Otherwise normalize the direction and map magnitude linearly from D..R to 0..1, clamped at 1.
4. Convert each component to the existing -1000..1000 per-mille input range.

This preserves analog movement and prevents extra diagonal speed. CSS scaling and device pixel ratio must not change direction or strength. On normal release, output a zero-movement update with the operated movement axis; physical deceleration remains governed by the existing simulation.

## 6. Right-Stick State Machine

The shared right-hand role has states `idle`, `tracking`, `aiming`, and `ability-held`. The selected firing mode is independent persistent preference, not a held state.

The aim vector is displacement from the fixed right-stick origin. Once outside the dead zone, use `atan2(dy, dx)` in the game's existing world-axis convention. Do not aim from the Robot to the finger's absolute screen position. Camera follow, Robot movement, and DPR changes must not bend a stationary directional aim.

| State/event | Single-shot mode | Continuous-fire mode |
| --- | --- | --- |
| Down on free right stick | Enter tracking; do not fire | Enter tracking; do not fire |
| Move outside dead zone | Enter aiming; update local aim; hold fire false | Enter aiming; update local aim; hold fire true |
| Move within dead zone | Enter tracking; retain last facing; do not fire | Enter tracking; retain last facing; stop fire |
| Normal up while outside dead zone | Submit one request with the final valid direction | Stop fire; submit no one-shot request |
| Normal up within dead zone | Cancel shot | Stop fire |
| Transfer to an ability target | Cancel shot; enter ability-held | Stop fire; enter ability-held |
| System cancellation | Cancel without firing | Stop without a final extra shot |

A quick tap that never leaves the dead zone does not fire. Returning to the dead zone cancels unless the player moves out again before normal release. At pointer-up, recompute displacement and ability-target hit testing from the event coordinates so that a last motion omitted from `pointermove` cannot use a stale direction or cancellation state. If that final position enters an ability region, cancel the shot; do not synthesize an ability hold that has already ended.

For a valid drag, update the local aim line without waiting for a server snapshot. Preview is direction feedback only; projectile creation, energy deduction, and successful-shot feedback remain authoritative. Retain the last valid facing in the dead zone, with a distinct cancellation indication; do not draw a new arbitrary direction.

Switching firing mode cancels the active right-hand gesture and any unsent one-shot intent. The left thumb may continue moving. Require a new right pointer-down; never reinterpret an in-progress single-shot drag as continuous fire. Persist only the selected mode in local settings, defaulting to single-shot on first use.

## 7. Ability Interaction With Two Thumbs

Preserve current hold semantics:

- Dash: hold while the left stick supplies movement. No new invulnerability, speed, or energy behavior.
- Shield: hold to request shielding; release to request stopping. Honor the existing minimum duration, cooldown, energy, and fire restrictions.
- Uplink interaction: highlight the button when an eligible nearby Uplink exists; hold to channel, release to stop. Display the server-derived availability, progress, and rejection reason.

Direct pointer-down on an ability acquires the right-hand role. Alternatively, sliding the aiming thumb into an ability's non-overlapping inner/upper hot region transfers that same role: clear continuous fire/unsent single-shot, then start the selected held ability. The left role is unaffected.

After transfer, lock the role to that ability until pointer-up or cancellation. Sliding back over the aiming stick does not resume aiming/fire, and sliding over another ability does not change the selected ability. This avoids jitter and prevents a skill release from accidentally firing.

All buttons show server-confirmed active, cooling, insufficient-energy, and unavailable states. A displayed unavailable state must never suppress handling of a release for an already owned pointer. Server combat rules, rather than client styling, resolve shield/fire and other action conflicts.

The right role is intentionally exclusive: V1 does not require one thumb to hold both an ability and the aiming stick. Additional-finger combinations are not a requirement for normal play.

## 8. Takeover And Focus Contracts

Maintain the existing four control axes and explicit hand-back policy:

| Human operation | Takeover |
| --- | --- |
| Left stick outside its dead zone | Movement axis |
| Right stick outside its dead zone | Aim and fire axes |
| Ability activation | Ability axis; terminate fire when transferred from the right stick |
| Firing-mode switch alone | No new battle axis takeover |

An intentional touch-aim drag is the mobile equivalent of explicit manual aim takeover; it is not subject to the desktop mouse-micro-motion guard. Keep the desktop R/guard behavior unchanged.

In single-shot aiming, takeover of the fire axis carries false so a Bot Script cannot fire during the player's non-firing aim gesture. On normal release or return to idle, operated axes stay manually owned under the current arbitration rules. Releasing a stick is not an implicit return to scripts. A touch-accessible Driving Assist action uses the same three-branch behavior as Space.

Define a battle interaction domain containing the canvas, touch sticks, and battle-action controls. Focus on a skill or firing-mode control must not release the other thumb. Text inputs, editable content, workbench/manual panels, menus, and modals remain outside the domain and release manual controls. Preserve native keyboard navigation and button activation for non-touch users.

All input gating also checks connection/snapshot readiness, battle visibility, match end, death, portrait blocking, and modal state. A focused control alone cannot enable input while another gate is closed.

## 9. Reliable Single-Shot Contract

Do not emulate a shot with a one-sample true pulse or by holding fire until a projectile appears. Add a discrete one-shot intent alongside the held input snapshot, with these contracts:

- Identity: current match/input generation plus Robot identity plus the normal monotonically increasing input `seq`. The release frame's `seq` is the request ID; no second independent client counter is needed.
- Payload: captured release direction and the latest observed simulation tick. The normal input snapshot in the same message explicitly owns aim/fire and has held fire false.
- Routing: accepted discrete intents enter a bounded action lane before held input is coalesced. A later false/aim update cannot erase the intent or change its captured projectile heading.
- Consumption: examine each request on the first simulation tick after admission, regardless of weapon readiness. Repeated frames, duplicate sequences, and already consumed IDs cannot create another attempt. Process requests in sequence order; bound the lane to four requests per Robot, rejecting overflow rather than overwriting accepted requests or creating an unbounded queue.
- Validation: reject invalid/non-finite directions, wrong generations, future observed ticks, and requests more than 30 ticks old at consumption. This 500 ms limit at the current 60 Hz is a proposed input-freshness default, not a weapon cooldown or latency guarantee.
- Eligibility: use the same authoritative alive, shield, cooldown, energy, and projectile-capacity checks as held fire. A successful request creates at most one projectile. Any failed request is consumed and never waits for cooldown/energy recovery.
- Arbitration: a one-shot request is human fire intent, not a way to bypass control ownership. The atomic input/request path must apply human aim/fire ownership and preserve other axes. If held and discrete fire are both present, the discrete request takes precedence for that Robot in that tick; do not fire a second projectile.
- Acknowledgement: input `ack_seq` confirms input consumption, not successful firing. Return a request-correlated terminal outcome for accepted one-shot requests, including rejection, so local feedback does not guess success from an acknowledgement. Successful combat feedback still comes from the authoritative shot event.
- Lifetime: clear the action lane on death/respawn, match replacement, disconnect cleanup, and control-generation changes. Never resend a pending shot after reconnect or full resync. Wait for the normal full-state handshake before accepting fresh manual input.

The action lane bridges transport admission to the next simulation tick; it is not an input buffer that retries until a weapon is ready. Under the existing cooldown, multiple valid requests processed in one tick cannot bypass the one-projectile interval.

Gesture cancellation removes only unsent local intents; server-side lifetime clearing follows the boundaries listed above. Once a request has been submitted, it may be processed before the server observes a disconnect or other lifetime boundary. Do not promise to retract an accepted shot or an already created projectile. A gesture cancelled before normal release never submits a request.

Advertise discrete-shot support in the reliable bootstrap/session capability path for both Warmup and Running. When the capability is missing, do not silently fall back to the unsafe boolean pulse. Keep desktop play available and show an actionable mobile-version incompatibility notice.

## 10. Replay And Compatibility

Protocol changes are additive; retain the existing continuous `fire` boolean for desktop clients, Bot Scripts, and mobile continuous fire. Regenerate Go and TypeScript protocol outputs from the schema, not by hand.

Record the discrete intent, its identity, captured aim, and deterministic processing order independently of held-input coalescing. Include any pending action/deduplication state needed for a checkpoint to resume identically. Increment simulation semantics when necessary and retain the old execution path for historical recordings that have no discrete intent.

Both live play and replay must call the same shot eligibility/projectile path. Replay seek/checkpoint restoration must not re-fire consumed requests, lose requests at tick boundaries, or reinterpret old held input as a discrete action. Terminal network feedback is a projection, not an additional source of combat truth.

Do not change Observation filtering, map visibility, weapon stats, or replay omniscience while adding the controls.

## 11. Responsibility Boundaries

Suggested new modules are responsibility boundaries, not a request for a framework rewrite:

| Module | Responsibility and dependencies |
| --- | --- |
| `client/src/game/input.ts` | Shared sequence, sampled input, takeover, and release facade; preserve existing consumers while splitting input capture |
| `client/src/game/input/desktop.ts` | Existing keyboard/mouse capture and desktop aim guard |
| `client/src/game/input/touch-state.ts` | Pure stick geometry, pointer-role state, right-hand transitions, and cancellation; no DOM/network |
| `client/src/game/input/touch.ts` | Pointer capture and DOM-to-state adapter; no authoritative combat decisions |
| `client/src/game/mobile-controls.ts` and `.css` | Touch control presentation, hit regions, settings, and state feedback |
| `client/src/game/orientation.ts` | Best-effort fullscreen/orientation API use and portrait/viewport lifecycle state |
| `client/src/game/controls.ts` | Sample/send, local preview, state availability, and lifecycle integration |
| `client/src/main.ts` | Battle interaction-domain focus and view/panel routing |
| `protocol/proto/omb.proto` | Additive request, capability, and correlated result definitions |
| `server/internal/sim/single_shot.go` | Bounded discrete-intent consumption, identity/freshness checks, and shared shot eligibility integration |
| Existing simulation, glue, log, replay, snapshot modules | Route requests, project outcomes/capabilities, preserve checkpoint/log semantics, and clear lifecycle state |

DOM listeners, geometry observers, pointer captures, orientation listeners, and settings subscriptions need explicit teardown on exit. Re-entry must not duplicate listeners or commands. Keep layout reads out of the 60 Hz sampling path.

## 12. Delivery Order

1. Establish discrete-shot protocol, shared authoritative processing, lifecycle clearing, and replay/checkpoint tests. This independently secures the highest-risk input contract.
2. Extract input-source boundaries without changing desktop behavior; implement/test the pure touch state machine and source-neutral release/takeover contracts.
3. Connect Pointer Events, battle focus, orientation gating, and the minimal two-stick presentation.
4. Add ability transfer, mobile HUD, touch auxiliary actions, mode persistence, and authoritative feedback.
5. Validate browser fixtures and a real server, then perform Android Chrome and iPhone Safari hardware checks. Browser emulation alone does not establish mobile input feel or orientation support.

Each stage needs focused failing-then-passing tests before proceeding. A detailed task-by-task implementation plan follows written-spec approval; no game implementation is part of this documentation change.

## 13. Acceptance Matrix

### Pure Input And Lifecycle

- Full-strength movement reaches the existing range; dead-zone movement is zero; diagonal magnitude never exceeds one; independent pointer IDs cannot steal roles.
- Single-shot dragging produces zero fire requests until normal release. Valid release produces exactly one attempt with the final event's direction; tap, center release, pointer cancellation, and capture loss produce none.
- Moving out, back in, and out again rearms correctly. Camera follow, resizing, CSS scaling, and DPR do not corrupt directional aim.
- Continuous-fire drag holds fire only outside the dead zone. Release/return/cancellation stops it, with no extra one-shot.
- Mode switch stops the right gesture without stopping left movement or starting a new shot.
- Direct ability use and stick-to-ability transfer retain left movement. Returning across the stick or releasing the ability never fires.
- Death, hidden document, blur, disconnect, resync, portrait entry, modal entry, and view teardown clear state. Recovery always requires fresh contact.
- Normal pointer-up is handled once; the subsequent expected capture-release event cannot produce a second action. Unexpected capture loss takes the cancellation path.

### Server, Arbitration, And Replay

- A release request followed by neutral held frames before the next tick is consumed once, not lost in coalescing. A later aim update cannot bend the queued shot.
- Duplicate/stale/future/wrong-generation requests and overflow cannot create projectiles or grow memory without bounds.
- Cooldown, insufficient energy, shield, death, and projectile exhaustion consume/reject the attempt and never schedule delayed fire. Rapid valid attempts do not exceed the existing fire interval.
- Touch aiming seizes aim/fire despite script aim capability and holds fire false in single-shot mode. Returning control follows the existing explicit Assist policy; desktop mouse guard behavior is unchanged.
- Disconnect/reconnect and new matches do not replay old shot requests. Request-correlated outcomes distinguish acceptance/rejection from generic input acknowledgement.
- Deterministic replay and checkpoint round trips match authoritative state/events across single shots, held fire, mixed input, rejection, and lifecycle boundaries. Old recordings retain their previous behavior.

### Browser And Hardware

- Exercise landscape viewports at 667x375, 844x390, 932x430, and 1024x768 CSS px, including safe-area variants and portrait transitions. Controls, HUD, and auxiliary drawers do not overlap interactive targets.
- Exercise multitouch rather than only mouse emulation. Verify default scrolling/zoom suppression is restricted to battle surfaces and text panels still scroll normally.
- Unsupported/rejected fullscreen and orientation lock still allow landscape play; portrait remains gated. Capability absence shows the explicit mobile compatibility notice.
- Verify HP/EN, skill state, upgrades, Assist, chat, menu, and room-host actions remain reachable without keyboard shortcuts. Touch controls have localized accessible names and visible non-color-only state.
- Regress desktop movement/fire, aim guard, focus navigation, panel typing, upgrades, startup, spectating, and replay controls.
- On real Android Chrome and iPhone Safari, verify two-thumb reach, browser-bar behavior, system gesture edges, cancellation, background/resume, and entry without orientation-lock support. Record tested device/browser versions and any remaining limitations.

Existing verification entry points include `pnpm typecheck`, `pnpm exec vitest run`, `pnpm build`, `pnpm --filter client test:startup`, and `go test ./server/internal/sim ./server/internal/glue ./server/internal/snapshot`. Add a focused mobile browser fixture and real-server shot-count checks during implementation; automated browser fixtures alone cannot certify exactly-once combat behavior.

## 14. API References

Verified while documenting the design on 2026-10-16:

- [MDN: ScreenOrientation.lock](https://developer.mozilla.org/en-US/docs/Web/API/ScreenOrientation/lock): limited availability and fullscreen constraints; orientation lock is an enhancement, not the only landscape gate.
- [MDN: pointercancel](https://developer.mozilla.org/en-US/docs/Web/API/Element/pointercancel_event): browser/system interruptions, including orientation changes, must not be treated as release-to-fire.
- [MDN: touch-action](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/touch-action): declare gesture policy on battle surfaces before a gesture starts, and keep document zoom/scroll behavior outside them.
- [MDN: env](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/env): use safe-area environment variables for control placement.
