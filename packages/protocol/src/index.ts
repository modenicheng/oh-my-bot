// @omb/protocol — 客户端⇄服务器消息契约。
// schema 源：protocol/proto/omb.proto（buf + protoc-gen-es 生成 TS 到 gen/）。
// 本包导出：生成消息类型 + Transport 抽象（WS 实现，ADR-0012）。
export * from './gen/proto/omb_pb'
export * from './transport'
export * from './ws'
export * from './messages'
export * from './replay'
