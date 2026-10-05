// DOM 叶子工具：按 id 取元素、等值守卫写入、时钟格式化。
// 既有调用方失败策略不同，这里同时提供两档：
// - `$`(document)/`el`(root.querySelector) 假定元素必然存在，缺失即 TypeError；
// - `requireEl` 缺失抛带 id 的中文错误（HUD 初始化即失败）；
// - `setText` 对 undefined 容忍（回放视图 DOM 可裁剪）。

/** 全文档按 id 取元素：调用方假定静态视图元素必然存在。 */
export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

/** 子树内按 id 取元素：live/workbench 等以面板为根的视图用。 */
export const el = <T extends HTMLElement>(root: HTMLElement, id: string): T =>
  root.querySelector<T>(`#${id}`)!

/** 子树内按 id 取元素，缺失抛错并指明缺失的 id。 */
export function requireEl<T extends HTMLElement>(root: HTMLElement, id: string): T {
  const found = root.querySelector(`#${id}`) as T | null
  if (!found) throw new Error(`HUD 缺少元素 #${id}`)
  return found
}

/**
 * 等值守卫写入：textContent 同值写入也会替换文本节点并触发无效变更，
 * 高频路径（HUD 每帧/回放每 tick）先比较再写。
 * el 为 undefined 时静默跳过（回放视图部分 DOM 节点可被裁剪）。
 */
export function setText(target: HTMLElement | undefined, text: string): void {
  if (target && target.textContent !== text) target.textContent = text
}

/** 秒 → m:ss（负数钳为 0，HUD 时钟与回放时间轴共用）。 */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
