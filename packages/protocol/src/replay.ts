// 回放 JSONL 记录 schema 助手（审计 X-6）。
// 权威源：protocol/proto/omb.proto 的 ReplaySchemaVersion / ReplayRecordType /
// ReplayVisualVersion（不经 WS 传输；服务器 sim/log.go 与客户端 replay/model.ts
// 均从本生成代码取值，两侧测试互钉）。
import {
  ReplaySchemaVersion,
  ReplayRecordType,
  ReplayVisualVersion,
  ReplayVisualFrameSchema,
  type ReplayVisualFrame,
} from './gen/proto/omb_pb'
import { fromJson } from '@bufbuild/protobuf'

/** 当前可解读（与写出）的回放 JSONL schema 版本。未知更高版本必须显式拒绝。 */
export const REPLAY_SCHEMA_VERSION: number = ReplaySchemaVersion.REPLAY_SCHEMA_V1

const DISK_NAME_RE = /^REPLAY_(.+)$/

/**
 * 记录类型的盘上 "type" 字符串（如 REPLAY_MATCH_START → "match_start"）。
 * 规则与服务器侧 sim.RecordTypeDiskName 同一实现语义，由 golden 测试互钉。
 */
export function replayRecordDiskName(type: ReplayRecordType): string {
  const name = ReplayRecordType[type]
  const match = DISK_NAME_RE.exec(name)
  const suffix = match?.[1]
  if (suffix === undefined) throw new Error(`unknown ReplayRecordType ${type}`)
  return suffix.toLowerCase()
}

/** 盘上 "type" 字符串 → ReplayRecordType；未知字符串返回 undefined。 */
export function replayRecordTypeFromDisk(name: string): ReplayRecordType | undefined {
  const value = ReplayRecordType[`REPLAY_${name.toUpperCase()}` as keyof typeof ReplayRecordType]
  return typeof value === 'number' && value !== ReplayRecordType.REPLAY_UNSPECIFIED ? value : undefined
}

/** v2 visual 采样行载荷的 json 字段形态（fromJson 的输入）。 */
export interface VisualFrameJson {
  v?: number
  tick?: number
  phase?: number
  robots?: Array<Record<string, unknown>>
  projectiles?: Array<Record<string, unknown>>
}

/** 解析 v2 visual 行：忽略信封键（type）后经生成 schema 校验 + 错误上抛。 */
export function decodeVisualFrameV2(obj: unknown): ReplayVisualFrame {
  const source = obj as Record<string, unknown>
  const body = source && typeof source === 'object'
    ? Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'type'))
    : source
  const frame = fromJson(ReplayVisualFrameSchema, body as never)
  if (frame.v !== ReplayVisualVersion.REPLAY_VISUAL_V2) {
    throw new Error(`visual frame version ${frame.v} is not v2`)
  }
  return frame
}
