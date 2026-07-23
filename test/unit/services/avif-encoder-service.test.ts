// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { describe, expect, it, vi } from 'vitest';
import { createAvifAnimationEncoder, type AvifWasmModule } from '@services/avif-encoder-service';

describe('avif-encoder-service', () => {
  it('creates a stateful encoder and normalizes frame durations', async () => {
    const addFrame = vi.fn();
    const finish = vi.fn(() => new Uint8Array([0, 1, 2]));
    const deleteEncoder = vi.fn();
    const Encoder = vi.fn(function MockEncoder() {
      return { addFrame, finish, delete: deleteEncoder };
    });
    const module = { AvifAnimationEncoder: Encoder } as unknown as AvifWasmModule;

    const encoder = await createAvifAnimationEncoder(
      { width: 4, height: 4, quality: 'high' },
      async () => module
    );
    const frame = new Uint8Array(4 * 4 * 3);

    encoder.addFrame(frame, 16.7);
    expect(Encoder).toHaveBeenCalledWith(4, 4, 3, 75, 10, -1);
    expect(addFrame).toHaveBeenCalledWith(frame, 17);
    expect(encoder.finish()).toEqual(new Uint8Array([0, 1, 2]));
    expect(deleteEncoder).toHaveBeenCalledOnce();
  });

  it('releases the WASM encoder when finalization fails', async () => {
    const deleteEncoder = vi.fn();
    const Encoder = vi.fn(function MockEncoder() {
      return {
        addFrame: vi.fn(),
        finish: vi.fn(() => {
          throw new Error('finish failed');
        }),
        delete: deleteEncoder,
      };
    });

    const encoder = await createAvifAnimationEncoder(
      { width: 4, height: 4, quality: 'medium' },
      async () => ({ AvifAnimationEncoder: Encoder }) as unknown as AvifWasmModule
    );

    expect(() => encoder.finish()).toThrow('finish failed');
    expect(deleteEncoder).toHaveBeenCalledOnce();
  });
});
