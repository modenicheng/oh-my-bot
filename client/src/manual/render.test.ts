import { describe, expect, it } from 'vitest'
import { manualImageURL, renderMarkdown } from './render'

describe('manualImageURL', () => {
  it('keeps absolute, data, anchor and protocol URLs untouched', () => {
    for (const href of ['/api/manual/x.png', 'https://example.com/a.png', 'data:image/png;base64,AA', '#frag', 'mailto:a@b.c']) {
      expect(manualImageURL(href, 'start/prepare.md')).toBe(href)
    }
  })

  it('resolves same-directory and ./ paths', () => {
    expect(manualImageURL('images/a.png', 'reference/visual.md')).toBe('/api/manual/reference/images/a.png')
    expect(manualImageURL('./b.webp', 'rules/controls.md')).toBe('/api/manual/rules/b.webp')
  })

  it('resolves ../ across chapters, including repeated segments', () => {
    expect(manualImageURL('../reference/images/diagrams/map.png', 'start/prepare.md'))
      .toBe('/api/manual/reference/images/diagrams/map.png')
    expect(manualImageURL('../../reference/images/icons/fire.png', 'start/deep/page.md'))
      .toBe('/api/manual/reference/images/icons/fire.png')
  })
})

describe('renderMarkdown image rewriting', () => {
  it('rewrites cross-chapter markdown images', () => {
    const html = renderMarkdown('![地图](../reference/images/diagrams/map.png)', 'start/prepare.md')
    expect(html).toContain('src="/api/manual/reference/images/diagrams/map.png"')
  })

  it('rewrites inline HTML icons and keeps their attributes', () => {
    const html = renderMarkdown(
      '开火 <img class="inline-icon" src="../reference/images/icons/fire.png" width="16" height="16" alt=""> 之后',
      'rules/controls.md',
    )
    expect(html).toContain('class="inline-icon"')
    expect(html).toContain('src="/api/manual/reference/images/icons/fire.png"')
    expect(html).toContain('width="16"')
  })

  it('rewrites single-quoted inline HTML icons and skips SVG', () => {
    const png = renderMarkdown("<img src='../reference/images/icons/heart.png'>", 'code/bot-scripting.md')
    expect(png).toContain("src='/api/manual/reference/images/icons/heart.png'")
    const svg = renderMarkdown('<img src="asset.svg">', 'rules/game-rules.md')
    expect(svg).toContain('src="asset.svg"')
  })

  it('rewrites icons inside headings', () => {
    const html = renderMarkdown('## <img class="inline-icon" src="../reference/images/icons/shield.png" alt=""> 护盾', 'rules/game-rules.md')
    expect(html).toContain('<h2')
    expect(html).toContain('src="/api/manual/reference/images/icons/shield.png"')
  })

  it('rewrites icons inside table cells and list items', () => {
    const table = renderMarkdown('| 玩法 | 说明 |\n|---|---|\n| <img class="inline-icon" src="../reference/images/icons/target.png" alt=""> 手操 | 用键盘鼠标 |', 'start/prepare.md')
    expect(table).toContain('<td><img loading="lazy" decoding="async" class="inline-icon" src="/api/manual/reference/images/icons/target.png"')
    const list = renderMarkdown('- <img class="inline-icon" src="images/icons/fire.png" alt=""> 开火', 'rules/controls.md')
    expect(list).toContain('src="/api/manual/rules/images/icons/fire.png"')
  })

  it('adds lazy loading to rendered images', () => {
    const html = renderMarkdown('![截图](images/sheet-arena.png)', 'reference/visual.md')
    expect(html).toContain('<img loading="lazy" decoding="async"')
  })
})

describe('renderMarkdown code blocks', () => {
  it('renders a plain fence with its language label', () => {
    const html = renderMarkdown('```ts\nconst a = 1\n```', 'reference/actions.md')
    expect(html).toContain('class="codeblock"')
    expect(html).toContain('data-lang="TS"')
  })

  it('folds consecutive fences after a ts|js header into a tab group', () => {
    const src = '```ts|js\n两种写法示例。\n```\n```ts\nconst a: number = 1\n```\n```js\nconst a = 1\n```'
    const html = renderMarkdown(src, 'reference/actions.md')
    expect(html).toContain('class="code-tab-group"')
    expect(html).toContain('>TS</button>')
    expect(html).toContain('>JS</button>')
    expect(html).toContain('const a: number = 1')
    expect(html).toContain('const a = 1')
  })
})
