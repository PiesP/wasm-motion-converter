// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { isPlayCount, parseCustomPlayCount, resolvePlayCount, toGifRepeat } from '@utils/playback-count';
import { describe, expect, it } from 'vite-plus/test';

describe('playback count', () => {
  it.each([0, 1, 2, 3, 10, 65535])('accepts %i', (count) => {
    expect(isPlayCount(count)).toBe(true);
    expect(resolvePlayCount(count)).toBe(count);
    expect(toGifRepeat(count)).toBe(count === 1 ? null : count === 0 ? 0 : count - 1);
  });

  it.each([-1, 1.5, 65536, NaN, Infinity, null, '3'])('rejects %s', (value) => {
    expect(isPlayCount(value)).toBe(false);
    expect(() => resolvePlayCount(value)).toThrow(RangeError);
  });

  it('defaults omitted values to forever', () => {
    expect(resolvePlayCount()).toBe(0);
  });

  it.each(['', '0', '1', '-2', '1.5', '1e2', '65536', 'NaN'])(
    'rejects custom draft %s',
    (draft) => {
      expect(parseCustomPlayCount(draft)).toBeUndefined();
    }
  );

  it.each(['2', '3', '65535'])('accepts custom draft %s', (draft) => {
    expect(parseCustomPlayCount(draft)).toBe(Number(draft));
  });
});
