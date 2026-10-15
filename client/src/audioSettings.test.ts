import { describe, expect, it } from 'vitest'
import { parseAudioSettings, serializeAudioSettings } from './audioSettings'

const DEFAULTS = { sfx: { volume: 0.45, muted: false }, bgm: { volume: 0.45, muted: false } }

describe('audio settings parsing and migration', () => {
  it('falls back to defaults on null, garbage or privacy-mode failures', () => {
    expect(parseAudioSettings(null)).toEqual(DEFAULTS)
    expect(parseAudioSettings('')).toEqual(DEFAULTS)
    expect(parseAudioSettings('not json')).toEqual(DEFAULTS)
    expect(parseAudioSettings('{"v":"loud"}')).toEqual(DEFAULTS)
    expect(parseAudioSettings('42')).toEqual(DEFAULTS)
  })

  it('migrates the legacy single-track format to both tracks', () => {
    expect(parseAudioSettings(JSON.stringify({ v: 0.6, m: true }))).toEqual({
      sfx: { volume: 0.6, muted: true },
      bgm: { volume: 0.6, muted: true },
    })
    // 只有半个旧格式（缺 m 或缺 v）也算旧数据，缺口取默认。
    expect(parseAudioSettings(JSON.stringify({ v: 0.8 }))).toEqual({
      sfx: { volume: 0.8, muted: false }, bgm: { volume: 0.8, muted: false },
    })
  })

  it.each([
    { name: 'volume and mute', legacy: { v: 0.6, m: true }, volume: 0.6, muted: true },
    { name: 'volume only', legacy: { v: 0.8 }, volume: 0.8, muted: false },
    { name: 'mute only', legacy: { m: true }, volume: 0.45, muted: true },
  ])('keeps migrated tracks independent with $name legacy settings', ({ legacy, volume, muted }) => {
    const tracks = parseAudioSettings(JSON.stringify(legacy))

    tracks.sfx.volume = 0.2
    tracks.sfx.muted = !muted
    expect(tracks.bgm).toEqual({ volume, muted })

    tracks.bgm.volume = 0.9
    tracks.bgm.muted = muted
    expect(tracks.sfx).toEqual({ volume: 0.2, muted: !muted })
    expect(parseAudioSettings(serializeAudioSettings(tracks))).toEqual({
      sfx: { volume: 0.2, muted: !muted },
      bgm: { volume: 0.9, muted },
    })
  })

  it('parses the split format and clamps out-of-range volumes per track', () => {
    expect(parseAudioSettings(JSON.stringify({
      sfx: { v: 0.2, m: true }, bgm: { v: 1, m: false },
    }))).toEqual({
      sfx: { volume: 0.2, muted: true }, bgm: { volume: 1, muted: false },
    })
    expect(parseAudioSettings(JSON.stringify({
      sfx: { v: -3, m: false }, bgm: { v: 9, m: true },
    }))).toEqual({
      sfx: { volume: 0, muted: false }, bgm: { volume: 1, muted: true },
    })
    // 缺某条轨时只回退那条轨。
    expect(parseAudioSettings(JSON.stringify({ sfx: { v: 0.3, m: false } }))).toEqual({
      sfx: { volume: 0.3, muted: false }, bgm: { volume: 0.45, muted: false },
    })
  })

  it('round-trips through serialize and lets the engine detect legacy data', () => {
    const split = { sfx: { volume: 0.1, muted: true }, bgm: { volume: 0.9, muted: false } }
    expect(parseAudioSettings(serializeAudioSettings(split))).toEqual(split)
    // 迁移判定：旧格式序列化结果 != 原始串；已是新格式则原样往返、无需重写。
    expect(serializeAudioSettings(parseAudioSettings('{"v":1,"m":false}'))).not.toBe('{"v":1,"m":false}')
  })
})
