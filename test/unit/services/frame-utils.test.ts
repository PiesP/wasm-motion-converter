// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { describe, it, expect, vi } from 'vitest';
import {
  clearCanvasCache,
  convertRGBAToRGB,
  convertRGBToRGBA,
  getFrameDurationMs,
} from '@services/frame-utils';

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
    expect(rgb).toHaveLength(3);
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
    expect(rgb).toHaveLength(9);
    expect(rgb).toEqual(new Uint8ClampedArray([255, 0, 0, 0, 255, 0, 0, 0, 255]));
  });

  it('handles transparent pixel (alpha=0)', () => {
    const rgba = new Uint8ClampedArray([100, 200, 50, 0]);
    const rgb = convertRGBAToRGB(rgba, 1, 1, 'RGBA');
    expect(rgb).toEqual(new Uint8ClampedArray([100, 200, 50]));
  });

  it('handles full-opacity pixel (alpha=255) unchanged', () => {
    const rgba = new Uint8ClampedArray([10, 20, 30, 255]);
    const rgb = convertRGBAToRGB(rgba, 1, 1, 'RGBA');
    expect(rgb).toEqual(new Uint8ClampedArray([10, 20, 30]));
  });

  it('handles BGRA format (little-endian byte order)', () => {
    // BGRA: B=byte0, G=byte1, R=byte2, A=byte3
    const bgra = new Uint8ClampedArray([64, 128, 255, 200]);
    const rgb = convertRGBAToRGB(bgra, 1, 1, 'BGRA');
    expect(rgb).toEqual(new Uint8ClampedArray([255, 128, 64]));
  });

  it('throws when source buffer is too small', () => {
    const tooSmall = new Uint8ClampedArray([255, 0, 0]); // 3 bytes, needs 4
    expect(() => convertRGBAToRGB(tooSmall, 1, 1, 'RGBA')).toThrow(RangeError);
  });

  it('throws on empty input (pixelCount=0)', () => {
    const rgba = new Uint8ClampedArray([]);
    expect(() => convertRGBAToRGB(rgba, 0, 0, 'RGBA')).toThrow();
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
    expect(rgba).toHaveLength(12);
    expect(rgba.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 0, 0, 255]));
    expect(rgba.slice(4, 8)).toEqual(new Uint8ClampedArray([0, 255, 0, 255]));
    expect(rgba.slice(8, 12)).toEqual(new Uint8ClampedArray([0, 0, 255, 255]));
  });

  it('throws when source buffer is too small', () => {
    expect(() => convertRGBToRGBA(new Uint8ClampedArray([255, 0]), 1, 1)).toThrow();
  });

  it('handles zero dimensions', () => {
    const rgb = new Uint8ClampedArray([]);
    const rgba = convertRGBToRGBA(rgb, 0, 0);
    expect(rgba).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// getFrameDurationMs
// ═══════════════════════════════════════════════════════════════════

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

  it('handles zero delay (returns 1ms minimum)', () => {
    const ctx = { durationCarryUs: 0, copyPath: null };
    const result = getFrameDurationMs({ duration: 0 } as any, ctx);
    expect(result.durationMs).toBe(1);
  });

  it('handles null duration by returning fallbackMs', () => {
    const ctx = { durationCarryUs: 0, copyPath: null };
    expect(getFrameDurationMs({ duration: null } as any, ctx).durationMs).toBe(100);
  });

  it('handles negative duration by returning fallbackMs', () => {
    const ctx = { durationCarryUs: 0, copyPath: null };
    expect(getFrameDurationMs({ duration: -1 } as any, ctx).durationMs).toBe(100);
  });

  it('carries fractional remainder across frames', () => {
    const ctx = { durationCarryUs: 0, copyPath: null };
    // 333333us at 30fps — 333.333ms rounds to 333ms, carry = 333333 - 333*1000 = 333us
    const r1 = getFrameDurationMs({ duration: 333333 } as any, ctx);
    expect(r1.durationMs).toBe(333);
    expect(r1.ctx.durationCarryUs).toBe(333);
    // Next frame adds carry: 333333 + 333 = 333666us → 333.666ms → rounds to 334ms, carry=666us
    const r2 = getFrameDurationMs({ duration: 333333 } as any, r1.ctx);
    expect(r2.durationMs).toBe(334);
    expect(r2.ctx.durationCarryUs).toBe(666);
  });

  it('uses fallbackMs when duration is null', () => {
    const ctx = { durationCarryUs: 0, copyPath: null };
    const result = getFrameDurationMs({ duration: null } as any, ctx, 50);
    expect(result.durationMs).toBe(50);
  });
});
