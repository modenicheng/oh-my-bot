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

/** A loaded aim capability remains enabled even when this tick has no target/output. */
export function aimControlStatus(self: SelfState | undefined, aimCapable: boolean): AimControlStatus {
  if (!self) return 'unavailable'
  if (self.assistOn === false || self.turretSrc === ControlSource.CS_HUMAN || (self.manualAxesMask ?? 0) & AXIS_AIM) return 'manual'
  if (scriptish(self.turretSrc)) return 'aiming'
  return self.assistOn && aimCapable ? 'standby' : 'manual'
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
