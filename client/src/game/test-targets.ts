// 共享测试靶件（C-16）：input.test / takeover.test 的最小 DOM 事件靶。
// EventTarget 提供 dispatch/listener；closest/getBoundingClientRect 桩满足
// InputSampler.attach 的类型与坐标换算（rect 值可变，供 resize 用例覆写）。
export class Target extends EventTarget {
  closest(): null { return null }
  rect = { left: 40, top: 20, width: 800, height: 500 }
  getBoundingClientRect() { return this.rect }
}

/** 派发一个可取消的裸事件；用 defineProperty 注入 mouse/keyboard 字段。 */
export function send(target: EventTarget, type: string, props: Record<string, unknown> = {}): void {
  const event = new Event(type, { cancelable: true })
  for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value })
  target.dispatchEvent(event)
}
