// 骨架页：验证 workspace 装配 + WS Transport + protobuf 帧解码。
// 样式令牌见 client/STYLE.md。
import { WsTransport } from '@omb/protocol'
import { decodeServer } from '@omb/protocol'

const text = document.getElementById('status-text')!
const app = document.getElementById('app')!
const detail = document.getElementById('detail')!

async function main() {
  const t = new WsTransport()
  t.onMessage((data) => {
    // 0x03 下行业务帧：echo 会话会把上行载荷原样回显
    const msg = decodeServer(data)
    if (msg) {
      const kind = msg.payload.case
      detail.textContent = `↓ ${kind} (${data.length}B)`
    }
  })
  try {
    await t.connect(`ws://${location.host}:8080/ws`)
    text.textContent = `connected · rtt ${t.stats.rttMs.toFixed(0)}ms`
    app.classList.add('ok')
  } catch {
    text.textContent = 'server unreachable (expected until `go run ./server/cmd/omb` — port 8080)'
  }
}

main()
