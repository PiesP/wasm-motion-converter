// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { OwnedVp8CancelledError, OwnedVp8TrapError } from '@services/owned-vp8-core';
import { encodeWebpOwned } from '@services/webp-encoder-service';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  encode: vi.fn(),
  retire: vi.fn(),
  legacy: vi.fn(),
  targetReleased: false,
}));

vi.mock('@services/owned-vp8-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@services/owned-vp8-core')>()),
  createOwnedVp8Encoder: mocks.create,
}));
vi.mock('@services/wasm-webp-singleton', () => ({ encodeRGBReuse: mocks.legacy }));
vi.mock('@services/decoder-service', () => ({
  decodeFrames: vi.fn().mockImplementation(async (_demux, options) => {
    const target = await options.frameMemoryBudget.acquireTarget();
    try {
      await options.onFrameAvailable(
        new Uint8Array(8 * 8 * 3),
        50,
        0,
        options.frameMemoryBudget.createHandoff(target),
        { startUs: 0, endUs: 50_000 }
      );
    } finally {
      mocks.targetReleased = target.isReleased;
    }
    throw new Error('unreachable');
  }),
}));

const demux = {
  chunks: [],
  config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
  duration: 0.05,
  framerate: 20,
  sourceTotalMs: 50,
  totalFrames: 1,
};
const options = { width: 8, height: 8, quality: 'low' as const, scale: 1 };

beforeEach(() => {
  mocks.create.mockReset().mockResolvedValue({ encode: mocks.encode, retire: mocks.retire });
  mocks.encode.mockReset();
  mocks.retire.mockReset();
  mocks.legacy.mockReset();
  mocks.targetReleased = false;
});

describe('owned VP8 product failures', () => {
  it.each([OwnedVp8TrapError, OwnedVp8CancelledError])(
    'propagates %s after retiring without a legacy retry',
    async (ErrorType) => {
      mocks.encode.mockRejectedValue(new ErrorType('fault'));
      await expect(encodeWebpOwned(demux, options)).rejects.toBeInstanceOf(ErrorType);
      expect(mocks.create).toHaveBeenCalledTimes(1);
      expect(mocks.encode).toHaveBeenCalledTimes(1);
      expect(mocks.retire).toHaveBeenCalledTimes(1);
      expect(mocks.targetReleased).toBe(true);
      expect(mocks.legacy).not.toHaveBeenCalled();
    }
  );
});
