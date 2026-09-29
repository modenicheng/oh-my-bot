import { defineConfig } from 'vite'

// 开发配置：/api 代理到本地 omb 服务器（embed 前端在生产同源，无需代理）。
// omb 监听 IPv4；Node ≥17 的 DNS 解析顺序可能导致 ::1 优先，故显式 127.0.0.1。
export default defineConfig({
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: process.env.OMB_DEV_UPSTREAM || 'http://127.0.0.1:8090',
        changeOrigin: true,
      },
    },
  },
})
