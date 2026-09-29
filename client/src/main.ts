// 骨架页：验证 workspace 装配与 WS Transport 连通性。
import { WsTransport } from '@omb/protocol'

const el = document.getElementById('status')!

async function main() {
  const t = new WsTransport()
  try {
    await t.connect(`ws://${location.host}:8080/ws`)
    el.textContent = `connected · rtt ${t.stats.rttMs.toFixed(0)}ms`
    el.className = 'ok'
  } catch {
    el.textContent = 'server unreachable (expected until `go run ./server/cmd/omb`)'
  }
}

main()
