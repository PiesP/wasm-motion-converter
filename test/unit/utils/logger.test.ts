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
    expect(entries.map((entry) => entry.level)).toEqual(['INFO', 'INFO']);
    expect(entries[1]?.line).toContain('▶ route started');
    expect(console.info).toHaveBeenCalledTimes(2);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('serializes rich context, circular values, and truncates only the inline line', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    logger.warn('general', 'context', {
      error: new Error('boom'),
      bigint: 42n,
      map: new Map([['key', 'value']]),
      set: new Set(['value']),
      buffer: new ArrayBuffer(4),
      bytes: new Uint8Array([1, 2]),
      date: new Date('2026-01-01T00:00:00.000Z'),
      circular,
      long: 'x'.repeat(2100),
    });

    const entry = logger.getRecentEntries()[0]!;
    expect(JSON.parse(entry.contextJson!)).toMatchObject({
      error: { name: 'Error', message: 'boom' },
      bigint: '42',
      map: { type: 'Map', entries: [['key', 'value']] },
      set: { type: 'Set', values: ['value'] },
      buffer: { type: 'ArrayBuffer', byteLength: 4 },
      bytes: { type: 'Uint8Array', length: 2 },
      date: '2026-01-01T00:00:00.000Z',
      circular: { self: '[Circular]' },
    });
    expect(entry.line).toContain('…(truncated)');
  });

  it('clamps conversion progress and clears it when stale or complete', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    logger.setConversionProgress(42.4);
    logger.warn('general', 'with progress');
    expect(logger.getRecentEntries()[0]?.conversionProgress).toBe(42);
    expect(logger.getRecentEntries()[0]?.line).toContain('[42%]');

    logger.setConversionProgress(Number.NaN);
    logger.warn('progress', 'progress category');
    expect(logger.getRecentEntries()[1]?.conversionProgress).toBeNull();

    now.mockReturnValue(1000 + 10 * 60 * 1000);
    logger.warn('general', 'boundary progress');
    expect(logger.getRecentEntries()[2]?.conversionProgress).toBe(42);

    now.mockReturnValue(1000 + 10 * 60 * 1000 + 1);
    logger.warn('general', 'stale progress');
    expect(logger.getRecentEntries()[3]?.conversionProgress).toBeNull();

    logger.setConversionProgress(200);
    logger.warn('general', 'completed progress');
    expect(logger.getRecentEntries()[4]?.conversionProgress).toBeNull();
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

    logger.clearRecentLogs();
    for (let i = 0; i < 749; i++) logger.warn('general', `general-${i}`);
    logger.warn('cdn', 'disposable');
    logger.warn('general', 'latest important');
    expect(logger.getRecentEntries()).toHaveLength(750);
    expect(logger.getRecentEntries().some((entry) => entry.message === 'disposable')).toBe(false);
    expect(logger.getRecentEntries().at(-1)?.message).toBe('latest important');
  });
});
