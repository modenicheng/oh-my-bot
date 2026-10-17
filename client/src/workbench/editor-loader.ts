// 编辑器模块单飞加载器：开屏资源准备期的预取与工作台首次展开共用同一条
// `import('./editor')` promise（同一 chunk、同一 Monaco 单例/worker 池）。
// 失败不缓存——下一次调用重新发起 import，保证"预取失败后实际打开仍可重试"。
import { createLogger } from '../observability/logger'

const log = createLogger('editor')
type EditorModule = typeof import('./editor')

let loading: Promise<EditorModule> | undefined

/** 确保编辑器模块就绪；重复调用复用在途/已完成的同一次加载。 */
export function ensureEditorModule(): Promise<EditorModule> {
  return loading ??= import('./editor').catch(error => {
    // 失败不缓存：清空槽位，下一次调用（预取或真实打开）重新发起 import。
    loading = undefined
    throw error
  })
}

/** 幕后预取：可并入开屏资源准备 Promise，但失败只转告警，不阻断进入；
 *  加载槽会由 ensureEditorModule 清空，实际打开编辑器时仍可重试。 */
export function preloadEditorModule(): Promise<void> {
  return ensureEditorModule().then(() => undefined, error => {
    log.warn('editor.preload_failed', { error, retry_on_open: true })
  })
}

/** 测试隔离用：清空在途加载状态。生产代码不应调用。 */
export function resetEditorModuleForTest(): void {
  loading = undefined
}
