// 回放模型/索引冒烟：解析 fixture NDJSON → 关键帧查询 → 事件标记 → 分数断言。
// fixture 由 server/scripts/gen-replay-fixture.mjs 生成并纳入版本控制。
// client tsconfig 无 node 类型，但本文件运行于 vitest（Node）环境；独立 tsconfig
// 引入 @types/node。仅引入 node:url 与 node:fs（fixture 读取）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseReplayNDJSON, ReplayParseError } from '../model'
import { ReplayIndex } from '../index'
import { Title, ReplayRecordType, replayRecordDiskName, replayRecordTypeFromDisk } from '@omb/protocol'

const fixturePath = fileURLToPath(
  new URL('./fixtures/REPLAY1-000000001.jsonl', import.meta.url),
)
const fixture = readFileSync(fixturePath, 'utf8')

describe('parseReplayNDJSON', () => {
  it('解析头部/schema/事件/checkpoint', () => {
    const data = parseReplayNDJSON(fixture)
    expect(data.records.length).toBeGreaterThan(0)
    expect(data.endTick).toBe(28800)
    expect(data.robots.size).toBe(4)
    expect(data.robots.get(1)?.nick).toBe('ALICE')
    expect(data.initCheckpoint.mapJson).toBeTruthy()
  })

  it('权威视觉采样在样本间连续插值机器人位置', () => {
    const data = parseReplayNDJSON([
      JSON.stringify({ type: 'match_start', tick: 0, state: { tick: 0, phase: 1, robots: [{ id: 1, nick: 'MOVE', color: '#fff', hp: 100, energy: 100, state: 'alive', position: { X: 0, Y: 0 } }] } }),
      JSON.stringify({ type: 'visual', tick: 0, phase: 1, robots: [[1, 0, 0, 0, 100, 100, 1, 0]], projectiles: [] }),
      JSON.stringify({ type: 'visual', tick: 6, phase: 1, robots: [[1, 6, 3, Math.PI / 2, 90, 80, 1, 1]], projectiles: [] }),
    ].join('\n'))
    const replay = new ReplayIndex(data)
    expect(data.visualFrames).toHaveLength(2)
    const middle = replay.frameAt(3).robots[0]!
    expect(middle.pos.x).toBeCloseTo(3)
    expect(middle.pos.y).toBeCloseTo(1.5)
    expect(middle.heading).toBeCloseTo(Math.PI / 4)
    expect(middle.hp).toBeCloseTo(95)
    expect(middle.energy).toBeCloseTo(90)
    expect(replay.frameAt(6).robots[0]?.invulnerable).toBe(true)
  })

  it('仅有输入的短局保留时间轴长度', () => {
    const data = parseReplayNDJSON([
      JSON.stringify({ type: 'match_start', tick: 0, state: { tick: 0, robots: [] } }),
      JSON.stringify({ type: 'input', tick: 210, robot_id: 1, input: {} }),
    ].join('\n'))
    expect(data.endTick).toBe(210)
    expect(new ReplayIndex(data).frameAt(120).tick).toBe(120)
  })

  it('空 stub（无 checkpoint）抛 ReplayParseError', () => {
    expect(() => parseReplayNDJSON('{"schema_version":1}\n')).toThrow(ReplayParseError)
  })

  it('未知 schema_version 显式拒绝（X-6/D12）', () => {
    const v2 = '{"schema_version":2}\n' + JSON.stringify({ type: 'match_start', tick: 0, state: { tick: 0, robots: [] } })
    expect(() => parseReplayNDJSON(v2)).toThrow(ReplayParseError)
    expect(() => parseReplayNDJSON(v2)).toThrow(/schema_version=2/)
    expect(() => parseReplayNDJSON('{"schema_version":99}\n')).toThrow(/schema_version=99/)
  })

  it('已知 schema_version=1 正常解析；头行位置无关后续记录', () => {
    const ok = parseReplayNDJSON('{"schema_version":1}\n' + JSON.stringify({ type: 'match_start', tick: 0, state: { tick: 0, robots: [] } }))
    expect(ok.records).toHaveLength(1)
  })

  it('非法 JSON 行报行号', () => {
    expect(() => parseReplayNDJSON('{"schema_version":1}\nnot json\n')).toThrow(/第 2 行/)
  })
})

