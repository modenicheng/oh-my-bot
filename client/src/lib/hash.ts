// 视觉噪声哈希（C-18）：startup-art / startup / feedback 三处像素噪声共享的
// 32 位乘法混合。只收敛常量与单步混合：输出必须与原逐处内联实现逐位一致
// （视觉冻结契约，见 hash.test.ts）；三处的 seed 组合语义不同，不做更激进的
// hash2d 统一。
export const HASH_MIX = 0x45d9f3b

/** 单轮 imul 混合，结果规范为 uint32。 */
export function hash32(value: number): number {
  return Math.imul(value, HASH_MIX) >>> 0
}
