# 监听地址 loopback 优先与 unix socket 支持

未设置 `-addr` 或 `OMB_ADDR` 时，服务端默认绑定 `127.0.0.1:27182`，取代旧的 `0.0.0.0:8080`。显式 `-addr` 优先于环境变量 `OMB_ADDR`，接受 `host:port`、`:port`（全接口）、`unix:/path/to/omb.sock` 与 `unix:@name`（仅 Linux 抽象套接字）。本机调试无需对外监听；防火墙提示仍取决于系统策略，不能以绑定回环地址保证免弹窗。27182 较少被常见开发服务占用，仍可按需覆盖。部署遵循 ADR-0008 的私有定位，跨网段入口的访问控制和 TLS 由反向代理负责。

unix socket 面向 nginx/Caddy 等反向代理。绑定前用 `Lstat` 检查路径，只处理 socket，保留普通文件、目录与符号链接。探测成功说明有实例存活，报错退出；仅明确拒绝连接且探测后文件身份未变时，才清理崩溃遗留的 socket。超时或权限错误都不触发清理。监听后设权限 `0666` 供反代用户连接；要收紧时配置服务用户和共享组，配合目录权限。沿用 Go `UnixListener` 的首次 `Close` 清理，重复关闭旧 listener 不会删掉后来的新实例。SIGINT/SIGTERM 先关闭监听，再给正在处理的 HTTP 请求最多 10 秒；WebSocket 随进程退出。Linux 抽象套接字不落盘，非 Linux 平台明确拒绝此写法。

不引入独立 dev/prod 开关：本地默认回环地址，部署在 systemd/Docker 中显式配置 `-addr` 即可。Docker 容器内需用 `-addr :port` 才能经 `-p` 发布，详见 [部署指南](../deploy.md)。开发代理默认连接 `127.0.0.1:27182`，`OMB_DEV_UPSTREAM` 可覆盖；Linux/macOS 也可通过 `unix:/path/to/omb.sock` 连接 socket 后端。
