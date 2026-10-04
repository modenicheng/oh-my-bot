import { describe, expect, it } from 'vitest'
import { toBinary, fromBinary, create } from '@bufbuild/protobuf'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ClientMsgSchema, ClientInputSchema, SnapshotDeltaSchema,
  ServerMsgSchema, ServerEventSchema, EvSaySchema,
  SimTuningSchema, EvControlNoticeSchema, EvControlNotice_Code,
  EvMapBootstrapSchema, TransportTiming,
  ReplaySchemaVersion, ReplayRecordType, ReplayVisualVersion,
  ScriptOrigin, EvScriptVersionSchema, EvScriptVersionsSchema,
  EvScriptRollbackResultSchema, ScriptRollbackSchema, EvScriptResultSchema,
  type ClientMsg, type SnapshotDelta, type EvControlNotice,
} from '../src/gen/proto/omb_pb'
import { encodeClient, decodeServer, frame, JOIN_FAILED_PREFIX, joinFailedReason, controlNotice, joinRejection, dedupeControlNoticeSay } from '../src/messages'
import { REPLAY_SCHEMA_VERSION, replayRecordDiskName, replayRecordTypeFromDisk, decodeVisualFrameV2 } from '../src/replay'

// 回放/契约测试运行于 vitest（Node）环境；node:fs/node:url 仅用于读取权威源文本。
// （同 client/src/replay/test/replay.test.ts 的既有做法。）

// 跨语言契约黄金字节：Go 侧（server/internal/protocol/protocol_test.go）断言同一 hex。
// ClientMsg{input:{seq:42, move_x:500, move_y:-500, fire:true, aim:1.5}}
export const GOLDEN = '0a1b082a10f403188cfcffffffffffffff01200129000000000000f83f'

describe('frame + protobuf round-trip', () => {
  // 帧字节互钉：与 server/internal/netws 的 TestFrameBytesPinned / TestTransportTimingPinned
  // 断言同一组值。ADR-0012 首字节帧协议，任一侧改动都会在此失败。
  it('帧字节与 Go netws 常量互钉（ADR-0012）', () => {
    expect(frame).toEqual({ ping: 0x00, pong: 0x01, up: 0x02, down: 0x03 })
  })

  // 心跳/时序参数漂移对拍（审计 X-5）：单一权威源为生成枚举 TransportTiming
  // （protocol/proto/omb.proto；Go 侧 server/internal/netws/timing_test.go 四向互钉）。
  // 与 Go 侧 TestTransportTimingPinned 断言同一组数值；任一侧改动都会双侧失败。
  it('心跳/时序常量与权威源和 Go 侧互钉（X-5）', () => {
    expect({
      framePing: TransportTiming.FRAME_PING,
      framePong: TransportTiming.FRAME_PONG,
      frameUp: TransportTiming.FRAME_UP,
      frameDown: TransportTiming.FRAME_DOWN,
      connectTimeoutMs: TransportTiming.CONNECT_TIMEOUT_MS,
      pingIntervalMs: TransportTiming.PING_INTERVAL_MS,
      livenessTimeoutMs: TransportTiming.LIVENESS_TIMEOUT_MS,
      livenessCheckMs: TransportTiming.LIVENESS_CHECK_MS,
      serverReadTimeoutMs: TransportTiming.SERVER_READ_TIMEOUT_MS,
      serverWriteTimeoutMs: TransportTiming.SERVER_WRITE_TIMEOUT_MS,
    }).toEqual({
      framePing: 0x00,
      framePong: 0x01,
      frameUp: 0x02,
      frameDown: 0x03,
      connectTimeoutMs: 8000,
      pingIntervalMs: 2000,
      livenessTimeoutMs: 8000,
      livenessCheckMs: 1000,
      serverReadTimeoutMs: 10000,
      serverWriteTimeoutMs: 2000,
    })
  })

  // 生成代码与权威源 .proto 文本互拍：改 proto 忘跑 buf generate 时在此失败。
  it('TransportTiming 生成代码与 omb.proto 权威源同步（X-5）', () => {
    const protoPath = fileURLToPath(new URL('../../../protocol/proto/omb.proto', import.meta.url))
    const protoSrc = readFileSync(protoPath, 'utf8')
    const body = protoSrc.slice(
      protoSrc.indexOf('enum TransportTiming'),
      // 枚举体到配对右花括号（本仓库枚举值单行风格，无嵌套花括号）。
      protoSrc.indexOf('}', protoSrc.indexOf('{', protoSrc.indexOf('enum TransportTiming'))),
    )
    const specs: Array<[keyof typeof TransportTiming, number]> = [
      ['FRAME_PING', 0x00], ['FRAME_PONG', 0x01], ['FRAME_UP', 0x02], ['FRAME_DOWN', 0x03],
      ['CONNECT_TIMEOUT_MS', 8000], ['PING_INTERVAL_MS', 2000], ['LIVENESS_TIMEOUT_MS', 8000],
      ['LIVENESS_CHECK_MS', 1000], ['SERVER_READ_TIMEOUT_MS', 10000], ['SERVER_WRITE_TIMEOUT_MS', 2000],
    ]
    for (const [name, val] of specs) {
      expect(body).toContain(`${name} = ${val};`)
    }
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
    expect(EvControlNotice_Code.CN_SCRIPT_ROLLBACK_FAILED).toBe(15)
  })
})

