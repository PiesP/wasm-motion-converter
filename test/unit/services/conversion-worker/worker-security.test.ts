// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it('continues to ignore payloads that cannot be correlated to a request', async () => {
    const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal('self', workerScope);

    await import('@services/conversion-worker/worker');
    workerScope.postMessage.mockClear();
    await workerScope.onmessage?.({ data: null, source: null } as unknown as MessageEvent);

    expect(workerScope.postMessage).not.toHaveBeenCalled();
  });
});
