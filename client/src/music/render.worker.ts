/**
 * Render worker: turns a tune into per-(voice, stage) stems off the main thread.
 * Runs the same `renderSong` the Node scripts use, so the browser and the CLI
 * agree to the sample.
 */

import { renderSong } from './render.ts';
import type { SongSpec } from './types.ts';

interface RenderRequest {
  token: number;
  song: SongSpec;
  sampleRate: number;
}

interface RenderResponse {
  token: number;
  render?: ReturnType<typeof renderSong>;
  error?: string;
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<RenderRequest>) => void) | null;
  postMessage: (message: RenderResponse, transfer?: Transferable[]) => void;
};

scope.onmessage = (event: MessageEvent<RenderRequest>) => {
  const { token, song, sampleRate } = event.data;
  try {
    const render = renderSong(song, sampleRate);
    // A stem shared by several stages must be listed once, or the buffer is
    // transferred twice and postMessage throws.
    const transfer: Transferable[] = [];
    const seen = new Set<ArrayBufferLike>();
    for (const voice of render.voices) {
      for (const part of voice.stages) {
        if (!part || seen.has(part.stem.buffer)) continue;
        seen.add(part.stem.buffer);
        transfer.push(part.stem.buffer);
      }
    }
    scope.postMessage({ token, render }, transfer);
  } catch (error) {
    scope.postMessage({ token, error: error instanceof Error ? error.message : String(error) });
  }
};
