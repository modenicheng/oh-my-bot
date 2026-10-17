# Mobile layout refinement

The user's October 17 screenshots and explicit follow-up supersede the original portrait gate and text-heavy mobile controls.

- [x] Inspect the startup, lobby, battle HUD, workbench, options and settlement layout; preserve protocol-session changes.
- [x] Provide one landscape application surface, native orientation enhancement and clockwise CSS fallback, including pointer and canvas geometry.
- [x] Recompose join and room screens into landscape columns with visible primary actions.
- [x] Give the startup title, loading content and entry/footer separate regions without overlap.
- [x] Put AI output and composer side by side; keep return visible above battlefield chrome.
- [x] Pin phase/time to the top; use compact icon abilities and firing-mode feedback; move help into options and remove fullscreen/replay clutter.
- [x] Close options by tapping its backdrop and compact settlement around a scrolling leaderboard.
- [x] Verify touch hit regions and desktop behavior with focused tests, build, startup browser regression, real-server mobile controls and multi-size layout screenshots.

Use the existing dark panel, cyan state and pixel icon tokens. Keep at least 44px action targets and meaningful accessible labels. Do not edit protocol definitions, codecs, networking or server code during this visual refinement.
