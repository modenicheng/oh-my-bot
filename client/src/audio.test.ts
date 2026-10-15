// @vitest-environment happy-dom
// AudioEngine 是导入即实例化的单例，测试用它驱动 HUD 控件绑定的真实路径：
// happy-dom 提供 document/localStorage，AudioContext 保持未创建（master 为 null 的分支）。
import { beforeAll, describe, expect, it } from 'vitest'
import { audio } from './audio'
import { parseAudioSettings } from './audioSettings'

function hud(): string {
  return `<details id="audio-settings"><summary>音频</summary><div class="audio-panel">
    <div class="audio-row">
      <button type="button" id="audio-sfx-mute" aria-label="音效静音切换"></button>
      <input type="range" id="audio-sfx-volume" min="0" max="100" value="45" aria-label="音效音量">
    </div>
    <div class="audio-row">
      <button type="button" id="audio-bgm-mute" aria-label="音乐静音切换"></button>
      <input type="range" id="audio-bgm-volume" min="0" max="100" value="45" aria-label="音乐音量">
    </div>
  </div></details>`
}

const btn = (id: string) => document.getElementById(id) as HTMLButtonElement
const range = (id: string) => document.getElementById(id) as HTMLInputElement
const iconOf = (id: string) => btn(id).querySelector('svg')?.getAttribute('data-icon')

beforeAll(() => {
  document.body.innerHTML = hud()
  audio.installUI()
})

describe('per-track audio engine UI', () => {
  it('installs once and reflects both tracks into the HUD rows', () => {
    audio.installUI() // 幂等：重复安装不得二次绑定
    audio.setMuted('sfx', false); audio.setVolume('sfx', 0.45)
    audio.setMuted('bgm', false); audio.setVolume('bgm', 0.45)
    expect(range('audio-sfx-volume').value).toBe('45')
    expect(range('audio-bgm-volume').value).toBe('45')
    expect(btn('audio-sfx-mute').getAttribute('aria-pressed')).toBe('false')
    expect(btn('audio-bgm-mute').getAttribute('aria-pressed')).toBe('false')
    expect(iconOf('audio-sfx-mute')).toBe('sound')
    expect(iconOf('audio-bgm-mute')).toBe('music')
    expect(range('audio-sfx-volume').getAttribute('aria-label')).toBe('音效音量')
  })

  it('mutes each track independently and swaps only that row icon', () => {
    audio.setMuted('sfx', false); audio.setMuted('bgm', false)
    btn('audio-sfx-mute').click()
    expect(audio.mutedOf('sfx')).toBe(true)
    expect(audio.mutedOf('bgm')).toBe(false)
    expect(iconOf('audio-sfx-mute')).toBe('soundOff')
    expect(iconOf('audio-bgm-mute')).toBe('music')
    // 再点一次音乐钮：若 installUI 被绑了两次，这里会翻转两次回到 false。
    btn('audio-bgm-mute').click()
    expect(audio.mutedOf('bgm')).toBe(true)
    expect(iconOf('audio-bgm-mute')).toBe('musicOff')
    const stored = parseAudioSettings(localStorage.getItem('omb.audio'))
    expect(stored.sfx.muted).toBe(true)
    expect(stored.bgm.muted).toBe(true)
  })

  it('moves one slider without touching the other track', () => {
    audio.setMuted('sfx', false); audio.setMuted('bgm', false)
    audio.setVolume('sfx', 0.45); audio.setVolume('bgm', 0.45)
    range('audio-bgm-volume').value = '80'
    range('audio-bgm-volume').dispatchEvent(new Event('input'))
    expect(audio.volumeOf('bgm')).toBeCloseTo(0.8)
    expect(audio.volumeOf('sfx')).toBeCloseTo(0.45)
    expect(range('audio-sfx-volume').value).toBe('45')
    expect(range('audio-bgm-volume').value).toBe('80')
    const stored = parseAudioSettings(localStorage.getItem('omb.audio'))
    expect(stored.bgm.volume).toBeCloseTo(0.8)
    expect(stored.sfx.volume).toBeCloseTo(0.45)
  })

  it('keeps out-of-band volume changes clamped and ignored', () => {
    audio.setVolume('sfx', Number.NaN)
    expect(audio.volumeOf('sfx')).toBeCloseTo(0.45)
    audio.setVolume('sfx', 7)
    expect(audio.volumeOf('sfx')).toBe(1)
    expect(range('audio-sfx-volume').value).toBe('100')
  })
})
