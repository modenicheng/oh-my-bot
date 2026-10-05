// 分轴来源 → 技能卡「脚本接管」视图（ADR-0009 仲裁结果的 HUD 投影）。
// 语义：琥珀色只标记「这一轴当前 tick 正由脚本/Snippet 输出」（move_src/turret_src
// 必发；fire_src/ability_src 缺失 = 旧服务器，不臆造，恒 false）。
// 输出归因与辅助模式分开：空轴不标记正在输出，但已启用自瞄应显示辅助待机。
import { ControlSource, type SelfState } from '@omb/protocol'
import { AXIS_AIM } from './input'

/** 各轴是否正被脚本/Snippet 接管（bit 对应技能卡组：move/aim/fire/ability）。 */
export interface AxisTakeover {
  move: boolean
  aim: boolean
  fire: boolean
  ability: boolean
}

const NO_TAKEOVER: AxisTakeover = { move: false, aim: false, fire: false, ability: false }

function scriptish(src: ControlSource | undefined): boolean {
  return src === ControlSource.CS_SCRIPT || src === ControlSource.CS_SNIPPET
}

export type AimControlStatus = 'unavailable' | 'manual' | 'standby' | 'aiming'

export const AIM_STATUS_TEXT: Record<AimControlStatus, string> = {
  unavailable: '—', manual: '手动瞄准', standby: '辅助待机', aiming: '辅助瞄准',
}

/** 「炮塔轴当前归脚本侧吗」的单一判定（C-28）：HUD 文案投影
 * （aimControlStatus）与输入采样 guard（controls.syncAimGuard）共用同一来源，
 * 消灭双投影漂移。参数语义：
 * - assistOn：辅助开启（guard 传本地镜像 input.assistOn，HUD 传服务器 self.assistOn）；
 * - aimCapable：瞄准能力信号（Workbench 上报，含 aimAt 调用或自瞄 Snippet）——
 *   在服务器 turret_src 回显之前就置位，保证先手 guard（本地先行时序）；
 * - turretSrc：服务器回显的炮塔来源，CS_SCRIPT/CS_SNIPPET 即已归脚本；
 * - holdsAim：人已持有炮塔轴（guard 传本地粘滞位；HUD 侧权威 manual 证据
 *   已在 aimControlStatus 前置分支处理，故恒传 false）。
 * 人持有轴（R 显式夺取或 manual_axes 置位）时 guard 必须让位。 */
export function isAimUnderScript(
  assistOn: boolean,
  aimCapable: boolean,
  turretSrc: ControlSource | undefined,
  holdsAim: boolean,
): boolean {
  return assistOn && (aimCapable || scriptish(turretSrc)) && !holdsAim
}

/** A loaded aim capability remains enabled even when this tick has no target/output. */
export function aimControlStatus(self: SelfState | undefined, aimCapable: boolean): AimControlStatus {
  if (!self) return 'unavailable'
  if (self.assistOn === false || self.turretSrc === ControlSource.CS_HUMAN || (self.manualAxesMask ?? 0) & AXIS_AIM) return 'manual'
  if (scriptish(self.turretSrc)) return 'aiming'
  // 权威 manual 证据已在上两行处理；此处的归属性走共享谓词，与 guard 同源。
  return isAimUnderScript(self.assistOn === true, aimCapable, self.turretSrc, false) ? 'standby' : 'manual'
}

/** SelfState（快照自机私有状态）→ 逐轴脚本接管位。self 缺失（未初始化）全 false。 */
export function axisTakeover(self: SelfState | undefined): AxisTakeover {
  if (!self) return NO_TAKEOVER
  return {
    move: scriptish(self.moveSrc),
    aim: scriptish(self.turretSrc),
    fire: scriptish(self.fireSrc),
    ability: scriptish(self.abilitySrc),
  }
}
