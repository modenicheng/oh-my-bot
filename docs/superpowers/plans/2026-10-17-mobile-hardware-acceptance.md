# Mobile Hardware Acceptance

Status: pending physical Android Chrome and iPhone Safari runs.

Use this checklist with the approved [design](../specs/2026-10-16-mobile-battle-controls-design.md) and [implementation record](2026-10-16-mobile-battle-controls.md). Chromium touch emulation is automated evidence for event handling, not a substitute for the device checks below.

## Setup And Evidence

1. Build the client and server from the same workspace state. Follow the existing [runbook](../../runbook.md) for local hosting; opt in to LAN listening only when the phone needs to reach the development machine.
2. Record the source revision plus uncommitted changes, device model, OS version, browser version, URL scheme, viewport size, screen orientation, display zoom, and whether an external keyboard is connected.
3. Join an isolated room as host without a firing Bot Script. Check both Warmup and Running; use another client for death/respawn and remote pause checks.
4. Record a short screen capture with touch locations where the device allows it. Keep console/server errors and the exact reproduction steps for any failure.

| Environment | Device / OS / browser version | Result | Evidence |
| --- | --- | --- | --- |
| Android Chrome | Not available in the implementation session | Pending | None |
| iPhone Safari | Not available in the implementation session | Pending | None |

## Available Test Access

Checked on 2026-10-17 from the implementation environment:

- Windows PnP inventory has no present Android, iPhone, iPad, Apple Mobile, ADB, or MTP device entry.
- `adb`, `idevice_id`, and `tidevice` are not available on PATH.
- Tool/plugin discovery did not find a connected physical-device testing service.
- The existing Chromium report still records 21 passing checks and zero page/WS errors; it does not provide evidence for either physical-device row.

Completing these rows requires access to the actual devices or results collected on them, including device/browser versions and the checks below. Do not mark the hardware gate complete from another emulation run.

## Checks To Run On Each Device

- [ ] Enter in portrait. Startup, lobby, battlefield and dialogs render as one centered clockwise-rotated landscape surface. Check both thumbs in this fallback, then manually rotate to native landscape without requiring fullscreen or a successful orientation lock. Old contacts cannot resume after rotation.
- [ ] Hold left movement while dragging right aim. Aim changes immediately, the second thumb works, and no projectile appears before right release. Release outside center creates one shot; center tap, center release, and skill release create none.
- [ ] Return to center and move out again. The final release direction agrees with the aim line while moving and following the camera.
- [ ] Switch to continuous mode. Holding outside center fires repeatedly; center and release stop it. Switching modes alone never fires, and switching with a right contact down requires a fresh contact.
- [ ] Press each ability directly and slide aim into each ability. Left movement continues, the selected ability stays locked until release, and crossing back over aim never fires.
- [ ] Check two-thumb reach in both landscape directions. Confirm controls avoid the notch, rounded corners, home indicator, and system gesture edges. Record any accidental browser/system navigation.
- [ ] Expand and collapse browser bars, rotate with both thumbs held, and invoke/dismiss the keyboard. Controls remain reachable after geometry changes; old contacts do not resume movement, abilities, or fire.
- [ ] Background the browser, open an OS overlay, switch apps, lock/unlock the device, and return. Each interruption clears held input; recovery requires fresh contacts and causes no release shot.
- [ ] Open menu/chat/upgrades/scores while holding controls. Input clears; text entry never operates the Robot; the manual/help panel scrolls normally. Send/Cancel, Assist, and settings work without a keyboard.
- [ ] Start Running from Warmup with both thumbs held. Old contacts cannot fire in the new match. A fresh release fires once. Use the touch menu to pause, close it while paused, reopen it, and resume without a keyboard.
- [ ] Trigger death/respawn and a brief connection interruption. Pending/held state does not rearm. Rejoining uses a fresh generation; only a fresh gesture can fire.
- [ ] Leave and re-enter battle repeatedly. One gesture still produces one action, the chosen firing mode persists, and no duplicate listeners or overlays remain.

## Result Format

For each device, record the test date, versions, checks passed, failures with reproduction steps, and evidence paths. Record optional fullscreen/orientation behavior as observed; do not infer it from another browser or from emulation. Keep overall hardware acceptance pending until both device rows have actual results.