// ---- 脚本版本链（AI 直填 + 版本回退）：枚举编号、消息往返、ClientMsg 挂载 ----

describe('script versions (AI apply + rollback)', () => {
  it('ScriptOrigin / 新 notice 枚举值与 omb.proto 权威源互钉', () => {
    expect(ScriptOrigin.SCRIPT_ORIGIN_UNSPECIFIED).toBe(0)
    expect(ScriptOrigin.ORIGIN_MANUAL).toBe(1)
    expect(ScriptOrigin.ORIGIN_AI).toBe(2)
    expect(ScriptOrigin.ORIGIN_ROLLBACK).toBe(3)
  })

  it('EvScriptVersions 携带升序版本链与 current 指针，源码 owner-only 全量回传', () => {
    const versions = create(EvScriptVersionsSchema, {
      versions: [
        create(EvScriptVersionSchema, { id: 1, scriptRev: 3, origin: ScriptOrigin.ORIGIN_MANUAL, wallMs: 1000, source: 'function tick(bot) {}' }),
        create(EvScriptVersionSchema, { id: 2, scriptRev: 4, origin: ScriptOrigin.ORIGIN_AI, wallMs: 2000, source: 'function tick(bot) { bot.say("ai") }' }),
      ],
      currentId: 2,
    })
    const back = fromBinary(EvScriptVersionsSchema, toBinary(EvScriptVersionsSchema, versions))
    expect(back.currentId).toBe(2)
    expect(back.versions.map(v => [v.id, v.origin, v.scriptRev])).toEqual([[1, ScriptOrigin.ORIGIN_MANUAL, 3], [2, ScriptOrigin.ORIGIN_AI, 4]])
    expect(back.versions[1].source).toContain('bot.say')
  })

  it('ScriptRollback 上行挂在 ClientMsg.script_rollback = 13；EvScriptRollbackResult 往返', () => {
    const msg = create(ClientMsgSchema, {
      payload: { case: 'scriptRollback', value: create(ScriptRollbackSchema, { versionId: 7 }) },
    })
    const back = fromBinary(ClientMsgSchema, toBinary(ClientMsgSchema, msg))
    if (back.payload.case !== 'scriptRollback') throw new Error(`case ${back.payload.case}`)
    expect(back.payload.value.versionId).toBe(7)

    const result = create(EvScriptRollbackResultSchema, {
      ok: true, versionId: 7, scriptRev: 9, source: 'function tick(bot) {}',
    })
    const backResult = fromBinary(EvScriptRollbackResultSchema, toBinary(EvScriptRollbackResultSchema, result))
    expect(backResult).toMatchObject({ ok: true, versionId: 7, scriptRev: 9 })
    expect(backResult.source).toContain('tick')
  })

  it('EvScriptResult 可选 origin/versionId 向后兼容：旧字段缺省可探测', () => {
    const legacy = fromBinary(EvScriptResultSchema, toBinary(EvScriptResultSchema, create(EvScriptResultSchema, { clientScriptId: 5, ok: true, scriptRev: 3 })))
    expect(legacy.origin).toBeUndefined() // 旧服务器：客户端按手动提交处理
    expect(legacy.versionId).toBeUndefined()
    const fresh = fromBinary(EvScriptResultSchema, toBinary(EvScriptResultSchema, create(EvScriptResultSchema, { clientScriptId: 5, ok: true, scriptRev: 3, origin: ScriptOrigin.ORIGIN_AI, versionId: 2 })))
    expect(fresh.origin).toBe(ScriptOrigin.ORIGIN_AI)
    expect(fresh.versionId).toBe(2)
  })
})

