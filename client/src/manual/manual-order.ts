// 目录树排序工具：复刻服务端 manual_index.go 的排序规则，客户端仅作兜底
// （服务端已排好序；离线示例或异常数据仍按同一规则展示）。
import type { ManualNode } from './manual'

/**
 * 排序规则（与服务端一致）：
 * 1. 有 order 的节点在前，按 order 升序（0/负数均为有效值）；
 * 2. 同值 order 按 path 字典序稳定排序；
 * 3. 无 order 的节点排在所有有序节点之后，按 path 字典序。
 */
export function sortManualNodes(nodes: ManualNode[]): ManualNode[] {
  return [...nodes].sort((a, b) => {
    const ao = typeof a.order === 'number' && Number.isFinite(a.order)
    const bo = typeof b.order === 'number' && Number.isFinite(b.order)
    if (ao && bo && a.order !== b.order) return a.order! - b.order!
    if (ao !== bo) return ao ? -1 : 1
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })
}

/** 递归补齐 children 默认值并按上述规则排序（返回新数组，不修改入参）。 */
export function normalizeManualTree(nodes: Array<Partial<ManualNode> & { path: string; title: string }>): ManualNode[] {
  const out: ManualNode[] = nodes.map((n) => ({
    ...n,
    order: typeof n.order === 'number' && Number.isFinite(n.order) ? n.order : undefined,
    children: n.children ? normalizeManualTree(n.children) : [],
  }))
  return sortManualNodes(out)
}
