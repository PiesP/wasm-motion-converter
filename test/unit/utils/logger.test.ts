// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.unmock('@utils/logger');
import { logger } from '@utils/logger';

describe('logger', () => {
  beforeEach(() => {
    logger.clearRecentLogs();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps warnings and errors while filtering ordinary production info/debug logs', () => {
    logger.debug('general', 'hidden debug');
    logger.info('general', 'hidden info');
    logger.warn('general', 'visible warning');
    logger.error('general', 'visible error');

    expect(logger.getRecentLogs()).toHaveLength(2);
    expect(logger.getRecentEntries().map((entry) => entry.level)).toEqual(['WARN', 'ERROR']);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('keeps performance and route logs visible in production', () => {
    logger.performance('performance sample');
    logger.info('general', '▶ route started');

    const entries = logger.getRecentEntries();
    expect(entries.map((entry) => entry.level)).toEqual(['INFO', 'WARN']);
    expect(entries[1]?.line).toContain('▶ route started');
  });

  it('serializes rich context, circular values, and truncates only the inline line', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    logger.warn('general', 'context', {
      error: new Error('boom'),
      map: new Map([['key', 'value']]),
      set: new Set(['value']),
      buffer: new ArrayBuffer(4),
      bytes: new Uint8Array([1, 2]),
      date: new Date('2026-01-01T00:00:00.000Z'),
      circular,
      long: 'x'.repeat(2100),
    });

    const entry = logger.getRecentEntries()[0]!;
    expect(entry.contextJson).toContain('Circular');
    expect(entry.contextJson).toContain('Uint8Array');
    expect(entry.line).toContain('…(truncated)');
  });

  it('clamps conversion progress and clears it when stale or complete', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    logger.setConversionProgress(42.4);
    logger.warn('general', 'with progress');
    expect(logger.getRecentEntries()[0]?.conversionProgress).toBe(42);

    now.mockReturnValue(1000 + 10 * 60 * 1000 + 1);
    logger.warn('general', 'stale progress');
    expect(logger.getRecentEntries()[1]?.conversionProgress).toBeNull();

    logger.setConversionProgress(200);
    logger.warn('general', 'completed progress');
    expect(logger.getRecentEntries()[2]?.conversionProgress).toBeNull();
    now.mockRestore();
  });

  it('evicts non-important entries before important entries', () => {
    for (let i = 0; i < 751; i++) logger.warn('cdn', `cdn-${i}`);
    expect(logger.getRecentLogs()).toHaveLength(750);
    expect(logger.getRecentLogs()[0]).toContain('cdn-1');

    logger.clearRecentLogs();
    for (let i = 0; i < 751; i++) logger.warn('general', `general-${i}`);
    expect(logger.getRecentLogs()).toHaveLength(750);
    expect(logger.getRecentLogs()[0]).toContain('general-1');
  });
});
