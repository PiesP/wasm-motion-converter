// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createPresentationSampler } from '@services/presentation-timing';

describe('presentation timestamp sampling', () => {
  it.each([24, 29.97, 30, 59.94, 60, 120])(
    'selects twenty presentation slots in one second of %s fps input',
    (sourceFps) => {
      const shouldSelect = createPresentationSampler(sourceFps, sourceFps / 20);
      const selected: number[] = [];
      for (let frame = 0; frame < Math.round(sourceFps); frame++) {
        const startUs = Math.round((frame * 1_000_000) / sourceFps);
        if (shouldSelect(startUs, frame)) selected.push(frame);
      }
      expect(selected).toHaveLength(20);
      expect(selected[0]).toBe(0);
      expect(Math.round((selected.at(-1)! * 1_000_000) / sourceFps)).toBeGreaterThanOrEqual(
        950_000
      );
    }
  );

  it('samples 30 fps into 20 and 18 fps without rounding ratios to two', () => {
    const source = Array.from({ length: 30 }, (_, index) => Math.round((index * 1_000_000) / 30));
    const select20 = createPresentationSampler(30, 30 / 20);
    const select18 = createPresentationSampler(30, 30 / 18);
    const selected20 = source.flatMap((startUs, index) => (select20(startUs, index) ? [index] : []));
    const selected18 = source.flatMap((startUs, index) => (select18(startUs, index) ? [index] : []));
    expect(selected20).toHaveLength(20);
    expect(selected18).toHaveLength(18);
    expect(selected20.slice(0, 6)).toEqual([0, 2, 3, 5, 6, 8]);
    expect(selected18.slice(0, 6)).toEqual([0, 2, 4, 5, 7, 9]);
  });

  it('retains the first available frame after each VFR boundary without catch-up bursts', () => {
    const select = createPresentationSampler(30, 30 / 20);
    const startsMs = [0, 20, 40, 120, 130, 210];
    const selected = startsMs.filter((startMs, frame) => select(startMs * 1000, frame));
    expect(selected).toEqual([0, 120, 210]);
  });

  it('does not impose an integer frame gap on a fractional VFR cadence', () => {
    const select = createPresentationSampler(10, 2.5);
    const startsMs = [0, 300, 320, 600];
    const selected = startsMs.filter((startMs, frame) => select(startMs * 1000, frame));
    expect(selected).toEqual([0, 300, 600]);
  });

  it('enforces an explicit integer frame floor with dense presentation timestamps', () => {
    const select = createPresentationSampler(30, 2);
    const startsUs = [0, 70_000, 70_001, 70_002];
    expect(startsUs.flatMap((startUs, frame) => (select(startUs, frame) ? [frame] : []))).toEqual([
      0, 2,
    ]);
  });
});
