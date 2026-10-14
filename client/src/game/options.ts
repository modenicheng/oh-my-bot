import { audio } from '../audio'

const EDITING_TARGETS = 'input, textarea, select, [contenteditable], [role="textbox"], .monaco-editor, #workbench, #game-chat'
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'

export interface OptionsKey {
  code: string
  repeat: boolean
  isComposing: boolean
  keyCode: number
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  defaultPrevented: boolean
}

export function isOptionsEscape(event: OptionsKey): boolean {
  return event.code === 'Escape' && !event.repeat && !event.isComposing && event.keyCode !== 229
    && !event.ctrlKey && !event.altKey && !event.metaKey && !event.defaultPrevented
}

export function nextFocusIndex(length: number, current: number, backwards: boolean): number {
  if (length <= 0) return -1
  if (current < 0) return backwards ? length - 1 : 0
  return (current + (backwards ? length - 1 : 1)) % length
}

interface GameOptionsDeps {
  canOpen: () => boolean
  onOpen: () => void
  onClose: () => void
  onLeave: () => void
  onLogout: () => void
  /** 房主暂停/继续正式对局（对局暂停时为「继续」，否则为「暂停」）。 */
  onPauseToggle: () => void
  /** 房主提前结算当前对局。 */
  onFinish: () => void
}

/** 对局内 Esc 选项层：只释放本机输入，服务器模拟与画面仍继续。 */
export class GameOptions {
  private readonly root = document.getElementById('game-options') as HTMLElement
  private readonly continueButton = document.getElementById('options-continue') as HTMLButtonElement
  private readonly muteButton = document.getElementById('options-audio-mute') as HTMLButtonElement
  private readonly volume = document.getElementById('options-audio-volume') as HTMLInputElement
  private readonly volumeValue = document.getElementById('options-volume-value') as HTMLOutputElement
  private readonly hostPanel = document.getElementById('options-host') as HTMLFieldSetElement
  private readonly pauseButton = document.getElementById('options-pause') as HTMLButtonElement
  private readonly finishButton = document.getElementById('options-finish') as HTMLButtonElement
  private previousFocus: HTMLElement | null = null

  constructor(private readonly deps: GameOptionsDeps) {
    this.continueButton.addEventListener('click', () => this.close())
    document.getElementById('options-leave')?.addEventListener('click', () => {
      this.close(false, false)
      deps.onLeave()
    })
    document.getElementById('options-logout')?.addEventListener('click', () => {
      this.close(false, false)
      deps.onLogout()
    })
    this.pauseButton.addEventListener('click', () => deps.onPauseToggle())
    this.finishButton.addEventListener('click', () => {
      this.close(false, false)
      deps.onFinish()
    })
    this.muteButton.addEventListener('click', () => {
      audio.setMuted(!audio.muted)
      this.reflectAudio()
    })
    this.volume.addEventListener('input', () => {
      audio.setVolume(Number(this.volume.value) / 100)
      this.reflectAudio()
    })
    this.root.addEventListener('keydown', event => this.onDialogKey(event))
  }

  get isOpen(): boolean { return !this.root.hidden }

  /**
   * 房主控制区可见性与按钮态：仅房主且正式对局进行中（含暂停中）显示。
   * paused 决定暂停按钮的文案（暂停对局 / 继续对局）与 aria-pressed。
   */
  setHostState(visible: boolean, paused: boolean): void {
    this.hostPanel.hidden = !visible
    this.pauseButton.textContent = paused ? '继续对局' : '暂停对局'
    this.pauseButton.setAttribute('aria-pressed', String(paused))
  }

  open(): boolean {
    if (this.isOpen || !this.deps.canOpen()) return false
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    this.reflectAudio()
    this.root.hidden = false
    this.deps.onOpen()
    this.continueButton.focus({ preventScroll: true })
    return true
  }

  close(restoreFocus = true, notify = true): void {
    if (!this.isOpen) return
    this.root.hidden = true
    const previous = this.previousFocus
    this.previousFocus = null
    if (restoreFocus && previous?.isConnected) previous.focus({ preventScroll: true })
    if (notify) this.deps.onClose()
  }

  /** 由入口的统一快捷键处理调用，确保聊天与编辑器先消费 Esc。 */
  handleGlobalKey(event: KeyboardEvent): boolean {
    if (!isOptionsEscape(event)) return false
    if (this.isOpen) {
      event.preventDefault()
      this.close()
      return true
    }
    const target = event.target
    if (target instanceof Element && target.closest(EDITING_TARGETS)) return false
    if (!this.open()) return false
    event.preventDefault()
    return true
  }

  private onDialogKey(event: KeyboardEvent): void {
    if (isOptionsEscape(event)) {
      event.preventDefault()
      event.stopPropagation()
      this.close()
      return
    }
    if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return
    const items = Array.from(this.root.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter(element => element.getClientRects().length > 0)
    if (!items.length) return
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next = nextFocusIndex(items.length, current, event.shiftKey)
    if (next < 0 || (current >= 0 && next !== 0 && next !== items.length - 1)) return
    event.preventDefault()
    items[next]?.focus({ preventScroll: true })
  }

  private reflectAudio(): void {
    const muted = audio.muted
    const volume = Math.round(audio.volume * 100)
    this.muteButton.textContent = muted ? '取消静音' : '静音'
    this.muteButton.setAttribute('aria-pressed', String(muted))
    this.volume.value = String(volume)
    this.volumeValue.value = `${volume}%`
    this.volumeValue.textContent = `${volume}%`
  }
}