// ---- 回放 JSONL schema（X-6）：权威枚举与 .proto 源互拍 ----
// Go 侧断言：server/internal/sim/log_schema_test.go TestReplaySchemaPinnedToProto。
// 改 protocol/proto/omb.proto 忘跑 pnpm --filter @omb/protocol gen 时，
// 下面「生成代码 ↔ .proto 文本」互拍失败；改值则「值互钉」双侧失败。

describe('replay schema golden (X-6)', () => {
  it('schema/record/visual 枚举值与权威源互钉', () => {
    expect(ReplaySchemaVersion.REPLAY_SCHEMA_V1).toBe(1)
    expect(ReplayRecordType.REPLAY_EVENT).toBe(1)
    expect(ReplayRecordType.REPLAY_MATCH_START).toBe(2)
    expect(ReplayRecordType.REPLAY_INPUT).toBe(3)
    expect(ReplayRecordType.REPLAY_CONTROL).toBe(4)
    expect(ReplayRecordType.REPLAY_CHECKPOINT).toBe(5)
    expect(ReplayRecordType.REPLAY_VISUAL).toBe(6)
    expect(ReplayVisualVersion.REPLAY_VISUAL_V1).toBe(1)
    expect(ReplayVisualVersion.REPLAY_VISUAL_V2).toBe(2)
    expect(REPLAY_SCHEMA_VERSION).toBe(1)
  })

  it('生成代码与 omb.proto 权威源同步（X-6）', () => {
    const protoPath = fileURLToPath(new URL('../../../protocol/proto/omb.proto', import.meta.url))
    const protoSrc = readFileSync(protoPath, 'utf8')
    const specs: Array<[string, number]> = [
      ['REPLAY_SCHEMA_V1', 1],
      ['REPLAY_EVENT', 1], ['REPLAY_MATCH_START', 2], ['REPLAY_INPUT', 3],
      ['REPLAY_CONTROL', 4], ['REPLAY_CHECKPOINT', 5], ['REPLAY_VISUAL', 6],
      ['REPLAY_VISUAL_V1', 1], ['REPLAY_VISUAL_V2', 2],
    ]
    for (const [name, val] of specs) {
      expect(protoSrc).toContain(`${name} = ${val};`)
    }
  })

  it('盘上名推导与 Go RecordTypeDiskName 同规则', () => {
    // Go 侧 log_schema_test.go 对同一映射断言；两侧规则分叉即失败。
    expect(replayRecordDiskName(ReplayRecordType.REPLAY_MATCH_START)).toBe('match_start')
    expect(replayRecordDiskName(ReplayRecordType.REPLAY_VISUAL)).toBe('visual')
    expect(replayRecordTypeFromDisk('checkpoint')).toBe(ReplayRecordType.REPLAY_CHECKPOINT)
    expect(replayRecordTypeFromDisk('nonsense')).toBeUndefined()
  })

  it('visual v2 载荷经生成 schema 校验（信封 type 键被忽略）', () => {
    const line = { type: 'visual', v: 2, tick: 6, phase: 2, robots: [{ id: 1, pos: { x: 1, y: 2 }, heading: 0, hp: 90, energy: 80, alive: true, invulnerable: false }], projectiles: [] }
    const frame = decodeVisualFrameV2(line)
    expect(frame.tick).toBe(6)
    expect(frame.robots[0]?.pos?.x).toBe(1)
    // 错版本拒绝
    expect(() => decodeVisualFrameV2({ ...line, v: 1 })).toThrow(/not v2/)
    // 坏载荷拒绝
    expect(() => decodeVisualFrameV2({ type: 'visual', v: 2, tick: 'x' })).toThrow()
  })
})
