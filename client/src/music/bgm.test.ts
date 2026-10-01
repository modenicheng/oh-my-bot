import { describe, expect, it, vi } from 'vitest'
import { BackgroundMusic, phaseStage } from './bgm'
import type { ChipMusic } from './player'
import type { SongRenderer } from './renderer'
import type { SongRender } from './render'

function fixture() {
  let resolve!: (render: SongRender) => void
  let reject!: (reason: Error) => void
  const render = new Promise<SongRender>((yes, no) => { resolve = yes; reject = no })
  const context = Object.assign(new EventTarget(), { state: 'running' })
  const player = {
    isPlaying: false, prepare: vi.fn(() => context), setVolume: vi.fn(), setMix: vi.fn(),
    setAmbience: vi.fn(), setRender: vi.fn(), setStage: vi.fn(),
    play: vi.fn(() => { player.isPlaying = true; return true }),
    stop: vi.fn(() => { player.isPlaying = false }),
  }
  const makePlayer = vi.fn(() => player as unknown as ChipMusic)
  const renderer = { render: vi.fn(() => render) }
  const music = new BackgroundMusic(makePlayer, () => renderer as unknown as SongRenderer)
  const attach = () => music.attach(context as unknown as AudioContext)
  const finish = async () => { resolve({} as SongRender); await render; await Promise.resolve(); await Promise.resolve() }
  return { music, player, context, makePlayer, renderer, attach, finish, reject }
}

describe('background music lifecycle', () => {
  it('maps outer and inner phases without creating audio during preload', async () => {
    const f = fixture()
    expect(phaseStage(1)).toBe('arena')
    expect(phaseStage(2)).toBe('final')
    const first = f.music.preload()
    expect(f.music.preload()).toBe(first)
    expect(f.makePlayer).not.toHaveBeenCalled()
    expect(f.renderer.render).toHaveBeenCalledTimes(1)
    await f.finish()
  })

  it('attaches once and uses the latest active scene when rendering finishes', async () => {
    const f = fixture()
    f.music.setLevel(0.5, false)
    f.attach(); f.attach()
    f.music.setView('game')
    f.music.phase('game', 2)
    f.music.phase('live', 1)
    await f.finish()
    expect(f.makePlayer).toHaveBeenCalledTimes(1)
    expect(f.player.setRender).toHaveBeenCalledWith({}, { stage: 'final' })
    expect(f.player.play).toHaveBeenCalledTimes(1)
    expect(f.player.setVolume).toHaveBeenLastCalledWith(0.2)
    f.music.setView('menu')
    expect(f.player.setStage).toHaveBeenLastCalledWith('title', { fade: 0.09 })
    expect(f.player.play).toHaveBeenCalledTimes(1)
  })

  it('does not resurrect muted or background music after a late render', async () => {
    const f = fixture()
    f.music.setLevel(1, false)
    f.attach()
    f.music.setVisible(false)
    f.music.setLevel(1, true)
    await f.finish()
    expect(f.player.play).not.toHaveBeenCalled()
    f.music.setVisible(true)
    expect(f.player.play).not.toHaveBeenCalled()
    f.music.setLevel(0.25, false)
    expect(f.player.play).toHaveBeenCalledTimes(1)
    expect(f.player.setVolume).toHaveBeenLastCalledWith(0.1)
    f.music.setVisible(false)
    expect(f.player.isPlaying).toBe(false)
  })

  it('waits for the shared context to run and never resumes it itself', async () => {
    const f = fixture()
    f.context.state = 'suspended'
    f.music.setLevel(1, false)
    f.attach()
    await f.finish()
    expect(f.player.play).not.toHaveBeenCalled()
    f.context.state = 'running'
    f.context.dispatchEvent(new Event('statechange'))
    expect(f.player.play).toHaveBeenCalledTimes(1)
    f.context.state = 'suspended'
    f.context.dispatchEvent(new Event('statechange'))
    expect(f.player.isPlaying).toBe(false)
  })

  it('ignores closed contexts and contains renderer errors', async () => {
    const f = fixture()
    f.context.state = 'closed'
    f.attach()
    expect(f.makePlayer).not.toHaveBeenCalled()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ready = f.music.preload()
    f.reject(new Error('worker failed'))
    await expect(ready).resolves.toBeNull()
    warning.mockRestore()
  })
})
