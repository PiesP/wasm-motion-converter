// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const factory = vi.hoisted(() => vi.fn());
vi.mock('wasm-webp/dist/esm/webp-wasm.js', () => ({ default: factory }));

afterEach(() => {
  vi.resetModules();
  factory.mockReset();
});

describe('WASM WebP document lifetime', () => {
  it('retains one factory failure with its original cause for concurrent and later callers', async () => {
    const original = new Error('bounded initialization failure');
    let reject!: (error: Error) => void;
    factory.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        })
    );
    const { encodeRGBReuse, WasmWebpInitializationError } =
      await import('@services/wasm-webp-singleton');
    const calls = [
      encodeRGBReuse(new Uint8Array(3), 1, 1),
      encodeRGBReuse(new Uint8Array(3), 1, 1),
    ];
    const settled = Promise.allSettled(calls);
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    reject(original);
    const results = await settled;
    const result = results[0];
    if (!result || result.status !== 'rejected')
      throw new Error('Expected initialization rejection');
    const failure: unknown = result.reason;
    expect(failure).toBeInstanceOf(WasmWebpInitializationError);
    expect(failure).toMatchObject({ stage: 'factory', cause: original });
    if (!(failure instanceof Error)) throw new Error('Expected Error');
    expect(failure.message).toContain(original.message);
    expect(results[1]).toMatchObject({ status: 'rejected', reason: failure });
    factory.mockResolvedValue({ encodeRGB: vi.fn() });
    await expect(encodeRGBReuse(new Uint8Array(3), 1, 1)).rejects.toBe(failure);
    // Settled late callers cannot start a second factory or discard this document's failure.
    await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('shares successful initialization and preserves the borrowed view across encode failures', async () => {
    const view = new Uint8Array([1, 2, 3]);
    const original = new Error('ordinary frame failure');
    const encode = vi
      .fn()
      .mockReturnValueOnce(view)
      .mockImplementationOnce(() => {
        throw original;
      })
      .mockReturnValue(view);
    factory.mockResolvedValue({ encodeRGB: encode });
    const { encodeRGBReuse } = await import('@services/wasm-webp-singleton');
    const first = encodeRGBReuse(new Uint8Array(3), 1, 1, 110);
    const second = encodeRGBReuse(new Uint8Array(3), 1, 1);
    await expect(first).resolves.toBe(view);
    await expect(second).rejects.toBe(original);
    await expect(encodeRGBReuse(new Uint8Array(3), 1, 1, -10)).resolves.toBe(view);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(encode.mock.calls[0]?.[3]).toBe(100);
    expect(encode.mock.calls[2]?.[3]).toBe(0);
  });
});
