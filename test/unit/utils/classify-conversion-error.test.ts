// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyConversionError } from '@utils/classify-conversion-error';

describe('classifyConversionError', () => {
  beforeEach(() => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('timeout errors', () => {
    it('classifies watchdog stall', () => {
      const result = classifyConversionError('Conversion stalled — no progress', null);
      expect(result.type).toBe('timeout');
      expect(result.phase).toBe('watchdog_timeout');
      expect(result.suggestion).toContain('stall');
    });

    it('classifies conversion timeout', () => {
      const result = classifyConversionError('Conversion timed out after 60s', null);
      expect(result.type).toBe('timeout');
      expect(result.phase).toBe('timeout');
      expect(result.suggestion).toContain('too long');
    });

    it('classifies "took too long" as timeout', () => {
      const result = classifyConversionError('The operation took too long to complete', null);
      expect(result.type).toBe('timeout');
    });
  });

  describe('memory errors', () => {
    it('classifies out of memory', () => {
      const result = classifyConversionError('Out of memory error', null);
      expect(result.type).toBe('memory');
      expect(result.suggestion).toContain('memory');
    });

    it('classifies OOM', () => {
      const result = classifyConversionError('OOM killed process', null);
      expect(result.type).toBe('memory');
    });

    it('classifies abort (non-user)', () => {
      const result = classifyConversionError('Operation aborted due to WASM memory limit', null);
      expect(result.type).toBe('memory');
    });

    it('does NOT classify user cancellation as memory error', () => {
      const result = classifyConversionError('Cancelled by user', null);
      expect(result.type).not.toBe('memory');
    });
  });

  describe('codec errors', () => {
    it('classifies AV1+GIF combination', () => {
      const meta = { width: 1920, height: 1080, duration: 5, codec: 'av1', framerate: 30, bitrate: 5000000 };
      const result = classifyConversionError('AV1 codec not supported for GIF', meta, undefined, ['[gif] encoding']);
      expect(result.type).toBe('codec');
      expect(result.phase).toBe('av1_gif_conversion_failure');
    });

    it('classifies AV1 decode failure', () => {
      const meta = { width: 1920, height: 1080, duration: 5, codec: 'av01', framerate: 30, bitrate: 5000000 };
      const result = classifyConversionError('AV01 codec decode failure', meta);
      expect(result.type).toBe('codec');
      expect(result.phase).toBe('av1_decode_failure');
    });

    it('classifies generic codec error', () => {
      const result = classifyConversionError('Decoder not found for this format', null);
      expect(result.type).toBe('codec');
      expect(result.phase).toBe('codec_error');
    });

    it('classifies WebCodecs failure', () => {
      const result = classifyConversionError('WebCodecs hardware acceleration not available', null);
      expect(result.type).toBe('codec');
      expect(result.phase).toBe('webcodecs_decode_failure');
    });
  });

  describe('format errors', () => {
    it('classifies WebP format error', () => {
      const result = classifyConversionError('libwebp encoding failed', null);
      expect(result.type).toBe('format');
      expect(result.suggestion).toContain('WebP');
    });

    it('classifies AVIF format error', () => {
      const result = classifyConversionError('AVIF encoding not supported', null);
      expect(result.type).toBe('format');
    });

    it('keeps a concrete AVIF encoder error from falling through to complexity memory heuristics', () => {
      const meta = {
        width: 1920,
        height: 1080,
        duration: 6.75,
        codec: 'h264',
        framerate: 60,
        bitrate: 8_000_000,
      };
      const result = classifyConversionError(
        'Frame processing failed: AVIF frame encoding failed: Encoding of color planes failed',
        meta
      );

      expect(result.type).toBe('format');
      expect(result.code).toBe('ENCODER_ERROR');
      expect(result.phase).toBe('encoder_error');
    });
  });

  describe('general errors', () => {
    it('classifies worker init failure', () => {
      const result = classifyConversionError('Failed to initialize worker thread', null);
      expect(result.type).toBe('general');
      expect(result.phase).toBe('worker_init_failure');
    });

    it('classifies cross-origin / SharedArrayBuffer error', () => {
      const result = classifyConversionError('SharedArrayBuffer not available — check COOP/COEP', null);
      expect(result.type).toBe('general');
      expect(result.phase).toBe('worker_error');
      expect(result.suggestion).toContain('COOP/COEP');
    });

    it('classifies Comlink worker error as worker_init_failure (first match wins)', () => {
      const result = classifyConversionError('Comlink worker failed to initialize', null);
      expect(result.type).toBe('general');
      // 'Comlink' matches worker-init-failure rule first (pattern: /failed\s*to\s*initiali[sz]e/)
      expect(result.phase).toBe('worker_init_failure');
    });
  });

  describe('video complexity fallback', () => {
    it('classifies overly complex video as memory error', () => {
      // Very high resolution * long duration * high fps = exceeds 500M pixel threshold
      const meta = { width: 3840, height: 2160, duration: 300, codec: 'h264', framerate: 60, bitrate: 50000000 };
      const result = classifyConversionError('Some generic error that does not match any rule', meta);
      expect(result.type).toBe('memory');
      expect(result.suggestion).toContain('too complex');
    });
  });

  describe('fallback', () => {
    it('returns general error for unmatched messages', () => {
      const result = classifyConversionError('Something unexpected happened xyz123', null);
      expect(result.type).toBe('general');
      expect(result.phase).toBe('unknown');
      expect(result.suggestion).toContain('unexpected');
    });
  });

  describe('context fields', () => {
    it('includes original error message', () => {
      const result = classifyConversionError('timeout error', null);
      expect(result.originalError).toBe('timeout error');
    });

    it('includes timestamp', () => {
      const result = classifyConversionError('timeout error', null);
      expect(result.timestamp).toBe(1000);
    });

    it('includes conversion settings when provided', () => {
      const settings = { format: 'gif' as const, quality: 'high' as const, scale: 1.0 as const, trimStart: 0, trimEnd: 0 };
      const result = classifyConversionError('timeout error', null, settings);
      expect(result.conversionSettings).toEqual(settings);
    });

    it('no longer includes ffmpeg logs (removed)', () => {
      const result = classifyConversionError('timeout error', null);
      // ffmpegLogs field was removed — verify it's not present
      expect('ffmpegLogs' in result).toBe(false);
    });
  });
});
