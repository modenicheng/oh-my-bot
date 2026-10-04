// Go encoding/json 叶片字段读取：无 json tag 的结构体（Vec2 的 X/Y、Rect 的
// Min/Max）序列化为大写键名，客户端按「大写优先、小写兼容」读取。
// 两套守卫策略并存，语义刻意不同，调用方按数据源选用：
// - 严格版（goNum/goVec2）：非有限数字一律回退默认值，不做隐式转换——
//   mapdef 与回放 checkpoint 解析共用，坏数据退 0 而不是带毒前移。
// - 宽容版（goVec2Lenient）：走 Number() 强转，与 replay 索引的 numOr 同族，
//   兼容历史回放/脚本路径；无法强转的成分得 NaN，维持既有行为。

type Raw = Record<string, unknown>

function asRaw(v: unknown): Raw {
  return v !== null && typeof v === 'object' ? (v as Raw) : {}
}

/** 严格数字读取：非有限数字（字符串/NaN/null/undefined）回退 dflt。 */
export function goNum(v: unknown, dflt = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}

/** Go Vec2 → {x,y}（严格）：大写 X/Y 优先、小写兼容，非法成分回退 0。 */
export function goVec2(v: unknown): { x: number; y: number } {
  const r = asRaw(v)
  return { x: goNum(r['X'] ?? r['x']), y: goNum(r['Y'] ?? r['y']) }
}

/** Go Vec2 → {x,y}（宽容）：Number() 强转，接受数字型字符串；缺键回退 0。 */
export function goVec2Lenient(v: unknown): { x: number; y: number } {
  const r = asRaw(v)
  return { x: Number(r['X'] ?? r['x'] ?? 0), y: Number(r['Y'] ?? r['y'] ?? 0) }
}
