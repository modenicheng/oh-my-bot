/** Page-local application WS payload counters; no sockets or message bodies are retained. */
export interface WebSocketMetrics {
  receivedBytes: number
  sentBytes: number
  receivedMessages: number
  sentMessages: number
  connections: number
  rttMs: number | null
}

export interface ConnectionMetrics {
  rttMs: number | null
}

const active = new Set<ConnectionMetrics>()
let receivedBytes = 0
let sentBytes = 0
let receivedMessages = 0
let sentMessages = 0

export const webSocketMetrics = {
  open(connection: ConnectionMetrics): void { active.add(connection) },
  close(connection: ConnectionMetrics): void { active.delete(connection) },
  receive(bytes: number): void { receivedBytes += bytes; receivedMessages++ },
  send(bytes: number): void { sentBytes += bytes; sentMessages++ },
}

/** Cumulative counters survive reconnects; RTT is the highest measured RTT of the open sockets. */
export function readWebSocketMetrics(target?: WebSocketMetrics): WebSocketMetrics {
  let rttMs: number | null = null
  for (const connection of active) {
    if (connection.rttMs !== null) rttMs = Math.max(rttMs ?? 0, connection.rttMs)
  }
  const result = target ?? {} as WebSocketMetrics
  result.receivedBytes = receivedBytes
  result.sentBytes = sentBytes
  result.receivedMessages = receivedMessages
  result.sentMessages = sentMessages
  result.connections = active.size
  result.rttMs = rttMs
  return result
}
