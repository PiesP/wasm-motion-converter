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

  it('sets the Canvas VP8 display flag without changing coded dimensions', async () => {
    const bitstream = new Uint8Array([0x06, 0, 0, 0x9d, 0x01, 0x2a, 0xa0, 0]);
    const webp = new Uint8Array(20 + bitstream.length);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    webp.set([0x56, 0x50, 0x38, 0x20], 12);
    new DataView(webp.buffer).setUint32(16, bitstream.length, true);
    webp.set(bitstream, 20);

    const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal('self', workerScope);
    vi.stubGlobal('ImageData', class {});
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext(): { putImageData: ReturnType<typeof vi.fn> } {
          return { putImageData: vi.fn() };
        }

        async convertToBlob(): Promise<Blob> {
          return new Blob([webp], { type: 'image/webp' });
        }
      }
    );

    await import('@services/webp-encoder-worker');
    await workerScope.onmessage?.({
      data: {
        id: 7,
        rgbData: new Uint8Array([0, 0, 0]),
        width: 1,
        height: 1,
        quality: 0.75,
        durationMs: 40,
      },
      source: null,
    } as unknown as MessageEvent);

    const result = workerScope.postMessage.mock.calls[0]?.[0] as
      | { id: number; bitstream: Uint8Array }
      | undefined;
    expect(result?.id).toBe(7);
    expect(result?.bitstream).toEqual(
      new Uint8Array([0x16, 0, 0, 0x9d, 0x01, 0x2a, 0xa0, 0])
    );
  });
});
