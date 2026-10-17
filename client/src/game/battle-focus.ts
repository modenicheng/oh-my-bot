/** Battle buttons share focus with the canvas; text panels never do. */
export function hasBattleFocus(active: Element | null, canvas: HTMLCanvasElement): boolean {
  if (active === canvas) return true
  if (!active || !canvas.parentElement?.contains(active)) return false
  if (active.closest('input, textarea, select, [contenteditable], [role="textbox"], #workbench, #game-chat')) return false
  return active.closest('[data-battle-control]') !== null
}
