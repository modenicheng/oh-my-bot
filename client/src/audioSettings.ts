// 音频分轨设置（音效/背景音乐）的纯逻辑：解析、旧格式迁移与序列化。
// localStorage['omb.audio'] 新格式为 {sfx:{v,m},bgm:{v,m}}；历史上是单轨 {v,m}，
// 读到旧格式时两轨同值迁移。任何越界/损坏输入都回退默认值，不抛错。
export type AudioTrack = 'sfx' | 'bgm'
export const AUDIO_TRACKS = ['sfx', 'bgm'] as const

export interface TrackSettings { volume: number; muted: boolean }

const DEFAULT_VOLUME = 0.45

function clampVolume(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOLUME
}

function parseTrack(raw: unknown): TrackSettings {
  const s = (raw ?? {}) as { v?: unknown; m?: unknown }
  return { volume: clampVolume(s.v), muted: s.m === true }
}

export function parseAudioSettings(raw: string | null): Record<AudioTrack, TrackSettings> {
  let data: unknown = null
  if (raw) {
    try { data = JSON.parse(raw) } catch { data = null }
  }
  const legacy = data as { v?: unknown; m?: unknown } | null
  if (legacy && (typeof legacy.v === 'number' || typeof legacy.m === 'boolean')) {
    const track = parseTrack(legacy)
    return { sfx: track, bgm: { ...track } }
  }
  const split = (data ?? {}) as { sfx?: unknown; bgm?: unknown }
  return { sfx: parseTrack(split.sfx), bgm: parseTrack(split.bgm) }
}

export function serializeAudioSettings(tracks: Record<AudioTrack, TrackSettings>): string {
  return JSON.stringify({
    sfx: { v: tracks.sfx.volume, m: tracks.sfx.muted },
    bgm: { v: tracks.bgm.volume, m: tracks.bgm.muted },
  })
}
