export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off'
export type LogFields = Record<string, unknown>

const priorities: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, off: Infinity }
const LEVEL_KEY = 'omb.logLevel'
const MAX_RECORDS = 200
const sensitiveKey = /^(authorization|cookie|setcookie|token|accesstoken|refreshtoken|idtoken|apikey|clientsecret|secret|password|prompt|source|script|body|code|state)$/i

export function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

const sessionId = createRequestId()

export function parseLogLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return Object.hasOwn(priorities, normalized) ? normalized as LogLevel : undefined
}

function initialLevel(): LogLevel {
  try {
    const query = parseLogLevel(new URLSearchParams(globalThis.location?.search).get('logLevel'))
    if (query) return query
    const saved = parseLogLevel(globalThis.localStorage?.getItem(LEVEL_KEY))
    if (saved) return saved
  } catch { /* Browser storage may be unavailable in private or embedded contexts. */ }
  return parseLogLevel(import.meta.env.VITE_LOG_LEVEL) ?? (import.meta.env.DEV ? 'debug' : 'info')
}

let currentLevel = initialLevel()
const records: LogFields[] = []

export function getLogLevel(): LogLevel { return currentLevel }

export function setLogLevel(level: LogLevel): void {
  const parsed = parseLogLevel(level)
  if (!parsed) throw new Error(`Invalid log level: ${level}`)
  currentLevel = parsed
  try { globalThis.localStorage?.setItem(LEVEL_KEY, parsed) } catch { /* Runtime filtering still works. */ }
}

export function resetLogLevel(): void {
  try { globalThis.localStorage?.removeItem(LEVEL_KEY) } catch { /* Ignore disabled storage. */ }
  currentLevel = initialLevel()
}

// Drop all URL queries and fragments, including URLs embedded in Error stacks.
// Tokens also arrive through /?token= and /ws?token=, before auth cleans the URL.
function redactText(value: string): string {
  return value
    .replace(/(?:https?:\/\/|wss?:\/\/|\/)[^\s<>"']+/gi, (raw) => {
      const relative = raw.startsWith('/')
      try {
        const url = new URL(raw, 'http://localhost')
        const hadPrivateParts = !!(url.search || url.hash || url.username || url.password)
        url.username = url.password = url.search = url.hash = ''
        return (relative ? url.pathname : url.toString()) + (hadPrivateParts ? '?[REDACTED]' : '')
      } catch {
        return raw.split(/[?#]/)[0] ?? '[REDACTED]'
      }
    })
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|access_token|refresh_token|id_token|api_key|client_secret|password|code|state)=([^&\s]+)/gi, '$1=[REDACTED]')
    .slice(0, 4096)
}

function sanitize(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string') return redactText(value)
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value !== 'object') return value
  if (depth >= 5) return '[MaxDepth]'
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), stack: redactText(value.stack ?? ''), cause: sanitize(value.cause, seen, depth + 1) }
  }
  if (Array.isArray(value)) return value.slice(0, 30).map(item => sanitize(item, seen, depth + 1))
  const output: LogFields = {}
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    output[key] = sensitiveKey.test(key.replace(/[-_]/g, '')) ? '[REDACTED]' : sanitize(item, seen, depth + 1)
  }
  return output
}

function emit(level: Exclude<LogLevel, 'off'>, scope: string, event: string, fields: LogFields = {}): void {
  if (priorities[level] < priorities[currentLevel]) return
  try {
    // Snapshot context now: console's live object inspection must not retain
    // mutable gameplay objects or reveal credentials added after this call.
    const record: LogFields = {
      ...sanitize(fields) as LogFields,
      time: new Date().toISOString(), level, scope, event: redactText(event), session_id: sessionId,
    }
    if (records.length >= MAX_RECORDS) records.shift()
    records.push(record)
    console[level](`[omb:${scope}] ${record.event}`, record)
  } catch { /* Diagnostics must never break the application or recurse via global error handlers. */ }
}

export function createLogger(scope: string) {
  return {
    debug: (event: string, fields?: LogFields) => emit('debug', scope, event, fields),
    info: (event: string, fields?: LogFields) => emit('info', scope, event, fields),
    warn: (event: string, fields?: LogFields) => emit('warn', scope, event, fields),
    error: (event: string, fields?: LogFields) => emit('error', scope, event, fields),
  }
}

export function getLogs(): LogFields[] {
  return JSON.parse(JSON.stringify(records)) as LogFields[]
}

export function clearLogs(): void { records.length = 0 }
