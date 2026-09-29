// Transport 抽象：传输层决策（WS vs WebRTC）隔离在此接口之后。
// 权威服务器单向推送快照 + 客户端上行输入/指令，双工、有序、可靠。
// WebRTC DataChannel（unordered? no — 需要 unicast 有序）与 WebSocket 均可实现本接口。

export interface Transport {
  /** 建立连接；resolve 时即可收发。 */
  connect(url: string, opts?: TransportOpts): Promise<void>
  /** 发送上行消息（客户端→服务器）。 */
  send(msg: Uint8Array): void
  /** 订阅下行消息（服务器→客户端）。 */
  onMessage(cb: (msg: Uint8Array) => void): () => void
  /** 连接状态与统计（RTT、丢包）。 */
  readonly stats: TransportStats
  close(): void
}

export interface TransportOpts {
  /** 客户端侧接收缓冲，超出则视为传输劣化。 */
  recvBudgetBytes?: number
}

export interface TransportStats {
  /** 往返时延估计（ms），用于预测/和解参数。 */
  rttMs: number
  /** 最近窗口丢包率（WS 下恒为 0，DataChannel 可非 0）。 */
  lossRate: number
}

export type TransportFactory = (name: 'ws' | 'webrtc') => Transport
