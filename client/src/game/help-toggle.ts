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
  // 焦点不在编辑器/输入框内时，Esc 在捕获段消费（审计 C-32②）：帮助面板是
  // 非模态浮层，焦点移回画布后原 panel 级监听收不到 Esc，Esc 会落进选项层。
  const editing = '.monaco-editor, input, textarea, select, [contenteditable]'
  const onWindowEscape = (event: KeyboardEvent) => {
    if (panel.hidden || event.repeat || event.key !== 'Escape') return
    const target = event.target
    if (target instanceof Element && target.closest(editing)) return
    event.preventDefault()
    event.stopPropagation()
    const inside = panel.contains(document.activeElement)
    setOpen(false, inside)
  }
  const setOpen = (open: boolean, restoreFocus = false) => {
    panel.hidden = !open
    button.setAttribute('aria-expanded', String(open))
    if (open) {
      panel.focus({ preventScroll: true })
      window.addEventListener('keydown', onWindowEscape, true)
    } else {
      window.removeEventListener('keydown', onWindowEscape, true)
      if (restoreFocus) button.focus({ preventScroll: true })
    }
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
    dispose: () => {
      button.removeEventListener('click', toggle)
      panel.removeEventListener('keydown', keydown)
      window.removeEventListener('keydown', onWindowEscape, true)
    },
  }
}
