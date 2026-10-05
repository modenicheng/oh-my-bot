// 数值微函数的唯一定义：clamp/clamp01/lerp/lerpAngle 的语义被 HUD、相机、
// 回放插值与音乐合成共同依赖，各处不再保留内联等价物。

/** 三点钳制：越界回边界，NaN 原样通过（比较失败短路）。 */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** [0,1] 钳制：进度/比例专用。 */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** 线性插值：t=0 得 a，t=1 得 b。 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 最短弧插值：跨 ±π 的角度过渡不绕远（回放朝向平滑用）。 */
export function lerpAngle(a: number, b: number, t: number): number {
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a))
  return a + delta * t
}
