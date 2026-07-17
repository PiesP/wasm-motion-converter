// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
//
// Unit tests for trim validation utility functions.
// Tests mirror the logic from TrimSelector.tsx — pure functions for time parsing,
// clamping, formatting, and duration checks.

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Pure functions matching TrimSelector.tsx implementation
// ---------------------------------------------------------------------------

const TRIM_END_FULL_DURATION = 0;

function isFullDuration(trimEnd: number): boolean {
  return trimEnd === TRIM_END_FULL_DURATION;
}

const STEP = 0.1;

function clampToStep(value: number): number {
  return Number((Math.round(value / STEP) * STEP).toFixed(2));
}

function formatTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function formatTimePrecise(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toFixed(1).padStart(4, '0')}`;
}

function parseTimeInput(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const colonCount = (trimmed.match(/:/g) || []).length;
  if (colonCount >= 1) {
    const parts = trimmed.split(':');
    if (colonCount === 1 && parts.length === 2) {
      const m = parseFloat(parts[0]!);
      const s = parseFloat(parts[1]!);
      if (Number.isNaN(m) || Number.isNaN(s)) return null;
      return m * 60 + s;
    }
    if (colonCount === 2 && parts.length === 3) {
      const h = parseFloat(parts[0]!);
      const m = parseFloat(parts[1]!);
      const s = parseFloat(parts[2]!);
      if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s)) return null;
      return h * 3600 + m * 60 + s;
    }
    return null;
  }
  const num = parseFloat(trimmed);
  return Number.isNaN(num) ? null : num;
}

describe('isFullDuration', () => {
  it('returns true when trimEnd is 0', () => {
    expect(isFullDuration(0)).toBe(true);
  });

  it('returns false when trimEnd is non-zero', () => {
    expect(isFullDuration(5)).toBe(false);
    expect(isFullDuration(-1)).toBe(false);
    expect(isFullDuration(0.1)).toBe(false);
  });
});

describe('clampToStep', () => {
  it('rounds to nearest 0.1', () => {
    expect(clampToStep(1.05)).toBe(1.1);
    expect(clampToStep(1.04)).toBe(1.0);
    expect(clampToStep(1.0)).toBe(1.0);
    expect(clampToStep(0.5)).toBe(0.5);
  });

  it('handles zero', () => {
    expect(clampToStep(0)).toBe(0);
    expect(clampToStep(-0.04)).toBe(0);
  });

  it('handles exact step boundaries', () => {
    expect(clampToStep(2.0)).toBe(2.0);
    expect(clampToStep(3.5)).toBe(3.5);
  });

  it('rounds up at 0.05 threshold', () => {
    // Use values that avoid floating-point edge cases
    expect(clampToStep(0.25)).toBe(0.3);
    expect(clampToStep(0.45)).toBe(0.5);
  });

  it('rounds down below 0.05 threshold', () => {
    expect(clampToStep(1.14)).toBe(1.1);
    expect(clampToStep(1.04)).toBe(1.0);
  });
});

describe('formatTime', () => {
  it('formats seconds as m:ss', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(5)).toBe('0:05');
    expect(formatTime(65)).toBe('1:05');
    expect(formatTime(90)).toBe('1:30');
  });

  it('formats with hours as h:mm:ss', () => {
    expect(formatTime(3600)).toBe('1:00:00');
    expect(formatTime(3661)).toBe('1:01:01');
    expect(formatTime(7322)).toBe('2:02:02');
  });

  it('pads minutes and seconds correctly', () => {
    expect(formatTime(7)).toBe('0:07');
    expect(formatTime(70)).toBe('1:10');
    expect(formatTime(127)).toBe('2:07');
  });
});

describe('formatTimePrecise', () => {
  it('formats with one decimal place', () => {
    expect(formatTimePrecise(0)).toBe('0:00.0');
    expect(formatTimePrecise(5.5)).toBe('0:05.5');
    expect(formatTimePrecise(65.3)).toBe('1:05.3');
  });

  it('pads seconds with leading zeros', () => {
    expect(formatTimePrecise(7.1)).toBe('0:07.1');
    expect(formatTimePrecise(70.0)).toBe('1:10.0');
  });
});

describe('parseTimeInput', () => {
  // ── mm:ss format ───────────────────────────────────────────
  it('parses mm:ss format', () => {
    expect(parseTimeInput('1:30')).toBe(90);
    expect(parseTimeInput('0:05')).toBe(5);
    expect(parseTimeInput('2:00')).toBe(120);
  });

  it('parses mm:ss with decimal seconds', () => {
    expect(parseTimeInput('1:30.5')).toBe(90.5);
    expect(parseTimeInput('0:05.25')).toBe(5.25);
  });

  // ── h:mm:ss format ─────────────────────────────────────────
  it('parses h:mm:ss format', () => {
    expect(parseTimeInput('1:00:00')).toBe(3600);
    expect(parseTimeInput('0:01:30')).toBe(90);
    expect(parseTimeInput('2:30:00')).toBe(9000);
  });

  it('parses h:mm:ss with decimal seconds', () => {
    expect(parseTimeInput('1:00:00.5')).toBe(3600.5);
  });

  // ── Decimal seconds ────────────────────────────────────────
  it('parses plain decimal seconds', () => {
    expect(parseTimeInput('30')).toBe(30);
    expect(parseTimeInput('90.5')).toBe(90.5);
    expect(parseTimeInput('0')).toBe(0);
  });

  // ── Edge cases ─────────────────────────────────────────────
  it('returns null for empty string', () => {
    expect(parseTimeInput('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseTimeInput('   ')).toBeNull();
  });

  it('returns null for invalid text', () => {
    expect(parseTimeInput('abc')).toBeNull();
    expect(parseTimeInput('hello')).toBeNull();
  });

  it('returns null for partial colon formats', () => {
    expect(parseTimeInput('1:')).toBeNull();
    expect(parseTimeInput(':30')).toBeNull();
    expect(parseTimeInput('1:2:')).toBeNull();
  });

  it('returns null for too many colons', () => {
    expect(parseTimeInput('1:2:3:4')).toBeNull();
  });

  it('trims whitespace from input', () => {
    expect(parseTimeInput('  1:30  ')).toBe(90);
    expect(parseTimeInput('  90  ')).toBe(90);
  });

  it('returns null for non-numeric segments in colon format', () => {
    expect(parseTimeInput('a:30')).toBeNull();
    expect(parseTimeInput('1:b')).toBeNull();
    expect(parseTimeInput('a:b:c')).toBeNull();
  });

  // ── Trim validation range logic (mirrors settings-store) ───
  it('provides values that satisfy trim start < trim end requirement', () => {
    // This validates the data flow: parsed values should be usable
    // for the trimStart < trimEnd check in getInitialConversionSettings
    const start = parseTimeInput('0:05')!;   // 5
    const end = parseTimeInput('0:10')!;     // 10
    expect(start).toBe(5);
    expect(end).toBe(10);
    expect(start).toBeLessThan(end);
  });

  it('parsed values can be invalid trim ranges (start >= end)', () => {
    // The parser doesn't validate range — that's the store's job.
    // This test documents the separation: parser accepts anything numeric.
    const start = parseTimeInput('0:10')!;   // 10
    const end = parseTimeInput('0:05')!;     // 5
    expect(start).toBeGreaterThan(end);
  });
});