describe('回放 schema 权威源（X-6）', () => {
  it('记录类型盘上名与权威枚举互钉（与 Go sim.RecordTypeDiskName 同规则）', () => {
    expect(replayRecordDiskName(ReplayRecordType.REPLAY_EVENT)).toBe('event')
    expect(replayRecordDiskName(ReplayRecordType.REPLAY_MATCH_START)).toBe('match_start')
    expect(replayRecordDiskName(ReplayRecordType.REPLAY_INPUT)).toBe('input')
    expect(replayRecordDiskName(ReplayRecordType.REPLAY_CONTROL)).toBe('control')
    expect(replayRecordDiskName(ReplayRecordType.REPLAY_CHECKPOINT)).toBe('checkpoint')
    expect(replayRecordDiskName(ReplayRecordType.REPLAY_VISUAL)).toBe('visual')
    for (const disk of ['event', 'match_start', 'input', 'control', 'checkpoint', 'visual']) {
      expect(replayRecordTypeFromDisk(disk)).toBeDefined()
    }
    expect(replayRecordTypeFromDisk('future_record')).toBeUndefined()
  })

  it('visual v2（命名字段）与 v1（历史位置数组）等价解出', () => {
    const v2 = parseReplayNDJSON([
      JSON.stringify({ type: 'match_start', tick: 0, state: { tick: 0, robots: [] } }),
      JSON.stringify({ type: 'visual', v: 2, tick: 6, phase: 2, robots: [
        { id: 1, pos: { x: 6, y: 3 }, heading: 1.5, hp: 90, energy: 80, alive: true, invulnerable: true },
      ], projectiles: [
        { id: 9, owner: 1, pos: { x: 2, y: 2 }, heading: 0 },
      ] }),
    ].join('\n'))
    const v1 = parseReplayNDJSON([
      JSON.stringify({ type: 'match_start', tick: 0, state: { tick: 0, robots: [] } }),
      JSON.stringify({ type: 'visual', tick: 6, phase: 2, robots: [[1, 6, 3, 1.5, 90, 80, 1, 1]], projectiles: [[9, 1, 2, 2, 0]] }),
    ].join('\n'))
    expect(v2.visualFrames).toEqual(v1.visualFrames)
    expect(v2.visualFrames[0]?.robots[0]?.invulnerable).toBe(true)
  })

  it('缺 v 字段的 visual 行按 v1 历史形态解出', () => {
    const data = parseReplayNDJSON([
      JSON.stringify({ type: 'match_start', tick: 0, state: { tick: 0, robots: [] } }),
      JSON.stringify({ type: 'visual', tick: 0, phase: 1, robots: [[1, 0, 0, 0, 100, 100, 1, 0]], projectiles: [] }),
    ].join('\n'))
    expect(data.visualFrames[0]?.robots[0]?.hp).toBe(100)
  })

  it('未知 visual 版本显式拒绝（不静默错读位置数组语义）', () => {
    const lines = [
      JSON.stringify({ type: 'match_start', tick: 0, state: { tick: 0, robots: [] } }),
      JSON.stringify({ type: 'visual', v: 3, tick: 0, robots: [] }),
    ].join('\n')
    expect(() => parseReplayNDJSON(lines)).toThrow(ReplayParseError)
    expect(() => parseReplayNDJSON(lines)).toThrow(/v=3/)
  })

  it('visual v2 坏载荷报错常行号', () => {
    const lines = [
      JSON.stringify({ type: 'match_start', tick: 0, state: { tick: 0, robots: [] } }),
      '{"type":"visual","v":2,"tick":"x","robots":[]}',
    ].join('\n')
    expect(() => parseReplayNDJSON(lines)).toThrow(/第 2 行/)
  })

  it('事件严格解码：protojson 键名归一到 snake_case，省略 event.tick 回退信封 tick', () => {
    const data = parseReplayNDJSON([
      JSON.stringify({ type: 'match_start', tick: 0, state: { tick: 0, robots: [] } }),
      JSON.stringify({ type: 'event', tick: 60, event: { kill: { killer: 1, victim: 2, assists: [3, 4] } } }),
      JSON.stringify({ type: 'event', tick: 120, event: { tick: 120, match_end: { scores: [{ robot: 1, score: 5, titles: ['HEALER'] }] } } }),
    ].join('\n'))
    const kill = data.records.find(r => r.event?.kind === 'kill')
    expect(kill?.tick).toBe(60)
    expect(kill?.event?.payload.assists).toEqual([3, 4])
    const end = data.records.find(r => r.event?.kind === 'match_end')
    expect(end?.tick).toBe(120)
    expect(end?.event?.payload.scores[0].titles).toEqual(['HEALER'])
  })
})

