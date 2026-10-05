// HTML 文本转义（& < > 三字符版）：manual 手册渲染、AI 面板未就绪回退与
// ai-markdown 三处语义逐字相同，收敛为单点。
// 引号刻意不转义：这些调用点全部落在元素文本节点（<pre><code>、figcaption），
// 保持源码原样；replay/library.ts 的列表项转义额外覆盖引号，语义不同，不共用。

/** 转义 & < > 三个 HTML 文本节点敏感字符；引号原样保留。 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
