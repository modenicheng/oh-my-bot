// @omb/protocol — 客户端⇄服务器消息契约。
// 本包导出：消息类型定义 + Transport 抽象（WS 已实现，WebRTC 备选待决策，见本轮 ADR）。
export * from './transport'
export * from './ws'
export * from './messages'
