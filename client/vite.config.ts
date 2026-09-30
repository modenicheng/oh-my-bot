import { defineConfig } from 'vite'

// 开发配置：/api 与 /ws 代理到本地 omb 服务器（embed 前端在生产同源，无需代理）。
// omb 监听 IPv4；Node ≥17 的 DNS 解析顺序可能导致 ::1 优先，故显式 127.0.0.1。
// /ws 必须重写 Origin：coder/websocket 默认校验 Origin 与 Host 一致，
// 浏览器发来的 Origin 是 5173，不重写会被服务器 403。
const upstream = process.env.OMB_DEV_UPSTREAM || 'http://127.0.0.1:8080'

export default defineConfig({
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: upstream,
        changeOrigin: true,
      },
      '/ws': {
        target: upstream,
        ws: true,
        changeOrigin: true,
        rewriteWsOrigin: true,
      },
    },
  },
})
