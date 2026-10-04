import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureEditorModule, preloadEditorModule, resetEditorModuleForTest } from './editor-loader'

// 编辑器模块很重（Monaco + workers），单测里必须替换掉；失败场景用 doMock
// 在测试内部切换成抛错的工厂，结束时 doUnmock 恢复本文件的顶层假模块。
vi.mock('./editor', () => ({ createBotEditor: 'stub-editor-module' }))

describe('editor module loader', () => {
  beforeEach(() => {
    resetEditorModuleForTest()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('duplicate calls share one in-flight promise (single module instance, no duplicate load)', async () => {
    const first = ensureEditorModule()
    const second = ensureEditorModule()
    expect(first).toBe(second)
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
  })

  it('preload fires immediately and a later open awaits the same settled promise', async () => {
    const preload = preloadEditorModule()
    const opened = ensureEditorModule()
    await expect(preload).resolves.toBeUndefined()
    await expect(opened).resolves.toMatchObject({ createBotEditor: 'stub-editor-module' })
    // 预取完成后打开仍复用同一模块实例，不重新发起加载。
    expect(ensureEditorModule()).toBe(opened)
  })

  it('preload failure warns instead of unhandled rejection, and open retries the import', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.doMock('./editor', () => {
      throw new Error('chunk fetch failed')
    })
    const preload = preloadEditorModule()
    // preload 内部把拒绝转成告警并兑现 Promise；加入开屏 ready 时不会阻断进入。
    await expect(preload).resolves.toBeUndefined()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('预加载失败'), expect.any(Error)))
    // 失败不缓存：恢复后打开重新发起 import 并成功。
    vi.doMock('./editor', () => ({ createBotEditor: 'recovered-editor-module' }))
    await expect(ensureEditorModule()).resolves.toMatchObject({ createBotEditor: 'recovered-editor-module' })
    vi.doUnmock('./editor')
  })
})
