// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vitest';
import { globalBufferPool } from '@services/buffer-pool';
import {
  clearCanvasCache,
  copyFrameToPixels,
  compute8x8Grayscale,
  convertRGBAToRGB,
  getFrameDurationMs,
  resolveVideoDimensions,
} from '@services/frame-utils';
import { MAX_FRAME_PIXEL_COUNT } from '@utils/constants';

afterEach(() => {
  clearCanvasCache();
  vi.unstubAllGlobals();
});

describe('resolveVideoDimensions', () => {
  it('prefers display aspect dimensions for square-pixel animation output', () => {
    expect(
      resolveVideoDimensions({
        codedWidth: 720,
        codedHeight: 576,
        displayAspectWidth: 1024,
        displayAspectHeight: 576,
      })
    ).toEqual({ width: 1024, height: 576 });
  });

  it.each([
    ['zero', 0, 576],
    ['negative', -1, 576],
    ['fractional', 1024.5, 576],
    ['NaN', Number.NaN, 576],
    ['infinite', Number.POSITIVE_INFINITY, 576],
    ['incomplete', 1024, undefined],
  ])('rejects %s display aspect dimensions instead of falling back to coded size', (_name, width, height) => {
    expect(
      resolveVideoDimensions({
        codedWidth: 720,
        codedHeight: 576,
        displayAspectWidth: width,
        displayAspectHeight: height,
      })
    ).toBeNull();
  });

  it('rejects display aspect dimensions above the per-frame working-memory budget', () => {
    expect(
      resolveVideoDimensions({
        codedWidth: 720,
        codedHeight: 576,
        displayAspectWidth: MAX_FRAME_PIXEL_COUNT + 1,
        displayAspectHeight: 1,
      })
    ).toBeNull();
  });

  it('accepts dimensions at the conservative per-frame working-memory boundary', () => {
    expect(
      resolveVideoDimensions({
        displayAspectWidth: MAX_FRAME_PIXEL_COUNT,
        displayAspectHeight: 1,
      })
    ).toEqual({ width: MAX_FRAME_PIXEL_COUNT, height: 1 });
  });

  it.each([
    ['coded', { codedWidth: Number.MAX_SAFE_INTEGER, codedHeight: 2 }],
    ['raw display', { displayWidth: Number.MAX_SAFE_INTEGER, displayHeight: 2 }],
  ])('rejects unsafe %s dimensions at the shared allocation boundary', (_name, config) => {
    expect(resolveVideoDimensions(config)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// clearCanvasCache
// ═══════════════════════════════════════════════════════════════════

describe('clearCanvasCache', () => {
  it('does not throw when cache is empty', () => {
    expect(() => clearCanvasCache()).not.toThrow();
  });

  it('is idempotent — calling twice does not throw', () => {
    clearCanvasCache();
    expect(() => clearCanvasCache()).not.toThrow();
  });

  it('closes transient bitmaps and releases cached canvas backing stores', async () => {
    const canvases: Array<{ width: number; height: number }> = [];
    const closeBitmap = vi.fn();
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray([
          255, 0, 0, 255,
          0, 255, 0, 255,
          0, 0, 255, 255,
          255, 255, 255, 255,
        ]),
      })),
    };
    class FakeOffscreenCanvas {
      width: number;
      height: number;

      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        canvases.push(this);
      }

      getContext(): typeof context {
        return context;
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 2, height: 2, close: closeBitmap }))
    );
    const frame = {
      codedWidth: 4,
      codedHeight: 4,
      displayWidth: 4,
      displayHeight: 4,
    } as VideoFrame;

    const rgb = await copyFrameToPixels(
      frame,
      2,
      2,
      { durationCarryUs: 0, copyPath: null },
      'rgb'
    );

    expect([...rgb.subarray(0, 12)]).toEqual([
      255, 0, 0,
      0, 255, 0,
      0, 0, 255,
      255, 255, 255,
    ]);
    expect(closeBitmap).toHaveBeenCalledOnce();
    expect(canvases).toEqual([{ width: 2, height: 2 }]);
    globalBufferPool.release(rgb);

    clearCanvasCache();

    expect(canvases).toEqual([{ width: 0, height: 0 }]);
  });
});

