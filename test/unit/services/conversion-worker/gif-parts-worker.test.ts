// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { GifOutputPart } from '@services/gif-encoder-service';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const pipeline = vi.hoisted(() => vi.fn());
vi.mock('@services/conversion-worker/pipeline-worker', () => ({ runWorkerPipeline: pipeline }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  pipeline.mockReset();
});

describe('GIF parts Worker credit', () => {
  it.each(['save', 'abort'] as const)(
    'keeps a transferred part exclusive until %s',
    async (action) => {
      const scope: {
        onmessage?: (event: MessageEvent<unknown>) => Promise<void>;
        postMessage: ReturnType<typeof vi.fn>;
      } = {
        postMessage: vi.fn((message: unknown, transfer: Transferable[] = []) =>
          structuredClone(message, { transfer })
        ),
      };
      vi.stubGlobal('self', scope);
      const emitted = Promise.withResolvers<void>();
      const bytes = new ArrayBuffer(20);
      pipeline.mockImplementation(
        async (
          _input: unknown,
          _options: unknown,
          _post: unknown,
          _id: unknown,
          _signal: unknown,
          _config: unknown,
          _duration: unknown,
          _fps: unknown,
          _index: unknown,
          sendPart: (part: GifOutputPart) => Promise<void>
        ) => {
          const saved = sendPart({ index: 1, startCs: 0, endCs: 5, frameCount: 1, bytes });
          emitted.resolve();
          await saved;
          return { partCount: 1, frameCount: 1 };
        }
      );
      await import('@services/conversion-worker/worker');
      scope.postMessage.mockClear();
      const send = (data: unknown) => scope.onmessage!(new MessageEvent('message', { data }));
      const running = send({
        type: 'start',
        requestId: 'job',
        outputMode: 'gif-parts',
        inputBlob: new Blob(['video']),
        config: { codec: 'avc1', codedWidth: 32, codedHeight: 24 },
        options: {
          format: 'gif',
          quality: 'high',
          fps: 20,
          scale: 1,
          trimStart: 0,
          trimEnd: 0,
          maxFrames: 9000,
          maxOutputBytes: 1024,
        },
      });
      await emitted.promise;
      expect(bytes.byteLength).toBe(0);
      expect(scope.postMessage).toHaveBeenCalledTimes(1);
      await send({ type: 'gif-part-saved', requestId: 'old-job', index: 1 });
      await send({ type: 'gif-part-saved', requestId: 'job', index: 2 });
      expect(scope.postMessage).toHaveBeenCalledTimes(1);
      await send(
        action === 'abort'
          ? { type: 'abort', requestId: 'job' }
          : { type: 'gif-part-saved', requestId: 'job', index: 1 }
      );
      await running;
      expect(scope.postMessage).toHaveBeenCalledTimes(2);
      const terminal =
        action === 'abort'
          ? { type: 'error', code: 'CANCELLED' }
          : { type: 'gif-parts-complete', partCount: 1, frameCount: 1 };
      expect(scope.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ requestId: 'job', ...terminal }),
        []
      );
    }
  );
});
