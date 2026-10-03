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

// monaco 必须排除出依赖预打包：它是懒加载的（编辑器展开才 import './editor'），
// 而 vite 在会话中重跑 optimizer（如 lockfile 变更、运行中发现新依赖）会重写
// node_modules/.vite/deps 下的 chunk 文件与 ?v= 版本参数。同一页面先后拿到两代
// 预打包产物时，monaco 的 platform.js Registry 单例会被求值两次，第二次
// Registry.add('editor.modesRegistry') 触发 "There is already an extension with
// this id" 断言，编辑器加载失败。exclude 后 dev 直接按稳定 URL 原样供给 esm 文件
// （1511 个文件中编辑器路径约 744 个，首开略慢但无状态分叉）；生产构建不受影响。
export default defineConfig({
  optimizeDeps: {
    exclude: ['monaco-editor'],
  },
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
