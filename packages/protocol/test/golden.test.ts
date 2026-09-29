import { describe, expect, it } from 'vitest'
import { toBinary, fromBinary, create } from '@bufbuild/protobuf'
import {
  ClientMsgSchema, ClientInputSchema, SnapshotDeltaSchema,
  type ClientMsg, type SnapshotDelta,
} from '../src/gen/proto/omb_pb'
import { encodeClient, decodeServer, frame } from '../src/messages'

// 跨语言契约黄金字节：Go 侧（server/internal/protocol/protocol_test.go）断言同一 hex。
// ClientMsg{input:{seq:42, move_x:500, move_y:-500, fire:true, aim:1.5}}
export const GOLDEN = '0a1b082a10f403188cfcffffffffffffff01200129000000000000f83f'

describe('frame + protobuf round-trip', () => {
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
