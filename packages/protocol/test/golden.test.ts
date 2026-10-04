import { describe, expect, it } from 'vitest'
import { toBinary, fromBinary, create } from '@bufbuild/protobuf'
import {
  ClientMsgSchema, ClientInputSchema, SnapshotDeltaSchema,
  ServerMsgSchema, ServerEventSchema, EvSaySchema, SimTuningSchema, EvControlNoticeSchema, EvControlNotice_Code,
  EvMapBootstrapSchema,
  type ClientMsg, type SnapshotDelta, type EvControlNotice,
} from '../src/gen/proto/omb_pb'
import { encodeClient, decodeServer, frame, JOIN_FAILED_PREFIX, joinFailedReason, controlNotice, joinRejection, dedupeControlNoticeSay } from '../src/messages'

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

// ---- SimTuning（X-3）：客户端兜底值与 Go 侧 simTuning() 黄金字节互钉 ----
// Go 侧断言：server/internal/glue/simtuning_notice_test.go TestSimTuningGoldenBytes。
// 两侧任一改值（sim 常量 / 兜底快照）都会使「服务器下发 = 客户端兜底」漂移暴露。
export const SIM_TUNING_GOLDEN = '083c10d00f18d00f21000000000000144028e00330f001390000000000003440'

describe('SimTuning golden (X-3)', () => {
  it('黄金字节与 Go simTuning() 一致', () => {
    const tuning = create(SimTuningSchema, {
      tickRate: 60, maxHpX10: 1000, maxEnergyX10: 1000, fireCost: 5,
      hackDurationTicks: 480, invulnDurationTicks: 240, visionRadius: 20,
    })
    expect(Buffer.from(toBinary(SimTuningSchema, tuning)).toString('hex')).toBe(SIM_TUNING_GOLDEN)
  })

  it('bootstrap 携带 tuning 且旧服务器缺省字段可探测', () => {
    const boot = create(EvMapBootstrapSchema, { mapJson: '{}', tuning: create(SimTuningSchema, { tickRate: 60 }) })
    const back = fromBinary(EvMapBootstrapSchema, toBinary(EvMapBootstrapSchema, boot))
    expect(back.tuning?.tickRate).toBe(60)
    const legacy = fromBinary(EvMapBootstrapSchema, toBinary(EvMapBootstrapSchema, create(EvMapBootstrapSchema, { mapJson: '{}' })))
    expect(legacy.tuning).toBeUndefined() // 旧服务器：客户端回退兜底值
  })
})

// ---- EvControlNotice（X-4）：结构化控制通知 + 兼容回退 ----

function noticeMsg(code: EvControlNotice_Code, text: string) {
  return create(ServerMsgSchema, {
    payload: { case: 'event', value: create(ServerEventSchema, {
      kind: { case: 'controlNotice', value: create(EvControlNoticeSchema, { code, text }) },
    }) },
  })
}

function sayMsg(robot: number, text: string) {
  return create(ServerMsgSchema, {
    payload: { case: 'event', value: create(ServerEventSchema, {
      kind: { case: 'say', value: create(EvSaySchema, { robot, text }) },
    }) },
  })
}

describe('EvControlNotice (X-4)', () => {
  it('controlNotice 提取 notice；非通知消息返回 undefined', () => {
    expect(controlNotice(noticeMsg(EvControlNotice_Code.CN_JOIN_FAILED, 'room full'))?.text).toBe('room full')
    expect(controlNotice(sayMsg(0, 'hello'))).toBeUndefined()
  })

  it('joinRejection 优先结构化 code，旧前缀 say 回退', () => {
    expect(joinRejection(noticeMsg(EvControlNotice_Code.CN_JOIN_FAILED, 'room full')))
      .toEqual({ code: EvControlNotice_Code.CN_JOIN_FAILED, reason: 'room full' })
    expect(joinRejection(noticeMsg(EvControlNotice_Code.CN_READONLY_SPECTATOR, 'readonly')))
      .toEqual({ code: EvControlNotice_Code.CN_READONLY_SPECTATOR, reason: 'readonly' })
    // 旧服务器：仅前缀 say
    expect(joinRejection(sayMsg(0, 'join failed: room full')))
      .toEqual({ code: EvControlNotice_Code.CN_JOIN_FAILED, reason: 'room full' })
    // AI 类 notice 不算 join 拒绝；普通发言不误判
    expect(joinRejection(noticeMsg(EvControlNotice_Code.CN_AI_EXPLAIN, 'AI 改动说明：x'))).toBeUndefined()
    expect(joinRejection(sayMsg(12, 'join failed: joke'))).toBeUndefined()
  })

  it('dedupeControlNoticeSay 丢弃成对下发的兼容 say 副本', () => {
    const notice = create(EvControlNoticeSchema, { code: EvControlNotice_Code.CN_JOIN_FAILED, text: 'room full' })
    // Go 侧兼容 say = "join failed: room full"（前缀 + 空格 + 同文）
    expect(dedupeControlNoticeSay(sayMsg(0, 'join failed: room full'), notice)).toBe(true)
    // AI notice 与同文 say
    const aiNotice = create(EvControlNoticeSchema, { code: EvControlNotice_Code.CN_AI_EXPLAIN, text: 'AI 改动说明：x' })
    expect(dedupeControlNoticeSay(sayMsg(0, 'AI 改动说明：x'), aiNotice)).toBe(true)
    // 无 notice、玩家发言、不同文案：不去重
    expect(dedupeControlNoticeSay(sayMsg(0, 'join failed: other'), notice)).toBe(false)
    expect(dedupeControlNoticeSay(sayMsg(12, 'join failed: room full'), notice)).toBe(false)
    expect(dedupeControlNoticeSay(sayMsg(0, 'join failed: room full'), undefined)).toBe(false)
  })

  it('notice 枚举值与 Go 侧 code 编号互钉', () => {
    // 与 protocol/proto/omb.proto 的 EvControlNotice.Code 编号一致；
    // Go 侧 simtuning_notice_test.go 断言同一组值。
    expect(EvControlNotice_Code.CN_JOIN_FAILED).toBe(1)
    expect(EvControlNotice_Code.CN_READONLY_SPECTATOR).toBe(2)
    expect(EvControlNotice_Code.CN_AI_REQUEST_FAILED).toBe(10)
    expect(EvControlNotice_Code.CN_AI_DISABLED).toBe(11)
    expect(EvControlNotice_Code.CN_AI_COMPILE_FAILED).toBe(12)
    expect(EvControlNotice_Code.CN_AI_STALE_SCRIPT).toBe(13)
    expect(EvControlNotice_Code.CN_AI_EXPLAIN).toBe(14)
  })
})
