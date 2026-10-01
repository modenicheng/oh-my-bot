import { ChipMusic } from './player'
import { SongRenderer } from './renderer'
import { stages } from './songs/score'
import { defaultTune, voiceMix } from './tune'
import type { StageId } from './types'
import type { SongRender } from './render'

export type MusicView = 'menu' | 'game' | 'live' | 'replay'
export function phaseStage(phase: number): StageId { return phase >= 2 ? 'final' : 'arena' }

/** 星灯航线 v3.1（music_synth_v3）：静默预合成，音频 context 由宿主手势创建。 */
export class BackgroundMusic {
  private player: ChipMusic | null = null
  private renderer: SongRenderer | null = null
  private rendering: Promise<SongRender | null> | null = null
  private context: AudioContext | null = null
  private view: MusicView = 'menu'
  private scene: StageId = 'title'
  private volume = 0
  private visible = true
  private loaded = false

  constructor(
    private makePlayer = () => new ChipMusic(),
    private makeRenderer = () => new SongRenderer(),
  ) {}

  /** 预合成不需要 AudioContext，不触碰自动播放权限。 */
  preload(): Promise<SongRender | null> {
    if (!this.rendering) {
      this.renderer = this.makeRenderer()
      this.rendering = this.renderer.render(stages, 44100).catch(error => {
        console.warn('Background music unavailable', error)
        return null // BGM 加载失败不能阻止游戏与音效。
      })
    }
    return this.rendering
  }

  attach(context: AudioContext): void {
    if (this.context || context.state === 'closed') return
    this.context = context
    const player = this.makePlayer()
    player.setVolume(0)
    if (!player.prepare(context)) return
    this.player = player
    const tune = defaultTune(stages)
    player.setMix(voiceMix(tune))
    player.setAmbience(tune.space, tune.echo)
    context.addEventListener('statechange', () => this.sync())
    void this.preload().then(render => {
      if (!render || this.context !== context || context.state === 'closed') return
      player.setRender(render, { stage: this.scene })
      this.loaded = true
      this.sync() // 用最新的静音/可见性/场景，禁止异步完成后复活过期音频。
    })
  }

  setView(view: MusicView): void {
    if (this.view === view) return
    this.view = view
    this.setScene(view === 'menu' ? 'title' : 'arena')
  }

  phase(view: Exclude<MusicView, 'menu'>, phase: number): void {
    if (this.view === view) this.setScene(phaseStage(phase))
  }

  setLevel(volume: number, muted: boolean): void {
    this.volume = muted ? 0 : Math.max(0, Math.min(1, volume)) * 0.4
    this.sync()
  }

  setVisible(visible: boolean): void { this.visible = visible; this.sync() }

  private setScene(scene: StageId): void {
    if (this.scene === scene) return
    this.scene = scene
    // 场景切换对齐到下一个正拍边界（半拍提前调度，等待不超过一小节），
    // 用短增益斜坡防爆音；不重启 sources，也不跨正拍长淡变。
    this.player?.setStage(scene, { fade: 0.09 })
  }

  private sync(): void {
    const player = this.player
    if (!player) return
    const audible = this.visible && this.volume > 0 && this.context?.state === 'running'
    player.setVolume(audible ? this.volume : 0)
    if (!audible) { player.stop(0.02); return }
    if (this.loaded && !player.isPlaying) player.play(0.15)
  }
}

export const bgm = new BackgroundMusic()