describe('ReplayIndex', () => {
  const data = parseReplayNDJSON(fixture)
  const idx = new ReplayIndex(data)

  it('事件标记：kill/core/uplink/phase/respawn', () => {
    const kinds = idx.marks.map((m) => m.kind)
    expect(kinds).toContain('kill')
    expect(kinds).toContain('core')
    expect(kinds).toContain('uplink')
    expect(kinds).toContain('phase')
    expect(kinds).toContain('start')
    expect(kinds).toContain('end')
  })

  it('kill → victim 死亡；respawn → 复活', () => {
    const mid = idx.frameAt(400 * 60) // kill(3→4) @400s 后
    expect(mid.robots.find((r) => r.id === 4)?.alive).toBe(false)
    const after = idx.frameAt(403 * 60) // respawn(4) @403s
    expect(after.robots.find((r) => r.id === 4)?.alive).toBe(true)
  })

  it('core_pickup 计分（value 来自事件负载）', () => {
    const f = idx.frameAt(300 * 60)
    const alice = f.scores.get(1)
    expect(alice?.core).toBe(1) // 120s BOB +10, 300s ALICE +25
    expect(alice?.total).toBeGreaterThanOrEqual(25)
  })

  it('kill 25 分 + assist 10 分', () => {
    const f = idx.frameAt(30 * 60)
    expect(f.scores.get(1)?.kill).toBe(1)
    expect(f.scores.get(1)?.total).toBe(25)
    expect(f.scores.get(3)?.assist).toBe(1)
  })

  it('新录像支持多人助攻，旧单 assist 仍兼容', () => {
    const data = parseReplayNDJSON([
      { type: 'match_start', tick: 0, state: { tick: 0, robots: [] } },
      { type: 'event', tick: 60, event: { kill: { killer: 1, victim: 4, assists: [2, 3] } } },
      { type: 'event', tick: 120, event: { kill: { killer: 4, victim: 1, assist: 2 } } },
    ].map(record => JSON.stringify(record)).join(String.fromCharCode(10)))
    const frame = new ReplayIndex(data).frameAt(120)
    expect(frame.scores.get(1)?.total).toBe(25)
    expect(frame.scores.get(4)?.total).toBe(25)
    expect(frame.scores.get(2)?.assist).toBe(2)
    expect(frame.scores.get(3)?.assist).toBe(1)
  })

  it('回血事件可 seek 重建 HP 与血包 30 秒冷却', () => {
    const data = parseReplayNDJSON([
      { type: 'match_start', tick: 0, state: {
        tick: 0, phase: 1,
        robots: [{ id: 1, hp: 50, energy: 100, state: 'alive', position: { X: 0, Y: 0 } }],
        health_packs: [{ id: 7, pos: { X: 4, Y: 5 }, ready_at: 0 }],
      } },
      { type: 'event', tick: 60, event: { heal: { by: 1, id: 7, heal_x10: 300, at: { x: 4, y: 5 } } } },
    ].map(record => JSON.stringify(record)).join(String.fromCharCode(10)))
    const replay = new ReplayIndex(data)
    expect(replay.frameAt(59).robots.find(r => r.id === 1)?.hp).toBe(50)
    expect(replay.frameAt(59).healthPacks[0]?.readyAt).toBe(0)
    expect(replay.frameAt(60).robots.find(r => r.id === 1)?.hp).toBe(80)
    expect(replay.frameAt(60).healthPacks[0]?.readyAt).toBe(60 + 30 * 60)
    expect(replay.frameAt(59).healthPacks[0]?.readyAt).toBe(0)
  })

  it('事件后只有输入的尾段仍有每秒关键帧', () => {
    const data = parseReplayNDJSON([
      { type: 'match_start', tick: 0, state: {
        tick: 0, robots: [{ id: 1, hp: 50, state: 'alive' }],
        health_packs: [{ id: 7, pos: { X: 4, Y: 5 }, ready_at: 0 }],
      } },
      { type: 'event', tick: 58, event: { heal: { by: 1, id: 7, heal_x10: 300 } } },
      { type: 'input', tick: 185 },
    ].map(record => JSON.stringify(record)).join('\n'))
    const replay = new ReplayIndex(data)
    expect(replay.frameAt(57).robots[0]?.hp).toBe(50)
    for (const tick of [60, 120, 180, 185]) {
      expect(replay.frameAt(tick).robots[0]?.hp).toBe(80)
      expect(replay.frameAt(tick).healthPacks[0]?.readyAt).toBe(1858)
    }
  })

  it('uplink_hack 计分', () => {
    const f = idx.frameAt(330 * 60)
    expect(f.scores.get(4)?.uplink).toBe(1)
    expect(f.scores.get(4)?.total).toBeGreaterThanOrEqual(15)
  })

  it('阶段随 checkpoint 切换（240s CORE_OPEN）', () => {
    expect(idx.frameAt(0).phase).toBe(1)
    expect(idx.frameAt(241 * 60).phase).toBe(2)
  })

  it('结算使用服务器最终分与称号，跳回过去不会泄漏未来结果', () => {
    const data = parseReplayNDJSON([
      { type: 'match_start', tick: 0, state: { tick: 0, phase: 1, robots: [] } },
      { type: 'event', tick: 120, event: { kill: { killer: 1, victim: 2, assist: 0 } } },
      { type: 'event', tick: 125, event: { match_end: { scores: [
        { robot: 1, score: 77, titles: ['KILL_STEAL', 'HEALER'] },
        { robot: 2, score: 0, titles: [Title.SURVIVOR] },
      ] } } },
    ].map(record => JSON.stringify(record)).join(String.fromCharCode(10)))
    const replay = new ReplayIndex(data)
    expect(replay.frameAt(119).scores.get(1)?.total ?? 0).toBe(0)
    expect(replay.frameAt(124).scores.get(1)?.total).toBe(25)
    expect(replay.frameAt(124).finalScores).toBeNull()
    const final = replay.frameAt(125)
    expect(final.scores.get(1)?.total).toBe(77)
    expect(final.finalScores?.[0]?.titles).toEqual([Title.KILL_STEAL, Title.HEALER])
    expect(final.finalScores?.[1]?.titles).toEqual([Title.SURVIVOR])
    final.scores.get(1)!.total = 999
    expect(replay.frameAt(125).scores.get(1)?.total).toBe(77)
    expect(replay.frameAt(60).finalScores).toBeNull()
    expect(replay.frameAt(60).scores.get(1)?.total ?? 0).toBe(0)
  })

  it('旧录像可读取 BEST_PARTNER 枚举但展示层隐藏', () => {
    const data = parseReplayNDJSON([
      { type: 'match_start', tick: 0, state: { tick: 0, robots: [] } },
      { type: 'event', tick: 10, event: { match_end: { scores: [{ robot: 1, score: 9, titles: ['BEST_PARTNER'] }] } } },
    ].map(record => JSON.stringify(record)).join(String.fromCharCode(10)))
    const final = new ReplayIndex(data).frameAt(10)
    expect(final.finalScores?.[0]?.titles).toEqual([Title.BEST_PARTNER])
  })

  it('旧录像没有结算分时仍保留事件累计积分', () => {
    const data = parseReplayNDJSON([
      { type: 'match_start', tick: 0, state: { tick: 0, robots: [] } },
      { type: 'event', tick: 60, event: { hit: { from: 1, to: 2 } } },
      { type: 'event', tick: 120, event: { match_end: {} } },
    ].map(record => JSON.stringify(record)).join(String.fromCharCode(10)))
    const final = new ReplayIndex(data).frameAt(120)
    expect(final.finalScores).toBeNull()
    expect(final.scores.get(1)?.total).toBe(1)
  })

  it('末尾 tick 可查且钳制', () => {
    expect(idx.frameAt(999999).tick).toBe(28800)
    expect(idx.frameAt(-5).tick).toBe(0)
  })

  it('核心被拾取后从渲染消失', () => {
    const before = idx.frameAt(119 * 60).cores
    expect(before.find((c) => c.id === 2)?.taken).toBe(false)
    const after = idx.frameAt(121 * 60).cores
    expect(after.find((c) => c.id === 2)?.taken).toBe(true)
  })
})
