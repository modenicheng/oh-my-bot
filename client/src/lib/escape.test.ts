import { describe, expect, it } from 'vitest'
import { escapeHtml } from './escape'

// 三字符转义是 manual/ai 面板共用的文本节点语义；引号刻意不转义
// （replay/library 的五字符版本语义不同，不共用，勿在此加引号断言）。

describe('escapeHtml', () => {
  it('转义 & < >，引号与单引号原样保留', () => {
    expect(escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;')
    expect(escapeHtml('a "q" \'s\'')).toBe(`a "q" 's'`)
  })

  it('& 最先转义，避免二次转义产出 &amp;lt;', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
    expect(escapeHtml('')).toBe('')
  })
})
