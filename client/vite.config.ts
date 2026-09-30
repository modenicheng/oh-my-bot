import { defineConfig, type ProxyOptions } from 'vite'

// 开发配置：/api 与 /ws 代理到本地 omb 服务器（embed 前端在生产同源，无需代理）。
// omb 默认监听 127.0.0.1:27182（-addr / OMB_ADDR 可改，见 docs/adr/0014）。
// OMB_DEV_UPSTREAM 也支持 unix:/path/to/omb.sock 指向 unix socket 的 omb 实例
// （仅 Linux/macOS：Node/libuv 在 Windows 上连不了 AF_UNIX）。http-proxy 对带
// socketPath 的对象 target 走 IPC 连接，host/port 仅用于回填 Host/Origin 头——
// 两侧都不带端口（80 对 http 是默认端口，changeOrigin 不会拼上）才能与
// rewriteWsOrigin 生成的 Origin 配对通过服务端校验。
// /ws 必须重写 Origin：coder/websocket 默认校验 Origin 与 Host 一致，不重写会被 403。
const upstream = process.env.OMB_DEV_UPSTREAM || 'http://127.0.0.1:27182'

const proxyTarget: ProxyOptions['target'] = upstream.startsWith('unix:')
  ? { protocol: 'http:', host: '127.0.0.1', port: 80, socketPath: upstream.slice('unix:'.length) }
  : upstream

export default defineConfig({
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: proxyTarget,
        changeOrigin: true,
      },
      '/ws': {
        target: proxyTarget,
        ws: true,
        changeOrigin: true,
        rewriteWsOrigin: true,
      },
    },
  },
})
