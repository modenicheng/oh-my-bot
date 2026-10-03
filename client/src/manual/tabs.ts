// 手册代码 tab 组的交互绑定。独立于 render.ts（marked 渲染）：手册视图构造期
// 就要同步绑定，而 marked 只在首篇文档渲染时才动态加载（见 manual.ts）。

/** tab 点击切换（容器级事件委托，渲染容器绑定一次）。 */
export function bindTabInteractions(root: HTMLElement): void {
  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.code-tab')
    if (!btn) return
    const group = btn.closest<HTMLElement>('.code-tab-group')
    if (!group) return
    const idx = btn.dataset.tab
    group.querySelectorAll<HTMLElement>('.code-tab').forEach((t) => {
      const on = t.dataset.tab === idx
      t.classList.toggle('active', on)
      t.setAttribute('aria-selected', String(on))
    })
    group.querySelectorAll<HTMLElement>('.code-panel').forEach((p) => {
      p.classList.toggle('active', p.dataset.panel === idx)
    })
  })
}
