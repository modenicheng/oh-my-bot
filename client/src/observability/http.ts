import { createLogger, createRequestId } from './logger'

const log = createLogger('http')

/** Observe time to response headers; callers retain ownership of streamed bodies. */
export async function observedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const request = typeof Request !== 'undefined' && input instanceof Request ? input : undefined
  const url = request?.url ?? String(input)
  const headers = new Headers(request?.headers)
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  const requestId = headers.get('X-Request-ID') || createRequestId()
  const origin = globalThis.location?.origin ?? 'http://localhost'
  // Keep public/external fetches simple: a custom header could trigger CORS.
  if (new URL(url, origin).origin === origin) headers.set('X-Request-ID', requestId)
  const fields = { request_id: requestId, method: init.method ?? request?.method ?? 'GET', url }
  const started = performance.now()
  log.debug('http.started', fields)
  try {
    const response = await fetch(input, { ...init, headers })
    const result = {
      ...fields, request_id: response.headers?.get('X-Request-ID') || requestId,
      status: response.status, duration_ms: Math.round((performance.now() - started) * 100) / 100,
    }
    if (response.status >= 500) log.error('http.completed', result)
    else if (!response.ok) log.warn('http.completed', result)
    else log.debug('http.completed', result)
    return response
  } catch (error) {
    const fieldsWithError = { ...fields, duration_ms: Math.round((performance.now() - started) * 100) / 100, error }
    if (init.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) log.debug('http.cancelled', fieldsWithError)
    else log.error('http.failed', fieldsWithError)
    throw error
  }
}
