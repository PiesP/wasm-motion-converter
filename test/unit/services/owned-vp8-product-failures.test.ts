// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { globalBufferPool } from '@services/buffer-pool';
import { OutputLimitError } from '@services/output-limits';
import {
  OwnedVp8CancelledError,
  OwnedVp8OutputLimitError,
  OwnedVp8TrapError,
} from '@services/owned-vp8-core';
import { encodeWebpOwned } from '@services/webp-encoder-service';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  encode: vi.fn(),
  retire: vi.fn(),
  targetReleased: false,
}));

vi.mock('@services/owned-vp8-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@services/owned-vp8-core')>()),
  createOwnedVp8Encoder: mocks.create,
}));
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
  mocks.targetReleased = false;
});

describe('owned VP8 product failures', () => {
  it('removes the pool guard when initialization fails before an encoder exists', async () => {
    mocks.create.mockRejectedValueOnce(new OwnedVp8CancelledError('cancelled during load'));
    await expect(encodeWebpOwned(demux, options)).rejects.toBeInstanceOf(OwnedVp8CancelledError);
    expect(mocks.retire).not.toHaveBeenCalled();
    const removeGuard = globalBufferPool.installGrowthGuard(() => undefined);
    removeGuard();
  });

  it.each(['direct', 'frame processing'] as const)(
    'preserves the %s output ceiling separately from memory admission',
    async (origin) => {
      const limit = new OutputLimitError('webp', 'byte', 1024);
      const failure =
        origin === 'direct'
          ? limit
          : new Error(`Frame processing failed: ${limit.message}`, { cause: limit });
      mocks.encode.mockRejectedValueOnce(failure);

      await expect(encodeWebpOwned(demux, options)).rejects.toMatchObject({
        name: new OwnedVp8OutputLimitError().name,
        message: failure.message,
        cause: failure,
      });
      expect(mocks.targetReleased).toBe(true);
      expect(mocks.retire).toHaveBeenCalledOnce();
    }
  );

  it.each([OwnedVp8TrapError, OwnedVp8CancelledError])(
    'propagates %s after retiring without an automatic retry',
    async (ErrorType) => {
      mocks.encode.mockRejectedValue(new ErrorType('fault'));
      await expect(encodeWebpOwned(demux, options)).rejects.toBeInstanceOf(ErrorType);
      expect(mocks.create).toHaveBeenCalledTimes(1);
      expect(mocks.encode).toHaveBeenCalledTimes(1);
      expect(mocks.retire).toHaveBeenCalledTimes(1);
      expect(mocks.targetReleased).toBe(true);
      const removeGuard = globalBufferPool.installGrowthGuard(() => undefined);
      removeGuard();
    }
  );
});
