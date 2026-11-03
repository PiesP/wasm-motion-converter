// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('@services/conversion-worker/pipeline-worker', () => ({
  runWorkerPipeline: vi.fn(),
}));

interface WorkerScopeStub {
  onmessage: ((event: MessageEvent) => Promise<void> | void) | null;
  postMessage: ReturnType<typeof vi.fn>;
}

describe('conversion worker message security', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('rejects a recognizable malformed start request immediately', async () => {
    const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal('self', workerScope);

    await import('@services/conversion-worker/worker');
    workerScope.postMessage.mockClear();

    await workerScope.onmessage?.({
      data: {
        type: 'start',
        requestId: 'request-1',
        inputBuffer: new ArrayBuffer(0),
        config: { codec: 'vp09', codedHeight: 16, codedWidth: 16 },
        options: {
          format: 'gif',
          fps: Number.POSITIVE_INFINITY,
          maxFrames: 1,
          maxOutputBytes: 1024,
          quality: 'medium',
          scale: 1,
          trimEnd: 0,
          trimStart: 0,
        },
      },
      source: null,
    } as unknown as MessageEvent);

    expect(workerScope.postMessage).toHaveBeenCalledWith({
      type: 'error',
      requestId: 'request-1',
      message: 'Invalid conversion worker request',
      code: 'INVALID_REQUEST',
    });
  });

  it('rejects unsupported conversion choices before starting the pipeline', async () => {
    const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal('self', workerScope);
    const { runWorkerPipeline } = await import('@services/conversion-worker/pipeline-worker');
    await import('@services/conversion-worker/worker');
    workerScope.postMessage.mockClear();

    for (const [field, value] of [
      ['format', 'avif'],
      ['quality', 'ultra'],
      ['smartFrameSkip', 'turbo'],
      ['smartFrameSkip', 123],
    ] as const) {
      vi.mocked(runWorkerPipeline).mockClear();
      workerScope.postMessage.mockClear();
      await workerScope.onmessage?.({
        data: {
          type: 'start',
          requestId: 'invalid-choice',
          inputBuffer: new ArrayBuffer(0),
          config: { codec: 'vp09', codedHeight: 16, codedWidth: 16 },
          options: {
            format: 'gif',
            quality: 'medium',
            fps: 30,
            scale: 1,
            trimStart: 0,
            trimEnd: 0,
            maxFrames: 1,
            maxOutputBytes: 1024,
            [field]: value,
          },
        },
        source: null,
      } as unknown as MessageEvent);
      expect(runWorkerPipeline).not.toHaveBeenCalled();
      expect(workerScope.postMessage).toHaveBeenCalledWith({
        type: 'error',
        requestId: 'invalid-choice',
        message: 'Invalid conversion worker request',
        code: 'INVALID_REQUEST',
      });
    }
  });

  it('continues to ignore payloads that cannot be correlated to a request', async () => {
    const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal('self', workerScope);

    await import('@services/conversion-worker/worker');
    workerScope.postMessage.mockClear();
    await workerScope.onmessage?.({ data: null, source: null } as unknown as MessageEvent);

    expect(workerScope.postMessage).not.toHaveBeenCalled();
  });

  it('forwards Blob input and cancels its exact conversion request', async () => {
    const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal('self', workerScope);
    const { runWorkerPipeline } = await import('@services/conversion-worker/pipeline-worker');
    let rejectPipeline!: (error: Error) => void;
    vi.mocked(runWorkerPipeline).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPipeline = reject;
        })
    );
    await import('@services/conversion-worker/worker');
    workerScope.postMessage.mockClear();
    const input = new Blob(['video']);
    const start = workerScope.onmessage?.({
      source: null,
      data: {
        type: 'start',
        requestId: 'blob-request',
        inputBlob: input,
        config: { codec: 'vp09', codedHeight: 16, codedWidth: 16 },
        options: {
          format: 'gif',
          fps: 30,
          maxFrames: 1,
          maxOutputBytes: 1024,
          quality: 'medium',
          scale: 1,
          trimEnd: 0,
          trimStart: 0,
        },
      },
    } as unknown as MessageEvent);

    const invocation = vi.mocked(runWorkerPipeline).mock.calls.at(-1)!;
    expect(invocation[0]).toBe(input);
    expect(invocation[4]?.aborted).toBe(false);
    await workerScope.onmessage?.({
      source: null,
      data: { type: 'abort', requestId: 'blob-request' },
    } as unknown as MessageEvent);
    expect(invocation[4]?.aborted).toBe(true);
    rejectPipeline(new DOMException('Cancelled', 'AbortError'));
    await start;
    expect(workerScope.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        requestId: 'blob-request',
        code: 'CANCELLED',
      }),
      []
    );
  });
});
