# Logs And Debugging

Application diagnostics are separate from match replay files and player-script
Console output. No external logging service or collector is required.

## Server

Logs go to stderr. The default is `info` and human-readable structured text.
Use `config.yaml` for persistent defaults:

```yaml
log:
  level: info
  format: text
  source: false
```

Levels: `debug`, `info`, `warn`, `error`, `off`. Formats: `text`, `json`.
`source: true` includes Go file/line locations. Invalid levels/formats fail
startup rather than silently disabling diagnostics. Malformed server config
also fails startup; it is no longer silently treated as disabled AI.

Overrides, highest priority first:

1. Process environment: `OMB_LOG_LEVEL`, `OMB_LOG_FORMAT`, `OMB_LOG_SOURCE`.
2. The server configuration directory's `.env`, using the same names.
3. `config.yaml` `log.*`.
4. Built-in defaults.

PowerShell examples, from the repository root:

```powershell
$env:OMB_LOG_LEVEL = 'debug'
$env:OMB_LOG_FORMAT = 'json'
pnpm dev:server

# Standalone process: capture structured diagnostics separately from stdout.
./server/omb.exe 2> omb.log
```

Restart the server to apply config changes. Server records include `service`
and `version`; request-scoped records also include `request_id`, `method`, and
`path`. HTTP completion records include status, response bytes and wall time.
WebSocket durations cover the entire connection, not just its handshake;
`ws.connected` marks handshake completion, and `ws.closed` summarizes traffic,
malformed frames and dropped queues. Reliable queue overflow is a warning.
Commands at debug level include only their type, never their payload.

Successful API/auth requests are info; successful health checks, stats polling
and static resource requests are debug. HTTP 4xx responses are warn and 5xx
responses are error. Handler panics include stacks and return 500 when headers
have not been sent; an already-committed response is aborted instead.

Room creation/eviction, match lifecycle, script submission outcomes, AI request
duration and categorized AI failures are observable without per-tick logging.
The existing `/api/stats` endpoint still provides tick timing, online counts
and cumulative dropped-frame counters. `OMB_PPROF=1` enables the existing
`/debug/pprof/` endpoints; restrict access at the deployment proxy.

## Browser

Open DevTools Console and enable the relevant browser level filter (Chrome
requires **Verbose** to display `console.debug`). Records contain timestamp,
level, scope, event and a page-local `session_id`.

Levels match the server: `debug`, `info`, `warn`, `error`, `off`.
Defaults: debug in Vite development, info in production. Overrides:

1. URL query, e.g. `http://127.0.0.1:5173/?logLevel=debug`.
2. `localStorage['omb.logLevel']` (written by the debug API).
3. `VITE_LOG_LEVEL` at Vite startup/build time.
4. The development/production default.

Set `VITE_LOG_LEVEL` in the build environment or `client/.env.local`, not the
server root `.env`. Only `VITE_` variables are exposed by Vite; never place
secrets in them. Changing a built bundle's default requires rebuilding it.

The debug API is available once startup initializes:

```javascript
window.ombDebug.getLevel()
window.ombDebug.setLevel('debug') // immediate; persists across reloads
window.ombDebug.logs()           // a detached copy of up to 200 recent records
window.ombDebug.export()         // JSON string for a bug report
window.ombDebug.clear()
window.ombDebug.resetLevel()     // remove saved override and resolve defaults
```

The ring buffer only keeps records allowed by the current level, is bounded
to 200 records, and disappears on reload. No logs are automatically uploaded.
Initialization installs uncaught-error, unhandled-rejection and resource-error
listeners, with cleanup on HMR. It does not suppress native browser errors.
The level setting controls application logs, not native browser diagnostics,
Vite/third-party logs, or the in-game player-script Console.

## Correlating A Failure

HTTP requests send `X-Request-ID`; the server validates or replaces it and
echoes it in response headers. The browser completion record uses the returned
ID. Search that ID in stderr or collected JSON logs to find the server outcome.
Fetch duration measures time to headers; streaming response bodies remain owned
by their callers. Replay parsing/body errors are reported separately.

Each WebSocket attempt gets a fresh `request_id` query parameter, because the
browser WebSocket API cannot set headers. The same ID connects browser session
transitions/retry failures to server handshake, command and closure records.
In Vite's compact-to-legacy transport fallback the same dial attempt keeps its
ID. `session.bound` links that ID to the room, and room/match logs use
`room_code`. No protocol schema or gameplay frame format changes are needed.

## Privacy And Volume

Access logs deliberately omit query strings, headers, cookies and request
bodies. In particular, OIDC authorization codes, state and `?token=` must not
appear there. The server logger additionally redacts credential attributes,
URLs and credential assignments in string/error attributes. Browser fields are snapshotted, bounded and recursively sanitized:
credential/prompt/script/body fields are redacted, URL credentials/queries/
fragments are removed, and Error messages/stacks are sanitized. Do not pass
arbitrary user text to diagnostic loggers. Review any exported report before
sharing it, since diagnostic paths, room codes and environment details remain.

The application does not log game inputs/snapshots each frame. A malformed-frame
warning is emitted once per connection; closure records summarize counters.
Snapshot resync requests are debug-only. Log rotation and retention belong to
the process supervisor/container host, not the realtime simulation.
