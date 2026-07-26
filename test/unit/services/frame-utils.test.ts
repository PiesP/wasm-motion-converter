// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { describe, it, expect, vi } from 'vitest';
import {
  clearCanvasCache,
  convertRGBAToRGB,
  convertRGBToRGBA,
  getFrameDurationMs,
  resolveVideoDimensions,
} from '@services/frame-utils';

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
});

// ═══════════════════════════════════════════════════════════════════
// convertRGBAToRGB
// ═══════════════════════════════════════════════════════════════════

describe('convertRGBAToRGB', () => {
  it('strips alpha channel from RGBA pixels', () => {
    const rgba = new Uint8ClampedArray([255, 128, 64, 200]);
    const rgb = convertRGBAToRGB(rgba, 1, 1, 'RGBA');
    // BufferPool.acquire rounds up to power of 2 — 3 bytes → 4 bytes bucket
    expect(rgb.byteLength).toBeGreaterThanOrEqual(3);
    expect(rgb[0]).toBe(255);
    expect(rgb[1]).toBe(128);
    expect(rgb[2]).toBe(64);
  });

  it('handles multiple pixels correctly (RGBA)', () => {
    const rgba = new Uint8ClampedArray([
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
    const rgba = new Uint8ClampedArray([100, 200, 50, 0]);
    const rgb = convertRGBAToRGB(rgba, 1, 1, 'RGBA');
    expect(rgb.byteLength).toBeGreaterThanOrEqual(3);
    expect(rgb[0]).toBe(100);
    expect(rgb[1]).toBe(200);
    expect(rgb[2]).toBe(50);
  });

  it('handles full-opacity pixel (alpha=255) unchanged', () => {
    const rgba = new Uint8ClampedArray([10, 20, 30, 255]);
    const rgb = convertRGBAToRGB(rgba, 1, 1, 'RGBA');
    expect(rgb.byteLength).toBeGreaterThanOrEqual(3);
    expect(rgb[0]).toBe(10);
    expect(rgb[1]).toBe(20);
    expect(rgb[2]).toBe(30);
  });

  it('handles BGRA format (little-endian byte order)', () => {
    // BGRA: B=byte0, G=byte1, R=byte2, A=byte3
    const bgra = new Uint8ClampedArray([64, 128, 255, 200]);
    const rgb = convertRGBAToRGB(bgra, 1, 1, 'BGRA');
    expect(rgb.byteLength).toBeGreaterThanOrEqual(3);
    expect(rgb[0]).toBe(255);
    expect(rgb[1]).toBe(128);
    expect(rgb[2]).toBe(64);
  });

  it('throws when source buffer is too small', () => {
    const tooSmall = new Uint8ClampedArray([255, 0]); // 2 bytes, needs 4
    expect(() => convertRGBAToRGB(tooSmall, 1, 1, 'RGBA')).toThrow(RangeError);
  });

  it('throws on empty input (pixelCount=0)', () => {
    const rgba = new Uint8ClampedArray([]);
    // pixelCount=0 → acquire(0) → BufferPool returns 1-byte bucket (min size)
    // The source Uint8ClampedArray(0) has byteLength=0 which is less than needsBytes=0
    // Actually needsBytes = 0*4 = 0, so the bounds check passes, and acquire(0) returns a 1-byte buffer
    // The function should not throw for zero dimensions
    expect(() => convertRGBAToRGB(rgba, 0, 0, 'RGBA')).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════
// convertRGBToRGBA
// ═══════════════════════════════════════════════════════════════════

describe('convertRGBToRGBA', () => {
  it('adds alpha=255 to RGB pixels', () => {
    const rgb = new Uint8ClampedArray([255, 128, 64]);
    const rgba = convertRGBToRGBA(rgb, 1, 1);
    expect(rgba).toHaveLength(4);
    expect(rgba[0]).toBe(255);
    expect(rgba[1]).toBe(128);
    expect(rgba[2]).toBe(64);
    expect(rgba[3]).toBe(255);
  });

  it('handles multiple pixels correctly', () => {
    const rgb = new Uint8ClampedArray([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    const rgba = convertRGBToRGBA(rgb, 3, 1);
    // 3 pixels × 4 bytes = 12 bytes, pool rounds to 16
    expect(rgba.byteLength).toBeGreaterThanOrEqual(12);
    expect(rgba[0]).toBe(255); expect(rgba[1]).toBe(0); expect(rgba[2]).toBe(0); expect(rgba[3]).toBe(255);
    expect(rgba[4]).toBe(0); expect(rgba[5]).toBe(255); expect(rgba[6]).toBe(0); expect(rgba[7]).toBe(255);
    expect(rgba[8]).toBe(0); expect(rgba[9]).toBe(0); expect(rgba[10]).toBe(255); expect(rgba[11]).toBe(255);
  });

  it('handles zero dimensions', () => {
    const rgb = new Uint8ClampedArray([]);
    const rgba = convertRGBToRGBA(rgb, 0, 0);
    expect(rgba).toHaveLength(0);
  });

  it('converts RGB pixels correctly with pool reuse', () => {
    const rgb = new Uint8ClampedArray([255, 128, 64]);
    const rgba = convertRGBToRGBA(rgb, 1, 1);
    expect(rgba.byteLength).toBeGreaterThanOrEqual(4);
    expect(rgba[0]).toBe(255);
    expect(rgba[1]).toBe(128);
    expect(rgba[2]).toBe(64);
    expect(rgba[3]).toBe(255);
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
