/**
 * Main-thread side of the render worker: keeps the UI smooth while a re-render
 * runs (dragging a tempo or duty slider re-synthesizes the whole loop).
 */

import { renderSong, type SongRender } from './render';
import type { SongSpec } from './types';
import type { RenderRequest, RenderResponse } from './render-protocol';

const CACHE_LIMIT = 2;

export class SongRenderer {
  private worker: Worker | null = null;
  private token = 0;
  private pending = new Map<number, { resolve: (r: SongRender) => void; reject: (e: Error) => void }>();
  private cache = new Map<string, Promise<SongRender>>();

  constructor() {
    try {
      const worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<RenderResponse>) => this.settle(event.data);
      worker.onerror = () => {
        worker.terminate();
        this.worker = null;
        for (const job of this.pending.values()) job.reject(new Error('music render worker failed'));
        this.pending.clear();
      };
      this.worker = worker;
    } catch {
      this.worker = null; // fall back to rendering on the main thread
    }
  }

  get usingWorker(): boolean {
    return this.worker !== null;
  }

  render(song: SongSpec, sampleRate: number): Promise<SongRender> {
    const key = `${song.id}|${sampleRate}|${hash(JSON.stringify(song))}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const job = this.worker
      ? new Promise<SongRender>((resolve, reject) => {
          const token = ++this.token;
          this.pending.set(token, { resolve, reject });
          this.worker?.postMessage({ token, song, sampleRate } satisfies RenderRequest);
        })
      : Promise.resolve().then(() => renderSong(song, sampleRate));

    this.cache.set(key, job);
    job.catch(() => this.cache.delete(key));
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    return job;
  }

  private settle(response: RenderResponse): void {
    const job = this.pending.get(response.token);
    if (!job) return;
    this.pending.delete(response.token);
    if (response.render) job.resolve(response.render);
    else job.reject(new Error(response.error ?? 'render failed'));
  }
}

/** djb2, only used to key the render cache. */
function hash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
