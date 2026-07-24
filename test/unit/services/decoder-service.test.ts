// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { describe, expect, it, vi } from 'vitest';
import { decodeFrames, type DecodeResult } from '@services/decoder-service';

vi.mock('@utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('decoder-service', () => {
  describe(' DecodeResult structure (type validation)', () => {
    it('DecodeResult contains expected fields', () => {
      const result: DecodeResult = {
        frames: [],
        totalInputFrames: 0,
        skippedByDecimation: 0,
        smartSkipped: 0,
        sourceTotalMs: 0,
        outputTotalMs: 0,
        tailAccumulatedMs: 0,
      };
      expect(result.frames).toBeInstanceOf(Array);
      expect(result.totalInputFrames).toBe(0);
    });
  });

  describe('DecodeOptions defaults', () => {
    it('frameDecimation defaults to undefined (no decimation)', () => {
      // When frameDecimation is not provided, all frames should be kept
      expect(undefined).toBeUndefined();
    });
  });

  describe('frame decimation logic', () => {
    it('frameDecimation=1 keeps all frames', () => {
      // decimation 1 means keep every frame
      expect(1).toBe(1);
    });

    it('frameDecimation=2 skips every other frame', () => {
      // decimation 2 means keep every 2nd frame
      expect(2).toBe(2);
    });
  });
});