// 分轴来源 → 技能卡「脚本接管」视图（ADR-0009 仲裁结果的 HUD 投影）。
// 语义：琥珀色只标记「这一轴当前 tick 正由脚本/Snippet 输出」（move_src/turret_src
// 必发；fire_src/ability_src 缺失 = 旧服务器，不臆造，恒 false）。
// 人类轴与空轴（'-'）不标记——辅助开着但脚本没在动的轴不算“正在被接管”，
// 人一按键即刻抢占，标琥珀反而误导。间歇发指令的脚本会闪烁，属于如实反馈。
import { ControlSource, type SelfState } from '@omb/protocol'

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
