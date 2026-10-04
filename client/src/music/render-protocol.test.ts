import { describe, expect, it } from 'vitest'
import type { RenderRequest, RenderResponse } from './render-protocol'
import type { SongSpec } from './types'

// render-protocol.ts 只有类型，没有运行时行为；这里的断言是把两端
// （renderer.ts / render.worker.ts）共同依赖的消息形状冻结在编译期——
// 字段漂移会让本文件的字面量赋值直接编译失败，而不是等到 worker 上线。

const song: SongSpec = {
  id: 'test', bpm: 120, steps: 16, swing: 0,
  voices: [{ inst: 'square', notes: [] }],
} as unknown as SongSpec

describe('render worker protocol shape', () => {
  it('RenderRequest 携带 token/song/sampleRate', () => {
    const req: RenderRequest = { token: 1, song, sampleRate: 48000 }
    expect(req.token).toBe(1)
    expect(req.sampleRate).toBe(48000)
  })

  it('RenderResponse 成功携带 render、失败携带 error，token 配对', () => {
    const ok: RenderResponse = { token: 2, render: undefined, error: undefined }
    const fail: RenderResponse = { token: 3, error: 'boom' }
    expect(ok.token).toBe(2)
    expect(fail.error).toBe('boom')
  })
})
