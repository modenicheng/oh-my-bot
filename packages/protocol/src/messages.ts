// 帧编解码辅助：protobuf 生成类型 + Transport 二进制帧的胶水。
// 帧协议（ADR-0012）：字节值权威源为生成枚举 TransportTiming
// （protocol/proto/omb.proto；Go 侧 server/internal/netws/handler.go 同源取值，
// 由两侧测试互钉：packages/protocol/test/golden.test.ts ↔ netws/timing_test.go）：
//   0x00 ping / 0x01 pong / 0x02 上行 ClientMsg / 0x03 下行 ServerMsg
import { toBinary, fromBinary } from '@bufbuild/protobuf'
import {
  ClientMsgSchema,
  ServerMsgSchema,
  EvControlNotice,
  EvControlNotice_Code,
  TransportTiming,
  type ClientMsg,
  type ServerMsg,
} from './gen/proto/omb_pb'

export const frame = {
  ping: TransportTiming.FRAME_PING,
  pong: TransportTiming.FRAME_PONG,
  up: TransportTiming.FRAME_UP,
  down: TransportTiming.FRAME_DOWN,
} as const

// 字符串协议（过渡期兼容，正解为结构化 control_notice 事件，见下）：进房被拒时
// 服务器同时下发 robot=0 的 EvSay "join failed: <原因>"（旧客户端解析路径）与
// EvControlNotice{code=CN_JOIN_FAILED}（新路径）。前缀常量与判定助手双侧共用
// （Go 侧 server/cmd/omb/main.go joinFailedPrefix），避免多处手抄漂移。
// 旧前缀仅作为旧服务器回退路径保留；两侧测试互钉（golden.test.ts ↔ cmd/omb）。
export const JOIN_FAILED_PREFIX = 'join failed:'

/** robot=0 系统发言且以 join failed 前缀开头时返回去掉前缀的原因，否则 undefined。 */
export function joinFailedReason(msg: ServerMsg): string | undefined {
  if (msg.payload.case === 'event' && msg.payload.value.kind.case === 'say') {
    const say = msg.payload.value.kind.value
    if (say.robot === 0 && say.text.startsWith(JOIN_FAILED_PREFIX)) {
      return say.text.slice(JOIN_FAILED_PREFIX.length).trim()
    }
  }
  return undefined
}

/** 结构化控制通知（审计 X-4）：join 拒绝 / AI 状态等控制面文案的机器可读形态。
 * 服务器过渡期对每条 notice 同时下发同文的 robot=0 EvSay；消费方应优先本事件，
 * 并对同文 say 去重（见 dedupeControlNoticeSay）。 */
export function controlNotice(msg: ServerMsg): EvControlNotice | undefined {
  if (msg.payload.case === 'event' && msg.payload.value.kind.case === 'controlNotice') {
    return msg.payload.value.kind.value
  }
  return undefined
}

/** join/spectate 拒绝类通知（终态：客户端应停止重试并展示原因）。
 * 结构化 CN_JOIN_FAILED/CN_READONLY_SPECTATOR 优先；旧服务器回退解析 say 前缀。 */
export function joinRejection(msg: ServerMsg): { code: EvControlNotice_Code; reason: string } | undefined {
  const notice = controlNotice(msg)
  if (notice && (notice.code === EvControlNotice_Code.CN_JOIN_FAILED || notice.code === EvControlNotice_Code.CN_READONLY_SPECTATOR)) {
    return { code: notice.code, reason: notice.text }
  }
  const reason = joinFailedReason(msg)
  return reason === undefined ? undefined : { code: EvControlNotice_Code.CN_JOIN_FAILED, reason }
}

/** 过渡期去重：紧随结构化 notice 的同文 robot=0 say 是旧客户端兼容副本。
 * 服务器按「notice 先、say 后」的固定顺序成对下发；新客户端消费 notice 后，
 * 同文 say 即可丢弃。notice 与 say 乱序到达时以 notice 为准，say 不会单独生效。 */
export function dedupeControlNoticeSay(msg: ServerMsg, lastNotice: EvControlNotice | undefined): boolean {
  if (msg.payload.case !== 'event' || msg.payload.value.kind.case !== 'say') return false
  const say = msg.payload.value.kind.value
  if (say.robot !== 0 || !lastNotice) return false
  return say.text === lastNotice.text || say.text.startsWith(JOIN_FAILED_PREFIX) && lastNotice.code === EvControlNotice_Code.CN_JOIN_FAILED && say.text === `${JOIN_FAILED_PREFIX} ${lastNotice.text}`
}

export function encodeClient(msg: ClientMsg): Uint8Array {
  const body = toBinary(ClientMsgSchema, msg)
  const out = new Uint8Array(1 + body.length)
  out[0] = frame.up
  out.set(body, 1)
  return out
}

export function decodeServer(data: Uint8Array): ServerMsg | null {
  if (data.length < 2 || data[0] !== frame.down) return null
  try {
    return fromBinary(ServerMsgSchema, data.subarray(1))
  } catch {
    return null
  }
}