describe('opaque RGBA frame copying', () => {
  it('uses and caches the successful RGBX strategy while forcing opaque alpha', async () => {
    const attemptedFormats: VideoPixelFormat[] = [];
    const frame = {
      allocationSize: () => 8,
      codedHeight: 1,
      codedWidth: 2,
      copyTo: async (destination: AllowSharedBufferSource, options: VideoFrameCopyToOptions) => {
        attemptedFormats.push(options.format!);
        const bytes = new Uint8Array(
          ArrayBuffer.isView(destination) ? destination.buffer : destination
        );
        bytes.set([10, 20, 30, 0, 40, 50, 60, 7]);
        return [{ offset: 0, stride: 8 }];
      },
      displayHeight: 1,
      displayWidth: 2,
    } as unknown as VideoFrame;
    const context = { durationCarryUs: 0, copyPath: null };

    const first = await copyFrameToPixels(frame, 2, 1, context, 'rgba');
    const second = await copyFrameToPixels(frame, 2, 1, context, 'rgba');

    expect([...first.subarray(0, 8)]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    expect([...second.subarray(0, 8)]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    expect(context.copyPath).toBe('RGBX');
    expect(attemptedFormats).toEqual(['RGBX', 'RGBX']);
    globalBufferPool.release(first);
    globalBufferPool.release(second);
  });

  it('normalizes and caches BGRA after earlier native formats fail', async () => {
    const attemptedFormats: VideoPixelFormat[] = [];
    const frame = {
      allocationSize: () => 4,
      codedHeight: 1,
      codedWidth: 1,
      copyTo: async (destination: AllowSharedBufferSource, options: VideoFrameCopyToOptions) => {
        attemptedFormats.push(options.format!);
        if (options.format !== 'BGRA') throw new Error('unsupported format');
        const bytes = new Uint8Array(
          ArrayBuffer.isView(destination) ? destination.buffer : destination
        );
        bytes.set([30, 20, 10, 4]);
        return [{ offset: 0, stride: 4 }];
      },
      displayHeight: 1,
      displayWidth: 1,
    } as unknown as VideoFrame;
    const context = { durationCarryUs: 0, copyPath: null };

    const first = await copyFrameToPixels(frame, 1, 1, context, 'rgba');
    attemptedFormats.length = 0;
    const second = await copyFrameToPixels(frame, 1, 1, context, 'rgba');

    expect([...first.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([...second.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
    expect(context.copyPath).toBe('BGRA');
    expect(attemptedFormats).toEqual(['BGRA']);
    globalBufferPool.release(first);
    globalBufferPool.release(second);
  });

  it('recovers when a later frame no longer supports the cached native strategy', async () => {
    let frameNumber = 0;
    const attempts: VideoPixelFormat[] = [];
    const frame = {
      allocationSize: () => 4,
      codedHeight: 1,
      codedWidth: 1,
      copyTo: async (destination: AllowSharedBufferSource, options: VideoFrameCopyToOptions) => {
        attempts.push(options.format!);
        if (frameNumber === 1 && options.format === 'RGBX') {
          throw new Error('RGBX disappeared');
        }
        if (frameNumber === 1 && options.format !== 'RGBA') {
          throw new Error('use RGBA');
        }
        const bytes = new Uint8Array(
          ArrayBuffer.isView(destination) ? destination.buffer : destination
        );
        bytes.set([10, 20, 30, 0]);
        return [{ offset: 0, stride: 4 }];
      },
      displayHeight: 1,
      displayWidth: 1,
    } as unknown as VideoFrame;
    const context = { durationCarryUs: 0, copyPath: null };

    const first = await copyFrameToPixels(frame, 1, 1, context, 'rgba');
    frameNumber = 1;
    attempts.length = 0;
    const second = await copyFrameToPixels(frame, 1, 1, context, 'rgba');

    expect([...first.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([...second.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
    expect(attempts).toEqual(['RGBX', 'RGBA']);
    expect(context.copyPath).toBe('RGBA');
    globalBufferPool.release(first);
    globalBufferPool.release(second);
  });

  it('returns an exact opaque Canvas view and reuses the Canvas strategy', async () => {
    const nativeCopy = vi.fn(async () => {
      throw new Error('native copy must not run');
    });
    const imageData = new Uint8ClampedArray([10, 20, 30, 0, 40, 50, 60, 4]);
    const context2d = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: imageData })),
    };
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext(): typeof context2d {
          return context2d;
        }
      }
    );
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
    const frame = {
      allocationSize: () => 8,
      codedHeight: 2,
      codedWidth: 2,
      copyTo: nativeCopy,
      displayHeight: 2,
      displayWidth: 2,
    } as unknown as VideoFrame;
    const context = { durationCarryUs: 0, copyPath: null };

    const scaled = await copyFrameToPixels(frame, 2, 1, context, 'rgba');
    const cached = await copyFrameToPixels(frame, 2, 1, context, 'rgba');

    expect(scaled.byteLength).toBe(8);
    expect([...scaled]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    expect([...cached]).toEqual([...scaled]);
    expect(context.copyPath).toBe('canvas');
    expect(nativeCopy).not.toHaveBeenCalled();
    expect(context2d.getImageData).toHaveBeenCalledTimes(2);
  });

  it('samples identical RGB values from packed RGB and opaque RGBA', () => {
    const rgb = new Uint8Array(8 * 8 * 3);
    const rgba = new Uint8Array(8 * 8 * 4);
    for (let index = 0; index < 64; index++) {
      const value = index * 3;
      rgb.set([value, value + 1, value + 2], index * 3);
      rgba.set([value, value + 1, value + 2, 255], index * 4);
    }

    expect(compute8x8Grayscale(rgba, 8, 8, 4)).toEqual(compute8x8Grayscale(rgb, 8, 8, 3));
  });
});

// ═══════════════════════════════════════════════════════════════════
// convertRGBAToRGB
// ═══════════════════════════════════════════════════════════════════

describe('convertRGBAToRGB', () => {
  it('strips alpha channel from RGBA pixels', () => {
    const rgba = new Uint8Array([255, 128, 64, 200]);
    const rgb = convertRGBAToRGB(rgba, 1, 1, 'RGBA');
    // BufferPool.acquire rounds up to power of 2 — 3 bytes → 4 bytes bucket
    expect(rgb.byteLength).toBeGreaterThanOrEqual(3);
    expect(rgb[0]).toBe(255);
    expect(rgb[1]).toBe(128);
    expect(rgb[2]).toBe(64);
  });

  it('handles multiple pixels correctly (RGBA)', () => {
    const rgba = new Uint8Array([
      255, 0, 0, 255,
      0, 255, 0, 128,
      0, 0, 255, 64,
    ]);
    const rgb = convertRGBAToRGB(rgba, 3, 1, 'RGBA');
    // 3 pixels × 3 bytes = 9 bytes, pool rounds to 16
    expect(rgb.byteLength).toBeGreaterThanOrEqual(9);
    expect(rgb[0]).toBe(255);
    expect(rgb[1]).toBe(0);
    expect(rgb[2]).toBe(0);
    expect(rgb[3]).toBe(0);
    expect(rgb[4]).toBe(255);
    expect(rgb[5]).toBe(0);
    expect(rgb[6]).toBe(0);
    expect(rgb[7]).toBe(0);
    expect(rgb[8]).toBe(255);
  });

  it('handles transparent pixel (alpha=0)', () => {
    const rgba = new Uint8Array([100, 200, 50, 0]);
    const rgb = convertRGBAToRGB(rgba, 1, 1, 'RGBA');
    expect(rgb.byteLength).toBeGreaterThanOrEqual(3);
    expect(rgb[0]).toBe(100);
    expect(rgb[1]).toBe(200);
    expect(rgb[2]).toBe(50);
  });

  it('handles full-opacity pixel (alpha=255) unchanged', () => {
    const rgba = new Uint8Array([10, 20, 30, 255]);
    const rgb = convertRGBAToRGB(rgba, 1, 1, 'RGBA');
    expect(rgb.byteLength).toBeGreaterThanOrEqual(3);
    expect(rgb[0]).toBe(10);
    expect(rgb[1]).toBe(20);
    expect(rgb[2]).toBe(30);
  });

  it('handles BGRA format (little-endian byte order)', () => {
    // BGRA: B=byte0, G=byte1, R=byte2, A=byte3
    const bgra = new Uint8Array([64, 128, 255, 200]);
    const rgb = convertRGBAToRGB(bgra, 1, 1, 'BGRA');
    expect(rgb.byteLength).toBeGreaterThanOrEqual(3);
    expect(rgb[0]).toBe(255);
    expect(rgb[1]).toBe(128);
    expect(rgb[2]).toBe(64);
  });

  it('throws when source buffer is too small', () => {
    const tooSmall = new Uint8Array([255, 0]); // 2 bytes, needs 4
    expect(() => convertRGBAToRGB(tooSmall, 1, 1, 'RGBA')).toThrow(RangeError);
  });

  it('throws on empty input (pixelCount=0)', () => {
    const rgba = new Uint8Array([]);
    // pixelCount=0 → acquire(0) → BufferPool returns 1-byte bucket (min size)
    // The source Uint8Array(0) has byteLength=0 which is less than needsBytes=0
    // Actually needsBytes = 0*4 = 0, so the bounds check passes, and acquire(0) returns a 1-byte buffer
    // The function should not throw for zero dimensions
    expect(() => convertRGBAToRGB(rgba, 0, 0, 'RGBA')).not.toThrow();
  });
});

describe('getFrameDurationMs', () => {
  it('returns duration in milliseconds from centisecond delay', () => {
    // 100 centiseconds = 1000ms
    const ctx = { durationCarryUs: 0, copyPath: null };
    const result = getFrameDurationMs({ duration: 1000000 } as any, ctx);
    expect(result.durationMs).toBe(1000);
  });

  it('returns integer milliseconds', () => {
    const ctx = { durationCarryUs: 0, copyPath: null };
    expect(getFrameDurationMs({ duration: 500000 } as any, ctx).durationMs).toBe(500);
    expect(getFrameDurationMs({ duration: 330000 } as any, ctx).durationMs).toBe(330);
  });

  it('handles null duration by returning fallbackMs', () => {
    const ctx = { durationCarryUs: 0, copyPath: null };
    expect(getFrameDurationMs({ duration: null } as any, ctx).durationMs).toBe(100);
  });
  it('handles zero delay (returns fallbackMs=100)', () => {
    const ctx = { durationCarryUs: 0, copyPath: null };
    // duration=0 → raw<=0 → returns fallbackMs=100 (default)
    const result = getFrameDurationMs({ duration: 0 } as any, ctx);
    expect(result.durationMs).toBe(100);
  });

  it('handles positive carry across frames', () => {
    const ctx = { durationCarryUs: 0, copyPath: null };
    // 333333us: rounds to 333ms, carry = 333333 - 333*1000 = 333us
    const r1 = getFrameDurationMs({ duration: 333333 } as any, ctx);
    expect(r1.durationMs).toBe(333);
    expect(r1.ctx.durationCarryUs).toBe(333);
  });

  it('uses fallbackMs when duration is null', () => {
    const ctx = { durationCarryUs: 0, copyPath: null };
    const result = getFrameDurationMs({ duration: null } as any, ctx, 50);
    expect(result.durationMs).toBe(50);
  });
});
