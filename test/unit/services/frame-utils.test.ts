import { convertRGBAToRGB, copyFrameToRGB } from '@services/frame-utils';
import {
  clearCanvasCache,
  compute8x8Grayscale,
  computeMAD,
  convertRGBToRGBA,
  createFrameProcessingContext,
  getFrameDurationMs,
  getSkipThreshold,
  resolveVideoDimensions,
  yieldToMain,
} from '@services/frame-utils';
import { BufferPool } from '@services/buffer-pool';
import { describe, expect, it, vi } from 'vitest';

describe('copyFrameToRGB', () => {
  it('uses the RGBX path and caches the detected copy strategy', async () => {
    const allocationSize = vi.fn(() => 8);
    const copyTo = vi.fn(async (buffer: Uint8Array) => {
      buffer.set([10, 20, 30, 255, 40, 50, 60, 255]);
    });
    const frame = {
      codedWidth: 2,
      codedHeight: 1,
      displayWidth: 2,
      displayHeight: 1,
      allocationSize,
      copyTo,
    } as unknown as VideoFrame;
    const context = createFrameProcessingContext();

    const first = await copyFrameToRGB(frame, 2, 1, context);
    const second = await copyFrameToRGB(frame, 2, 1, context);

    expect(Array.from(first.slice(0, 6))).toEqual([10, 20, 30, 40, 50, 60]);
    expect(Array.from(second.slice(0, 6))).toEqual([10, 20, 30, 40, 50, 60]);
    expect(context.copyPath).toBe('four-channel');
    expect(copyTo).toHaveBeenCalledTimes(2);
    expect(allocationSize).toHaveBeenCalledTimes(2);
  });

  it('falls back to RGBA when RGBX is unsupported', async () => {
    const allocationSize = vi.fn((options?: { format?: string }) => {
      if (options?.format === 'RGBX') throw new Error('RGBX unsupported');
      return 4;
    });
    const copyTo = vi.fn(async (buffer: Uint8Array, options?: { format?: string }) => {
      expect(options?.format).toBe('RGBA');
      buffer.set([70, 80, 90, 255]);
    });
    const frame = {
      codedWidth: 1,
      codedHeight: 1,
      displayWidth: 1,
      displayHeight: 1,
      allocationSize,
      copyTo,
    } as unknown as VideoFrame;

    const result = await copyFrameToRGB(frame, 1, 1, createFrameProcessingContext());

    expect(Array.from(result.slice(0, 3))).toEqual([70, 80, 90]);
    expect(copyTo).toHaveBeenCalledTimes(1);
  });
});

describe('convertRGBAToRGB', () => {
  it('converts an unaligned Uint8Array view without reading outside the view', () => {
    const backing = new Uint8Array([255, 10, 20, 30, 40, 50, 60]);
    const source = backing.subarray(1, 5);
    const pool = new BufferPool(1, 1024);

    const result = convertRGBAToRGB(source, 1, 1, 'RGBA', pool);

    expect(Array.from(result.slice(0, 3))).toEqual([10, 20, 30]);
  });

  it('rejects a source view that does not contain a complete pixel payload', () => {
    const pool = new BufferPool(1, 1024);

    expect(() => convertRGBAToRGB(new Uint8Array([10, 20, 30]), 1, 1, 'RGBA', pool)).toThrow(
      RangeError
    );
  });

  it('converts RGBA to RGB for a 2x2 image', () => {
    // RGBA data: pixel0=(255,0,0,255), pixel1=(0,255,0,255), pixel2=(0,0,255,255), pixel3=(128,128,128,255)
    const rgba = new Uint8Array([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      128, 128, 128, 255,
    ]);
    const pool = new BufferPool(1, 1024);
    const result = convertRGBAToRGB(rgba, 2, 2, 'RGBA', pool);
    expect(result.length).toBeGreaterThanOrEqual(2 * 2 * 3);
    expect(Array.from(result.slice(0, 12))).toEqual([
      255, 0, 0,
      0, 255, 0,
      0, 0, 255,
      128, 128, 128,
    ]);
  });

  it('converts BGRA to RGB correctly (swaps R and B)', () => {
    const bgra = new Uint8Array([
      0, 0, 255, 255,  // pixel0: B=0, G=0, R=255, A=255
    ]);
    const pool = new BufferPool(1, 1024);
    const result = convertRGBAToRGB(bgra, 1, 1, 'BGRA', pool);
    expect(Array.from(result.slice(0, 3))).toEqual([255, 0, 0]);
  });

  it('handles RGBX format (alpha byte ignored)', () => {
    const rgbx = new Uint8Array([
      10, 20, 30, 99,  // pixel0: R=10, G=20, B=30, X=99
    ]);
    const pool = new BufferPool(1, 1024);
    const result = convertRGBAToRGB(rgbx, 1, 1, 'RGBX', pool);
    expect(Array.from(result.slice(0, 3))).toEqual([10, 20, 30]);
  });

  it('falls back to byte-wise copy for unaligned byteOffset', () => {
    const backing = new Uint8Array([0, 255, 0, 0, 255, 0, 0, 255, 0]);
    // subarray at offset 1 makes byteOffset=1 (unaligned for Uint32Array)
    const source = backing.subarray(1, 9);
    // RGBX data at offset: pixel=(255,0,0,255), pixel2=(0,255,0)
    const pool = new BufferPool(1, 1024);
    const result = convertRGBAToRGB(source, 1, 1, 'RGBA', pool);
    expect(Array.from(result.slice(0, 3))).toEqual([255, 0, 0]);
  });

  it('uses default globalBufferPool when no pool provided', () => {
    const rgba = new Uint8Array([10, 20, 30, 255]);
    const result = convertRGBAToRGB(rgba, 1, 1, 'RGBA');
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(Array.from(result.slice(0, 3))).toEqual([10, 20, 30]);
  });
});

