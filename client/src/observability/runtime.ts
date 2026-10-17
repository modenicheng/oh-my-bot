import { clearLogs, createLogger, getLogLevel, getLogs, resetLogLevel, setLogLevel } from './logger'

const log = createLogger('runtime')

const debugApi = {
  getLevel: getLogLevel,
  setLevel: setLogLevel,
  resetLevel: resetLogLevel,
  logs: getLogs,
  clear: clearLogs,
  export: () => JSON.stringify(getLogs(), null, 2),
}

declare global {
  interface Window { ombDebug: typeof debugApi }
}

let dispose: (() => void) | undefined

/** Install before startup imports the main application; HMR tears listeners down. */
export function initObservability(): () => void {
  if (dispose) return dispose
  window.ombDebug = debugApi
  const onError = (event: Event): void => {
    if (event instanceof ErrorEvent) {
      log.error('runtime.error', { error: event.error ?? event.message, file: event.filename, line: event.lineno, column: event.colno })
    } else if (event.target instanceof Element) {
      const element = event.target
      log.warn('resource.failed', { tag: element.tagName, url: element.getAttribute('src') ?? element.getAttribute('href') })
    }
  }
  const onRejection = (event: PromiseRejectionEvent): void => {
    log.error('runtime.unhandled_rejection', { error: event.reason })
  }
  window.addEventListener('error', onError, true)
  window.addEventListener('unhandledrejection', onRejection)
  log.info('client.started', { mode: import.meta.env.MODE, log_level: getLogLevel() })
  dispose = () => {
    window.removeEventListener('error', onError, true)
    window.removeEventListener('unhandledrejection', onRejection)
    dispose = undefined
  }
  return dispose
}
