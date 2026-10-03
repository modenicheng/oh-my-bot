import { describe, expect, it } from 'vitest'
import { renderAiMarkdown } from './ai-markdown'

describe('renderAiMarkdown', () => {
  it('渲染 Markdown 并高亮 JavaScript 代码块', () => {
    const html = renderAiMarkdown('## 修改\n\n```js\nconst hp = bot.self.hp\n```')
    expect(html).toContain('<h2>修改</h2>')
    expect(html).toContain('ai-code-frame')
    expect(html).toContain('JavaScript')
    expect(html).toContain('hljs-keyword')
  })

  it('流式代码围栏未闭合时仍渲染为代码块', () => {
    const html = renderAiMarkdown('```ts\nconst target: number = 1', true)
    expect(html).toContain('TypeScript')
    expect(html).toContain('hljs-keyword')
    expect(html).toContain('target')
  })

  it('原始 HTML 仅作为文本显示', () => {
    const html = renderAiMarkdown('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img src=')
    expect(html).toContain('&lt;img')
  })
})
