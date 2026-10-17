type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: 'landscape') => Promise<void>
  unlock?: () => void
}

/** Orientation is a viewport gate, never a requirement for fullscreen API support. */
export class OrientationGate {
  private disposed = false
  private locked = false
  private readonly orientation = window.screen?.orientation as LockableOrientation | undefined
  private readonly viewport = window.visualViewport
  private readonly change = (): void => { if (!this.disposed) this.onChange() }

  constructor(private readonly root: HTMLElement, private readonly onChange: () => void) {
    window.addEventListener('resize', this.change)
    window.addEventListener('orientationchange', this.change)
    window.addEventListener('landscapechange', this.change)
    this.orientation?.addEventListener('change', this.change)
    this.viewport?.addEventListener('resize', this.change)
    this.viewport?.addEventListener('scroll', this.change)
    document.addEventListener('fullscreenchange', this.change)
  }

  get portrait(): boolean { return window.innerHeight > window.innerWidth }

  /** Call only inside a user gesture. Keep sibling options/chat inside fullscreen. */
  async requestLandscape(): Promise<void> {
    if (this.disposed) return
    const surface = this.root.closest<HTMLElement>('#view-game') ?? this.root
    try {
      if (!document.fullscreenElement && surface.requestFullscreen) await surface.requestFullscreen()
    } catch { /* Rejection is normal on iOS, embedded pages, or denied permission. */ }
    if (this.disposed) return
    try {
      if (this.orientation?.lock) {
        await this.orientation.lock('landscape')
        if (this.disposed) this.orientation.unlock?.()
        else this.locked = true
      }
    } catch { /* Already-landscape play needs no orientation lock. */ }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('resize', this.change)
    window.removeEventListener('orientationchange', this.change)
    window.removeEventListener('landscapechange', this.change)
    this.orientation?.removeEventListener('change', this.change)
    this.viewport?.removeEventListener('resize', this.change)
    this.viewport?.removeEventListener('scroll', this.change)
    document.removeEventListener('fullscreenchange', this.change)
    if (this.locked) {
      try { this.orientation?.unlock?.() } catch { /* Optional enhancement. */ }
    }
  }
}
