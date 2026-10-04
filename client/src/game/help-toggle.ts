export interface HelpToggle {
  close: (restoreFocus?: boolean) => void
  dispose: () => void
}

export type HelpAction = 'toggle' | 'escape' | 'leave'

/** 纯状态转换；DOM 绑定与浏览器焦点行为由 bindHelpToggle 负责。 */
export function nextHelpOpen(open: boolean, action: HelpAction): boolean {
  return action === 'toggle' ? !open : false
}

/** 静态 HUD 操作帮助：默认折叠，点击切换，Esc 关闭并把焦点还给 ? 按钮。 */
export function bindHelpToggle(button: HTMLButtonElement, panel: HTMLElement): HelpToggle {
  const setOpen = (open: boolean, restoreFocus = false) => {
    panel.hidden = !open
    button.setAttribute('aria-expanded', String(open))
    if (open) panel.focus({ preventScroll: true })
    else if (restoreFocus) button.focus({ preventScroll: true })
  }
  const toggle = () => setOpen(nextHelpOpen(!panel.hidden, 'toggle'), false)
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.repeat || panel.hidden) return
    event.preventDefault()
    event.stopPropagation()
    setOpen(false, true)
  }
  button.addEventListener('click', toggle)
  panel.addEventListener('keydown', keydown)
  setOpen(false)
  return {
    close: (restoreFocus = false) => setOpen(false, restoreFocus),
    dispose: () => { button.removeEventListener('click', toggle); panel.removeEventListener('keydown', keydown) },
  }
}
