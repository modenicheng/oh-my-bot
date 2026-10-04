// 开屏资源注册表：startup.ts 用于逐项显示真实完成状态，main.ts 复用同一组
// Promise 作为 ready 门。每项自身都包含降级/重试语义，不因可选资源失败阻断进入。
import { fontReady, spritesReady } from './game/art'
import { bgm } from './music/bgm'
import { ensureEditorModule } from './workbench/editor-loader'

export interface StartupResource {
  id: 'fonts' | 'audio' | 'sprites' | 'editor'
  label: string
  promise: Promise<boolean>
}

export const startupResources: readonly StartupResource[] = [
  { id: 'fonts', label: 'fonts', promise: fontReady },
  { id: 'audio', label: 'audio', promise: bgm.preload().then(render => render !== null) },
  { id: 'sprites', label: 'sprites', promise: spritesReady },
  { id: 'editor', label: 'editor', promise: ensureEditorModule().then(() => true) },
]

// Settlement permits degraded entry; only the individual success values mean loaded.
export const startupReady = Promise.allSettled(startupResources.map(resource => resource.promise))
