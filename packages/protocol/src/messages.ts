// 消息层：与 .proto schema 对应的语义分组（编解码实现待 schema 工具链落地）。
// 设计要点（v0.3 §12）：
// - 下行：60Hz 快照（增量编码 + AOI 裁剪）；事件流（击毁/拾取/转段/热更…）
// - 上行：输入序列（含序号，用于预测和解）、脚本提交、房间指令
// 快照增量编码与 AOI 裁剪在传输层之上，两种 Transport 处理一致。

export type ClientMsg =
  | { t: 'input'; seq: number; move: { x: number; y: number }; fire: boolean; aim: number; dash: boolean; shield: boolean }
  | { t: 'script.submit'; source: string }
  | { t: 'room.join'; nick: string; color: string }
  | { t: 'room.action'; action: 'start' | 'abort' | 'restart' | 'warmup' }

export type ServerMsg =
  | { t: 'snapshot'; tick: number; entities: Uint8Array; ackSeq: number }
  | { t: 'event'; kind: string; payload: Uint8Array }
  | { t: 'room.state'; state: unknown }
  | { t: 'ai.quota'; rounds: number; tokens: number }

export const PROTOCOL_VERSION = 1
