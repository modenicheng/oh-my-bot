import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('./game/art')
  vi.doUnmock('./music/bgm')
  vi.doUnmock('./workbench/editor-loader')
  vi.resetModules()
})

async function registry(fonts: boolean, sprites: boolean, audio: object | null, editor: () => Promise<unknown>) {
  vi.resetModules()
  const preload = vi.fn().mockResolvedValue(audio)
  const ensure = vi.fn(editor)
  vi.doMock('./game/art', () => ({ fontReady: Promise.resolve(fonts), spritesReady: Promise.resolve(sprites) }))
  vi.doMock('./music/bgm', () => ({ bgm: { preload } }))
  vi.doMock('./workbench/editor-loader', () => ({ ensureEditorModule: ensure }))
  return { ...await import('./startup-resources'), preload, ensure }
}

describe('startup resource registry', () => {
  it('reuses one startup bundle and reports successful resource results', async () => {
    const resources = await registry(true, true, {}, async () => ({}))
    expect(resources.startupResources.map(resource => resource.id)).toEqual(['fonts', 'audio', 'sprites', 'editor'])
    await expect(Promise.all(resources.startupResources.map(resource => resource.promise))).resolves.toEqual([true, true, true, true])
    const shared = await import('./startup-resources')
    expect(shared.startupReady).toBe(resources.startupReady)
    expect(resources.preload).toHaveBeenCalledTimes(1)
    expect(resources.ensure).toHaveBeenCalledTimes(1)
  })

  it('settles the entry gate without disguising false or rejected resources as loaded', async () => {
    const resources = await registry(false, false, null, async () => { throw new Error('editor unavailable') })
    const settled = await resources.startupReady
    expect(settled.slice(0, 3)).toEqual(Array.from({ length: 3 }, () => ({ status: 'fulfilled', value: false })))
    expect(settled[3]).toMatchObject({ status: 'rejected', reason: expect.any(Error) })
  })

  it('keeps readiness pending until the actual editor promise resolves', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const resources = await registry(true, true, {}, () => held)
    let ready = false
    void resources.startupReady.then(() => { ready = true })
    await Promise.resolve()
    expect(ready).toBe(false)
    release()
    await resources.startupReady
    expect(ready).toBe(true)
  })
})
