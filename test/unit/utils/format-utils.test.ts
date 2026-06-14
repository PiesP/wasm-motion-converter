// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { describe, it, expect } from 'vitest';
import { formatDuration, formatBytes, createId } from '@utils/format-utils';

describe('formatDuration', () => {
  it('formats 0 seconds as 0:00', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  it('formats seconds only', () => {
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(45)).toBe('0:45');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(125)).toBe('2:05');
    expect(formatDuration(599)).toBe('9:59');
  });

  it('formats hours, minutes, and seconds', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3661)).toBe('1:01:01');
    expect(formatDuration(7322)).toBe('2:02:02');
  });

  it('handles negative input by clamping to 0', () => {
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(-100)).toBe('0:00');
  });

  it('floors fractional seconds', () => {
    expect(formatDuration(5.9)).toBe('0:05');
    expect(formatDuration(61.1)).toBe('1:01');
  });

  it('handles large values', () => {
    expect(formatDuration(86400)).toBe('24:00:00');
  });
});

describe('formatBytes', () => {
  it('formats 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatBytes(1)).toBe('1.0 B');
    expect(formatBytes(512)).toBe('512.0 B');
    expect(formatBytes(1023)).toBe('1023.0 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10240)).toBe('10.0 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1.0 MB');
    expect(formatBytes(5242880)).toBe('5.0 MB');
  });

  it('formats gigabytes', () => {
    expect(formatBytes(1073741824)).toBe('1.0 GB');
    expect(formatBytes(5368709120)).toBe('5.0 GB');
  });
});

describe('createId', () => {
  it('generates a non-empty string', () => {
    const id = createId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createId()));
    expect(ids.size).toBe(100);
  });

  it('generates UUID format when crypto.randomUUID is available', () => {
    const id = createId();
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
