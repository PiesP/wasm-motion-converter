// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { runGifPartsViaWorker } from '@services/conversion-worker/main-thread-proxy';
import type { SerializedConversionOptions, WorkerRequest } from '@services/conversion-worker/types';
import type { GifOutputPart } from '@services/gif-encoder-service';
import { WORKER_PIPELINE_TIMEOUT_MS } from '@utils/constants';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

class PartsWorker {
  static latest: PartsWorker;
  onmessage?: (event: MessageEvent<unknown>) => void;
  readonly terminate = vi.fn();
  readonly postMessage = vi.fn<(message: WorkerRequest, transfer?: Transferable[]) => void>();
  constructor() {
    PartsWorker.latest = this;
  }
  send(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

const options: SerializedConversionOptions = {
  format: 'gif',
  quality: 'high',
  scale: 1,
  fps: 20,
  trimStart: 0,
  trimEnd: 0,
  maxFrames: 9000,
  maxOutputBytes: 1024,
};
const config = { codec: 'avc1.42e01e', codedWidth: 32, codedHeight: 24 };

function run(
  save: (part: GifOutputPart, signal: AbortSignal) => Promise<void>,
  signal?: AbortSignal
) {
  vi.stubGlobal('Worker', PartsWorker);
  vi.stubGlobal('crypto', { randomUUID: () => 'job' });
  return runGifPartsViaWorker(
    new File(['data'], 'private.mp4'),
    config,
    options,
    vi.fn(),
    save,
    signal
  );
}

function part(index = 1, startCs = 0, endCs = 5) {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode('GIF89a'));
  bytes[bytes.length - 1] = 0x3b;
  return {
    type: 'gif-part',
    requestId: 'job',
    part: { index, startCs, endCs, frameCount: 1, bytes: bytes.buffer },
  };
}
const complete = { type: 'gif-parts-complete', requestId: 'job', partCount: 1, frameCount: 1 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GIF parts Worker sink', () => {
  it('waits for the matching save before sending credit and returns only committed totals', async () => {
    const saving = Promise.withResolvers<void>();
    const save = vi.fn(() => saving.promise);
    const result = run(save);
    const worker = PartsWorker.latest;
    const start = worker.postMessage.mock.calls[0]![0];
    expect(start).toMatchObject({ type: 'start', outputMode: 'gif-parts' });
    expect(start.type === 'start' && start.inputBlob).toBeInstanceOf(Blob);
    expect(start.type === 'start' && start.inputBlob).not.toBeInstanceOf(File);
    worker.send({ ...part(), requestId: 'other' });
    worker.send(part());
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    saving.resolve();
    await vi.waitFor(() =>
      expect(worker.postMessage).toHaveBeenCalledWith({
        type: 'gif-part-saved',
        requestId: 'job',
        index: 1,
      })
    );
    worker.send(complete);
    await expect(result).resolves.toEqual({ partCount: 1, frameCount: 1 });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each(['abort', 'failure', 'timeout', 'duplicate', 'early-completion'] as const)(
    'invalidates the Worker on %s and waits for an open sink to settle',
    async (cause) => {
      vi.useFakeTimers();
      const saving = Promise.withResolvers<void>();
      const save = vi.fn((_part: GifOutputPart, _signal: AbortSignal) => saving.promise);
      const controller = new AbortController();
      let finished = false;
      const result = run(save, controller.signal).catch(() => {
        finished = true;
      });
      const worker = PartsWorker.latest;
      worker.send(part());
      await Promise.resolve();
      expect(save).toHaveBeenCalledOnce();
      if (cause === 'abort') controller.abort();
      else if (cause === 'timeout') await vi.advanceTimersByTimeAsync(WORKER_PIPELINE_TIMEOUT_MS);
      else if (cause === 'failure')
        worker.send({ type: 'error', requestId: 'job', code: 'FAILED', message: 'fixture error' });
      else if (cause === 'duplicate') worker.send(part());
      else worker.send(complete);
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(save.mock.calls[0]![1].aborted).toBe(true);
      await Promise.resolve();
      expect(finished).toBe(false);
      saving.resolve();
      await result;
      expect(finished).toBe(true);
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
    }
  );

  it('rejects a discontinuity before touching the destination', async () => {
    const save = vi.fn(async () => {});
    const result = run(save);
    PartsWorker.latest.send(part(1, 2, 7));
    await expect(result).rejects.toThrow(/discontinuous/);
    expect(save).not.toHaveBeenCalled();
  });
});
