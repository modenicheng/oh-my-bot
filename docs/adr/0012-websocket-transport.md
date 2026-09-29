# WebSocket 定案为唯一 v1 传输层

客户端⇄服务器实时通讯采用 WebSocket（二进制帧），实现 WebRTC DataChannel 备选的评估后放弃。核心理由：内网部署 + 60Hz 快照带宽 ≈15KB/s/客户端 + 快照天然冗余（丢一帧 16ms 后即有下一帧）的约束下，WebRTC 的全部优势（抗丢包、无队头阻塞、公网低延迟）无一兑现，而其全部成本（Pion、独立信令通道、ICE/DTLS 状态机、NAT 穿透运维）一项不免。Transport 抽象接口保留决策隔离：若未来跨公网联机，新增 DataChannel 实现即可，预测/和解代码不动。
