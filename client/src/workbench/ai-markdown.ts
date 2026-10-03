import { Marked, Renderer, type Tokens } from 'marked'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('markdown', markdown)
hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' })
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' })
hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' })
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' })
hljs.registerAliases(['md'], { languageName: 'markdown' })

const LANGUAGE_LABELS: Record<string, string> = {
  javascript: 'JavaScript', js: 'JavaScript', jsx: 'JSX',
  typescript: 'TypeScript', ts: 'TypeScript', tsx: 'TSX',
  bash: 'Shell', sh: 'Shell', shell: 'Shell', zsh: 'Shell',
  json: 'JSON', css: 'CSS', xml: 'HTML', html: 'HTML', svg: 'SVG',
  markdown: 'Markdown', md: 'Markdown',
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function languageName(raw: string | undefined): string {
  return (raw ?? '').trim().split(/\s+/, 1)[0]?.toLowerCase() ?? ''
}

/** 流式渲染标记：流式期间同一代码块会被反复重渲染，最贵的 highlightAuto 路径退化为纯文本。 */
let streamingRender = false

function highlightCode(code: string, language: string): string {
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value
  }
  // 流式期间未标语言的代码块跳过 highlightAuto（会尝试全部已注册语言），
  // 结束后的最终渲染补全高亮。
  if (streamingRender) return escapeHtml(code)
  return hljs.highlightAuto(code).value
}

const renderer = new Renderer()
renderer.html = ({ text }: Tokens.HTML) => escapeHtml(text)
renderer.code = ({ text, lang }: Tokens.Code) => {
  const language = languageName(lang)
  const label = LANGUAGE_LABELS[language] ?? (language ? language.toUpperCase() : 'CODE')
  const highlighted = highlightCode(text, language)
  return `<figure class="ai-code-frame" data-language="${escapeHtml(label)}"><figcaption>${escapeHtml(label)}</figcaption><pre tabindex="0"><code class="hljs${language ? ` language-${escapeHtml(language)}` : ''}">${highlighted}</code></pre></figure>`
}
renderer.link = (token: Tokens.Link) => {
  const rendered = Renderer.prototype.link.call(renderer, token)
  return rendered.replace('<a ', '<a target="_blank" rel="noreferrer noopener" ')
}

const markdownRenderer = new Marked({ gfm: true, breaks: true, renderer })

function closeStreamingFence(source: string): string {
  const fences = source.match(/^\s*```/gm)?.length ?? 0
  return fences % 2 === 1 ? `${source}\n\n\`\`\`` : source
}

export function renderAiMarkdown(source: string, streaming = false): string {
  if (!source) return ''
  const markdown = streaming ? closeStreamingFence(source) : source
  streamingRender = streaming
  try {
    return markdownRenderer.parse(markdown, { async: false }) as string
  } finally {
    streamingRender = false
  }
}
