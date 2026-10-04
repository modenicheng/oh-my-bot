// 帧编解码辅助：protobuf 生成类型 + Transport 二进制帧的胶水。
// 帧协议（ADR-0012，与 server/internal/netws/handler.go 的 frame* 常量一致；
// 字节值由两侧测试互钉：packages/protocol/test/golden.test.ts ↔ netws/handler_test.go）：
//   0x00 ping / 0x01 pong / 0x02 上行 ClientMsg / 0x03 下行 ServerMsg
import { toBinary, fromBinary } from '@bufbuild/protobuf'
import { ClientMsgSchema, ServerMsgSchema, type ClientMsg, type ServerMsg } from './gen/proto/omb_pb'

export const frame = {
  ping: 0x00, pong: 0x01, up: 0x02, down: 0x03,
} as const

// 字符串协议（短期约定，非 wire 字段）：进房被拒时服务器以 robot=0 的 EvSay
// 下发 "join failed: <原因>"，客户端据此终止重试并展示原因。前缀常量与
// 判定助手双侧共用（Go 侧 server/cmd/omb/main.go joinFailedPrefix），
// 避免多处手抄漂移；正解为结构化 controlNotice 事件（见审计 X-4）。
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
