import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

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
        rgbaData: new Uint8Array([0, 0, 0, 255]),
        width: 1,
        height: 1,
        quality: 0.8,
        durationMs: 100,
      },
      source: {},
    } as unknown as MessageEvent);

    expect(workerScope.postMessage).not.toHaveBeenCalled();
  });

  it('ignores non-object payloads without throwing or allocating a canvas', async () => {
    const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
    const OffscreenCanvasStub = vi.fn();
    vi.stubGlobal('self', workerScope);
    vi.stubGlobal('OffscreenCanvas', OffscreenCanvasStub);

    await import('@services/webp-encoder-worker');

    await expect(
      workerScope.onmessage?.({ data: null, source: null } as unknown as MessageEvent)
    ).resolves.toBeUndefined();
    expect(OffscreenCanvasStub).not.toHaveBeenCalled();
    expect(workerScope.postMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'a truncated RGBA plane',
      request: {
        id: 11,
        rgbaData: new Uint8Array([0, 0, 0]),
        width: 2,
        height: 2,
        quality: 0.8,
        durationMs: 40,
      },
    },
    {
      name: 'dimensions above the per-frame memory budget',
      request: {
        id: 12,
        rgbaData: new Uint8Array([0, 0, 0, 255]),
        width: 100_000,
        height: 100_000,
        quality: 0.8,
        durationMs: 40,
      },
    },
    {
      name: 'an RGBA plane larger than its pooled allocation bucket',
      request: {
        id: 14,
        rgbaData: new Uint8Array(5),
        width: 1,
        height: 1,
        quality: 0.8,
        durationMs: 40,
      },
    },
    {
      name: 'an exact RGBA view backed by an oversized allocation',
      request: {
        id: 15,
        rgbaData: new Uint8Array(new ArrayBuffer(8), 0, 4),
        width: 1,
        height: 1,
        quality: 0.8,
        durationMs: 40,
      },
    },
    {
      name: 'a non-finite quality value',
      request: {
        id: 13,
        rgbaData: new Uint8Array([0, 0, 0, 255]),
        width: 1,
        height: 1,
        quality: Number.NaN,
        durationMs: 40,
      },
    },
  ])('rejects $name before allocating a canvas', async ({ request }) => {
    const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
    const OffscreenCanvasStub = vi.fn();
    vi.stubGlobal('self', workerScope);
    vi.stubGlobal('OffscreenCanvas', OffscreenCanvasStub);

    await import('@services/webp-encoder-worker');
    await workerScope.onmessage?.({ data: request, source: null } as unknown as MessageEvent);

    expect(OffscreenCanvasStub).not.toHaveBeenCalled();
    expect(workerScope.postMessage).toHaveBeenCalledWith({
      id: request.id,
      error: 'Invalid WebP encode request',
    });
  });

  it.each([false, true])('transfers one VP8 backing (ICC: %s)', async (icc) => {
    const bitstream = new Uint8Array([0x06, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0]);
    const vp8Offset = icc ? 42 : 12;
    const webp = new Uint8Array(vp8Offset + 8 + bitstream.length);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    const view = new DataView(webp.buffer);
    view.setUint32(4, webp.length - 8, true);
    if (icc) {
      webp.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X, 1x1
      view.setUint32(16, 10, true);
      webp[20] = 0x20;
      webp.set([0x49, 0x43, 0x43, 0x50], 30); // ICCP
      view.setUint32(34, 3, true);
      webp.set([1, 2, 3], 38);
    }
    webp.set([0x56, 0x50, 0x38, 0x20], vp8Offset);
    view.setUint32(vp8Offset + 4, bitstream.length, true);
    webp.set(bitstream, vp8Offset + 8);

    const workerScope: WorkerScopeStub = { onmessage: null, postMessage: vi.fn() };
    const imageDataInputs: Array<{ data: Uint8ClampedArray; height: number; width: number }> = [];
    vi.stubGlobal('self', workerScope);
    vi.stubGlobal(
      'ImageData',
      class {
        constructor(data: Uint8ClampedArray, width: number, height: number) {
          imageDataInputs.push({ data, height, width });
        }
      }
    );
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
        rgbaData: new Uint8Array([0, 0, 0, 255]),
        width: 1,
        height: 1,
        quality: 0.75,
        durationMs: 40,
      },
      source: null,
    } as unknown as MessageEvent);

    const [message, transfer] = workerScope.postMessage.mock.calls[0]! as [
      { id: number; bitstream: Uint8Array; iccProfile: Uint8Array | null },
      ArrayBuffer[],
    ];
    expect(transfer).toHaveLength(1);
    expect(transfer[0]?.byteLength).toBe(icc ? webp.byteLength : bitstream.byteLength);
    const result = structuredClone(message, { transfer });
    expect(result.id).toBe(7);
    expect(result.bitstream).toEqual(new Uint8Array([0x16, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0]));
    expect(result.iccProfile).toEqual(icc ? new Uint8Array([1, 2, 3]) : null);
    if (icc) expect(result.iccProfile?.buffer).toBe(result.bitstream.buffer);
    expect(imageDataInputs).toHaveLength(1);
    expect(imageDataInputs[0]).toMatchObject({ height: 1, width: 1 });
    expect(imageDataInputs[0]?.data).toEqual(new Uint8ClampedArray([0, 0, 0, 255]));
    expect(imageDataInputs[0]?.data.buffer.byteLength).toBe(4);
  });
});
