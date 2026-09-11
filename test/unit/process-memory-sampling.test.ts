// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it, vi } from 'vitest';

import {
  readLinuxProcessMemory,
  summarizeProcessMemory,
  type ProcessMemoryReading,
} from '../e2e/fixtures/process-memory';

describe('Linux Chromium process-memory sampling', () => {
  it('keeps RSS diagnostic-only when smaps_rollup is unavailable', async () => {
    const readTextFile = vi.fn(async (path: string) => {
      if (path.endsWith('/smaps_rollup')) throw new Error('permission denied');
      return 'Name:\tchromium\nVmRSS:\t4096 kB\n';
    });

    await expect(readLinuxProcessMemory(101, readTextFile)).resolves.toEqual({
      pssMB: null,
      rssMB: 4,
      pssSource: 'unavailable',
      rssSource: 'status',
      errors: ['smaps_rollup: read failed'],
    });
  });

  it('leaves malformed or missing metrics unavailable', async () => {
    const readTextFile = vi.fn(async (path: string) =>
      path.endsWith('/smaps_rollup') ? 'Pss: unknown\n' : 'Name:\tchromium\n',
    );

    await expect(readLinuxProcessMemory(202, readTextFile)).resolves.toEqual({
      pssMB: null,
      rssMB: null,
      pssSource: 'unavailable',
      rssSource: 'unavailable',
      errors: [
        'smaps_rollup: missing Pss',
        'smaps_rollup: missing Rss',
        'status: missing VmRSS',
      ],
    });
  });

  it('does not let one readable process mask a missing renderer PSS', () => {
    const complete: ProcessMemoryReading = {
      pssMB: 10,
      rssMB: 20,
      pssSource: 'smaps_rollup',
      rssSource: 'smaps_rollup',
      errors: [],
    };
    const rssOnly: ProcessMemoryReading = {
      pssMB: null,
      rssMB: 100,
      pssSource: 'unavailable',
      rssSource: 'status',
      errors: ['smaps_rollup: read failed'],
    };

    expect(
      summarizeProcessMemory([
        { id: 1, type: 'browser', memory: complete },
        { id: 2, type: 'renderer', memory: rssOnly },
      ]),
    ).toEqual({
      pssMB: null,
      rssMB: 120,
      processCount: 2,
      pssProcessCount: 1,
      rssProcessCount: 2,
      sources: {
        pss: { smaps_rollup: 1, status: 0, unavailable: 1 },
        rss: { smaps_rollup: 1, status: 1, unavailable: 0 },
      },
      byType: {
        browser: {
          count: 1,
          pssMB: 10,
          rssMB: 20,
          pssProcessCount: 1,
          rssProcessCount: 1,
        },
        renderer: {
          count: 1,
          pssMB: null,
          rssMB: 100,
          pssProcessCount: 0,
          rssProcessCount: 1,
        },
      },
      missing: [
        {
          id: 2,
          type: 'renderer',
          pssSource: 'unavailable',
          rssSource: 'status',
          errors: ['smaps_rollup: read failed'],
        },
      ],
    });
  });
});
