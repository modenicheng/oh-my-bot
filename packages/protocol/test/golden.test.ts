import { describe, expect, it } from 'vitest'
import { toBinary, fromBinary, create } from '@bufbuild/protobuf'
import {
  ClientMsgSchema, ClientInputSchema, SnapshotDeltaSchema,
  ServerMsgSchema, ServerEventSchema, EvSaySchema,
  type ClientMsg, type SnapshotDelta,
} from '../src/gen/proto/omb_pb'
import { encodeClient, decodeServer, frame, JOIN_FAILED_PREFIX, joinFailedReason } from '../src/messages'

// 跨语言契约黄金字节：Go 侧（server/internal/protocol/protocol_test.go）断言同一 hex。
// ClientMsg{input:{seq:42, move_x:500, move_y:-500, fire:true, aim:1.5}}
export const GOLDEN = '0a1b082a10f403188cfcffffffffffffff01200129000000000000f83f'

describe('frame + protobuf round-trip', () => {
  // 帧字节互钉：与 server/internal/netws/handler_test.go 的 TestFrameBytesPinned 断言同一组值。
  // ADR-0012 首字节帧协议，任一侧改动都会在此失败。
  it('帧字节与 Go netws 常量互钉（ADR-0012）', () => {
    expect(frame).toEqual({ ping: 0x00, pong: 0x01, up: 0x02, down: 0x03 })
  })

  // join failed 前缀字符串协议：与 server/cmd/omb/main.go 的 joinFailedPrefix 常量
  // （spectate_test.go 断言真实下发）保持同一前缀。任一侧改动都会在两侧测试失败。
  it('join failed 前缀与 Go 侧 joinFailedPrefix 互钉', () => {
    expect(JOIN_FAILED_PREFIX).toBe('join failed:')
  })

  it('joinFailedReason 只认 robot=0 系统发言', () => {
    const say = (robot: number, text: string) => create(ServerMsgSchema, {
      payload: { case: 'event', value: create(ServerEventSchema, {
        kind: { case: 'say', value: create(EvSaySchema, { robot, text }) },
      }) },
    })
    expect(joinFailedReason(say(0, 'join failed: room full'))).toBe('room full')
    expect(joinFailedReason(say(12, 'join failed: joke'))).toBeUndefined()
    expect(joinFailedReason(say(0, 'hello'))).toBeUndefined()
  })

  it('golden bytes 与 Go 生成一致', () => {
    const input = create(ClientInputSchema, { seq: 42, moveX: 500, moveY: -500, fire: true, aim: 1.5 })
    const msg = create(ClientMsgSchema, { payload: { case: 'input', value: input } })
    expect(Buffer.from(toBinary(ClientMsgSchema, msg)).toString('hex')).toBe(GOLDEN)
  })

  it('encodeClient 前缀 0x02 且可解回', () => {
    const input = create(ClientInputSchema, { seq: 42, moveX: 500, moveY: -500, fire: true, aim: 1.5 })
    const msg = create(ClientMsgSchema, { payload: { case: 'input', value: input } })
    const bin = encodeClient(msg)
    expect(bin[0]).toBe(frame.up)
    const back = fromBinary(ClientMsgSchema, bin.subarray(1))
    if (back.payload.case !== 'input') throw new Error('case')
    expect(back.payload.value.seq).toBe(42)
    expect(back.payload.value.moveX).toBe(500)
    expect(back.payload.value.fire).toBe(true)
  })

  it('decodeServer 拒绝坏帧', () => {
    expect(decodeServer(new Uint8Array([0x00, 1, 2]))).toBeNull()
    expect(decodeServer(new Uint8Array([0x03, 0xff]))).toBeNull()
  })

  it('snapshot delta 携带 tombstone 与 ackSeq', () => {
    const snap = create(SnapshotDeltaSchema, {
      tick: 7200, ackSeq: 99, phase: 2, timeLeftS: 240, full: false,
      robotGone: [7],
    })
    const back = fromBinary(SnapshotDeltaSchema, toBinary(SnapshotDeltaSchema, snap))
    expect(back.robotGone).toEqual([7])
    expect(back.ackSeq).toBe(99)
    expect(back.phase).toBe(2)
  })
})
