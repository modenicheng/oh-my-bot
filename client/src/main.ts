// 骨架页：验证 workspace 装配与 WS Transport 连通性。样式令牌见 client/STYLE.md。
import { WsTransport } from '@omb/protocol'

const text = document.getElementById('status-text')!
const app = document.getElementById('app')!

async function main() {
  const t = new WsTransport()
  try {
    await t.connect(`ws://${location.host}:8080/ws`)
    text.textContent = `connected · rtt ${t.stats.rttMs.toFixed(0)}ms`
    app.classList.add('ok')
  } catch {
    text.textContent = 'server unreachable (expected until `go run ./server/cmd/omb` — port 8080)'
  }
}

main()
