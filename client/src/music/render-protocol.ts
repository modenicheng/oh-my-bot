// 回放渲染 Worker 的消息协议：主线程 renderer.ts 与 render.worker.ts 共用。
// 两端必须逐字段一致（token 配对、render/error 互斥），协议挪出各自文件后
// 单点维护，避免主线程与 worker 各自演化。

import type { SongRender } from './render';
import type { SongSpec } from './types';

/** 主线程 → worker：渲染请求，token 用于响应配对。 */
export interface RenderRequest {
  token: number;
  song: SongSpec;
  sampleRate: number;
}

/** worker → 主线程：成功带 render（stem buffer 所有权已转移），失败带 error。 */
export interface RenderResponse {
  token: number;
  render?: SongRender;
  error?: string;
}
