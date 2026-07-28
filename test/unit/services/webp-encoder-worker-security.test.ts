import { afterEach, describe, expect, it, vi } from 'vitest';

interface WorkerScopeStub {
  onmessage: ((event: MessageEvent) => Promise<void> | void) | null;
  postMessage: ReturnType<typeof vi.fn>;
}

describe('WebP encoder worker message security', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('ignores messages from an unexpected event source', async () => {
    const workerScope: WorkerScopeStub = {
      onmessage: null,
      postMessage: vi.fn(),
    };
    vi.stubGlobal('self', workerScope);

    await import('@services/webp-encoder-worker');

    const handleMessage = workerScope.onmessage;
    expect(handleMessage).not.toBeNull();
    if (!handleMessage) return;

    await handleMessage({
      data: {
        id: 1,
        rgbData: new Uint8Array([0, 0, 0]),
        width: 1,
        height: 1,
        quality: 0.8,
        durationMs: 100,
      },
      source: {},
    } as unknown as MessageEvent);

    expect(workerScope.postMessage).not.toHaveBeenCalled();
  });
});
