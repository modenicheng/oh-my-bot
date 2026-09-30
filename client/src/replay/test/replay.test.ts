// 回放模型/索引冒烟：解析 fixture NDJSON → 关键帧查询 → 事件标记 → 分数断言。
// fixture 由 server/scripts/gen-replay-fixture.mjs 生成（对齐 sim/log.go 磁盘格式）。
// client tsconfig 无 node 类型，但本文件运行于 vitest（Node）环境；独立 tsconfig
// 引入 @types/node。仅引入 node:url 与 node:fs（fixture 读取）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseReplayNDJSON, ReplayParseError } from '../model'
import { ReplayIndex } from '../index'

const fixturePath = fileURLToPath(
  new URL('../../../../server/data/matches/REPLAY1-000000001.jsonl', import.meta.url),
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

  it('非法 JSON 行报行号', () => {
    expect(() => parseReplayNDJSON('{"schema_version":1}\nnot json\n')).toThrow(/第 2 行/)
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

  it('uplink_hack 计分', () => {
    const f = idx.frameAt(330 * 60)
    expect(f.scores.get(4)?.uplink).toBe(1)
    expect(f.scores.get(4)?.total).toBeGreaterThanOrEqual(15)
  })

  it('阶段随 checkpoint 切换（240s CORE_OPEN）', () => {
    expect(idx.frameAt(0).phase).toBe(1)
    expect(idx.frameAt(241 * 60).phase).toBe(2)
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
