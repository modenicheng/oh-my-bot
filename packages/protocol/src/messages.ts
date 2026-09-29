// 帧编解码辅助：protobuf 生成类型 + Transport 二进制帧的胶水。
// 帧协议（ADR-0012，与 server/internal/netws 一致）：
//   0x00 ping / 0x01 pong / 0x02 上行 ClientMsg / 0x03 下行 ServerMsg
import { toBinary, fromBinary } from '@bufbuild/protobuf'
import { ClientMsgSchema, ServerMsgSchema, type ClientMsg, type ServerMsg } from './gen/proto/omb_pb'

export const PROTOCOL_VERSION = 1

export const frame = {
  ping: 0x00, pong: 0x01, up: 0x02, down: 0x03,
} as const

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
