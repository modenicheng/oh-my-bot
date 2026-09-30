// Hand-drawn UI glyphs on one 16×16 pixel grid. Paths contain integer, axis-aligned steps.
// DOM and canvas use the same geometry; labels stay on the surrounding control.
const paths = {
  play: 'M4 2h2v2h3v2h3v2h2v2h-2v2H9v2H6v2H4Z',
  pause: 'M3 2h4v12H3ZM10 2h4v12h-4Z',
  back: 'M6 2h2v4h6v4H8v4H6v-2H4v-2H2V6h2V4h2Z',
  forward: 'M8 2h2v2h2v2h2v4h-2v2h-2v2H8v-4H2V6h6Z',
  rewind: 'M1 3h2v10H1ZM7 3h2v10H7v-2H5V9H3V7h2V5h2ZM13 3h2v10h-2v-2h-2V9H9V7h2V5h2Z',
  fastForward: 'M13 3h2v10h-2ZM1 3h2v2h2v2h2v2H5v2H3v2H1ZM7 3h2v2h2v2h2v2h-2v2H9v2H7Z',
  book: 'M1 2h5v1h4V2h5v11h-5v1H6v-1H1Zm2 2v7h3v1h1V5H6V4Zm6 1v7h1v-1h3V4h-3v1Z',
  replay: 'M5 1h7v2h2v2h1v7h-2v2h-2v1H5v-2H3v-2H1V7h2v4h2v2h6v-2h2V5h-2V3H5v2h2v2H1V1h2v2h2Z',
  target: 'M7 0h2v3h3v1h1v3h3v2h-3v3h-1v1H9v3H7v-3H4v-1H3V9H0V7h3V4h1V3h3ZM5 5v6h6V5Zm2 2h2v2H7Z',
  partner: 'M1 3h6v2h2V3h6v10H9v-2H7v2H1Zm2 2v6h2V9h6v2h2V5h-2v2H5V5Z',
  heart: 'M3 2h3v2h4V2h3v2h2v5h-2v2h-2v2H9v2H7v-2H5v-2H3V9H1V4h2Z',
  energy: 'M8 1h4v2h-2v2H8v2h5v2h-2v2H9v2H7v2H4v-2h2v-2h2V9H3V7h2V5h1V3h2Z',
  skull: 'M4 1h8v2h2v8h-2v4h-2v-2H9v2H7v-2H6v2H4v-4H2V3h2Zm0 4v3h3V5Zm5 0v3h3V5ZM7 9v2h2V9Z',
  trophy: 'M4 1h8v2h3v6h-3v2H9v2h3v2H4v-2h3v-2H4V9H1V3h3Zm-1 4v2h2V5Zm8 0v2h2V5Z',
  chevron: 'M5 2h2v2h2v2h2v4H9v2H7v2H5v-4h2V6H5Z',
} as const
export type IconName = keyof typeof paths

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('class', 'pixel-icon')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('shape-rendering', 'crispEdges')
  svg.dataset.icon = name
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('fill', 'currentColor')
  path.setAttribute('fill-rule', 'evenodd')
  path.setAttribute('d', paths[name])
  svg.append(path)
  return svg
}

export function mountIcons(root: ParentNode): void {
  for (const slot of root.querySelectorAll<HTMLElement>('span[data-icon]')) {
    const name = slot.dataset.icon as IconName
    if (name in paths) slot.replaceWith(icon(name))
  }
}

export function iconButton(button: HTMLElement, name: IconName, label: string): void {
  button.replaceChildren(icon(name))
  button.setAttribute('aria-label', label)
  button.setAttribute('title', label)
}

const canvasPaths = new Map<IconName, Path2D>()
export function drawIcon(ctx: CanvasRenderingContext2D, name: IconName, x: number, y: number, size: number): void {
  let path = canvasPaths.get(name)
  if (!path) { path = new Path2D(paths[name]); canvasPaths.set(name, path) }
  ctx.save(); ctx.translate(x - size / 2, y - size / 2); ctx.scale(size / 16, size / 16)
  ctx.fill(path, 'evenodd'); ctx.restore()
}