describe('convertRGBToRGBA', () => {
  it('converts RGB to RGBA with alpha=255', () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    const pool = new BufferPool(1, 1024);
    const result = convertRGBToRGBA(rgb, 3, 1, pool);
    expect(result.length).toBeGreaterThanOrEqual(3 * 1 * 4);
    // RGBA: pixel0=(255,0,0,255), pixel1=(0,255,0,255), pixel2=(0,0,255,255)
    expect(result[0]).toBe(255);
    expect(result[1]).toBe(0);
    expect(result[2]).toBe(0);
    expect(result[3]).toBe(255);
    expect(result[4]).toBe(0);
    expect(result[5]).toBe(255);
    expect(result[6]).toBe(0);
    expect(result[7]).toBe(255);
    expect(result[8]).toBe(0);
    expect(result[9]).toBe(0);
    expect(result[10]).toBe(255);
    expect(result[11]).toBe(255);
  });

  it('handles single pixel', () => {
    const rgb = new Uint8Array([128, 64, 32]);
    const pool = new BufferPool(1, 1024);
    const result = convertRGBToRGBA(rgb, 1, 1, pool);
    expect(result.length).toBe(4);
    expect(Array.from(result)).toEqual([128, 64, 32, 255]);
  });

  it('handles zero-size image without error', () => {
    const rgb = new Uint8Array(0);
    const pool = new BufferPool(1, 1024);
    const result = convertRGBToRGBA(rgb, 0, 0, pool);
    expect(result.length).toBe(0);
  });
});

describe('resolveVideoDimensions', () => {
  it('returns coded dimensions when available', () => {
    expect(resolveVideoDimensions({ codedWidth: 1920, codedHeight: 1080 })).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('falls back to displayAspect dimensions', () => {
    expect(
      resolveVideoDimensions({ displayAspectWidth: 1280, displayAspectHeight: 720 })
    ).toEqual({ width: 1280, height: 720 });
  });

  it('falls back to raw display dimensions', () => {
    expect(resolveVideoDimensions({ displayWidth: 640, displayHeight: 480 })).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('prefers coded over displayAspect over display', () => {
    expect(
      resolveVideoDimensions({
        codedWidth: 1920,
        codedHeight: 1080,
        displayAspectWidth: 1280,
        displayAspectHeight: 720,
        displayWidth: 640,
        displayHeight: 480,
      })
    ).toEqual({ width: 1920, height: 1080 });
  });

  it('returns null when no dimensions available', () => {
    expect(resolveVideoDimensions({})).toBeNull();
  });

  it('returns null when width is 0', () => {
    expect(resolveVideoDimensions({ codedWidth: 0, codedHeight: 1080 })).toBeNull();
  });

  it('returns null when height is 0', () => {
    expect(resolveVideoDimensions({ codedWidth: 1920, codedHeight: 0 })).toBeNull();
  });
});

describe('yieldToMain', () => {
  it('returns a Promise', () => {
    const result = yieldToMain();
    expect(result).toBeInstanceOf(Promise);
  });
});

describe('getFrameDurationMs', () => {
  it('returns duration in milliseconds from VideoFrame duration (microseconds)', () => {
    const ctx = createFrameProcessingContext();
    const frame = { duration: 33_333 } as unknown as VideoFrame; // ~33.33ms (30fps)
    const { durationMs, ctx: newCtx } = getFrameDurationMs(frame, ctx);
    expect(durationMs).toBe(33);
    expect(newCtx.durationCarryUs).not.toBe(0); // fractional remainder
  });

  it('returns fallback when frame.duration is null', () => {
    const ctx = createFrameProcessingContext();
    const frame = { duration: null } as unknown as VideoFrame;
    const { durationMs } = getFrameDurationMs(frame, ctx, 100);
    expect(durationMs).toBe(100);
  });

  it('returns fallback when frame.duration <= 0', () => {
    const ctx = createFrameProcessingContext();
    const frame = { duration: 0 } as unknown as VideoFrame;
    const { durationMs } = getFrameDurationMs(frame, ctx, 50);
    expect(durationMs).toBe(50);
  });

  it('accumulates fractional remainders across frames', () => {
    // At 30fps, each frame is ~33.33ms. Rounding to 33 loses 0.33ms/frame.
    // The carry tracks both positive and negative residuals.
    let ctx = createFrameProcessingContext();
    for (let i = 0; i < 3; i++) {
      const frame = { duration: 33_333 } as unknown as VideoFrame;
      const result = getFrameDurationMs(frame, ctx);
      ctx = result.ctx;
      expect(ctx.durationCarryUs).toBeGreaterThan(-1000);
      expect(ctx.durationCarryUs).toBeLessThan(1000);
    }
    // carry should be non-zero after 3 frames (fractional accumulation)
    expect(ctx.durationCarryUs).not.toBe(0);
  });

  it('guarantees at least 1ms duration', () => {
    const ctx = createFrameProcessingContext();
    const frame = { duration: 1 } as unknown as VideoFrame; // 1 microsecond
    const { durationMs } = getFrameDurationMs(frame, ctx, 100);
    expect(durationMs).toBeGreaterThanOrEqual(1);
  });

  it('uses 100ms default fallback when no fallback provided', () => {
    const ctx = createFrameProcessingContext();
    const frame = { duration: null } as unknown as VideoFrame;
    const { durationMs } = getFrameDurationMs(frame, ctx);
    expect(durationMs).toBe(100);
  });
});

describe('compute8x8Grayscale', () => {
  it('produces a 64-element Uint8Array', () => {
    const rgb = new Uint8Array(640 * 480 * 3);
    const result = compute8x8Grayscale(rgb, 640, 480);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(64);
  });

  it('computes correct grayscale for a uniform red image', () => {
    // 16x16 image, all red (255, 0, 0) → grayscale = 85 each sample
    const w = 16;
    const h = 16;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      rgb[i * 3] = 255; // R
      rgb[i * 3 + 1] = 0; // G
      rgb[i * 3 + 2] = 0; // B
    }
    const result = compute8x8Grayscale(rgb, w, h);
    for (const v of result) {
      expect(v).toBe(85); // (255 + 0 + 0) / 3
    }
  });

  it('computes correct grayscale for a uniform white image', () => {
    const w = 16;
    const h = 16;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h * 3; i++) rgb[i] = 255;
    const result = compute8x8Grayscale(rgb, w, h);
    for (const v of result) {
      expect(v).toBe(255); // (255 + 255 + 255) / 3
    }
  });

  it('handles images where width < 8 by clamping to valid pixels', () => {
    // 4x4 image — 8x8 grid still produces 64 samples, sampling centers
    // will map to the 4x4 area
    const w = 4;
    const h = 4;
    const rgb = new Uint8Array(w * h * 3);
    const result = compute8x8Grayscale(rgb, w, h);
    expect(result.length).toBe(64);
  });
});

describe('computeMAD', () => {
  it('returns 0 for identical frames', () => {
    const a = new Uint8Array(64);
    const b = new Uint8Array(64);
    a.fill(128);
    b.fill(128);
    expect(computeMAD(a, b)).toBe(0);
  });

  it('returns expected MAD for uniform difference', () => {
    const a = new Uint8Array(64);
    const b = new Uint8Array(64);
    a.fill(0);
    b.fill(128);
    // Each of 64 pixels differs by 128, so MAD = (64 * 128) / 64 = 128
    expect(computeMAD(a, b)).toBe(128);
  });

  it('returns expected MAD for half-difference', () => {
    const a = new Uint8Array(64);
    const b = new Uint8Array(64);
    a.fill(100);
    b.fill(200);
    expect(computeMAD(a, b)).toBe(100);
  });

  it('handles arrays shorter than 64 elements gracefully', () => {
    const a = new Uint8Array(10);
    const b = new Uint8Array(10);
    a.fill(10);
    b.fill(20);
    const result = computeMAD(a, b);
    // First 10 elements differ by 10, remaining 54 are treated as 0-0=0
    expect(result).toBeCloseTo((10 * 10) / 64, 2);
  });
});

describe('getSkipThreshold', () => {
  it('returns -1 for off mode', () => {
    expect(getSkipThreshold('off')).toBe(-1);
  });

  it('returns -2 for adaptive mode', () => {
    expect(getSkipThreshold('adaptive')).toBe(-2);
  });

  it('returns 1.5 for low mode', () => {
    expect(getSkipThreshold('low')).toBe(1.5);
  });

  it('returns 3 for medium mode', () => {
    expect(getSkipThreshold('medium')).toBe(3);
  });

  it('returns 6 for high mode', () => {
    expect(getSkipThreshold('high')).toBe(6);
  });
});

describe('createFrameProcessingContext', () => {
  it('returns a fresh context with zero carry and null copyPath', () => {
    const ctx = createFrameProcessingContext();
    expect(ctx.durationCarryUs).toBe(0);
    expect(ctx.copyPath).toBeNull();
  });

  it('returns independent instances on each call', () => {
    const a = createFrameProcessingContext();
    const b = createFrameProcessingContext();
    a.durationCarryUs = 123;
    expect(b.durationCarryUs).toBe(0);
  });
});

describe('clearCanvasCache', () => {
  it('clears without error when cache is empty', () => {
    expect(() => clearCanvasCache()).not.toThrow();
  });
});
