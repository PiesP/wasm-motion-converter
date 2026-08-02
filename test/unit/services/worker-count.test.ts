// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { calculateOptimalWorkerCount } from '@services/worker-pool';
import { describe, expect, it } from 'vitest';

describe('WebP worker count policy', () => {
  it.each([
    [undefined, undefined, undefined, 1],
    [{}, undefined, undefined, 2],
    [{ hardwareConcurrency: 1 }, undefined, undefined, 1],
    [{ hardwareConcurrency: 8 }, undefined, undefined, 4],
    [{ hardwareConcurrency: 8, deviceMemory: 4 }, undefined, undefined, 2],
    [{ hardwareConcurrency: 8, deviceMemory: 8 }, undefined, undefined, 4],
    [{ hardwareConcurrency: 8 }, 3840, 2160, 2],
  ] as const)(
    'returns %s capabilities at %sx%s as %s workers',
    (capabilities, width, height, expected) => {
      expect(calculateOptimalWorkerCount(capabilities, width, height)).toBe(expected);
    }
  );

  it('does not apply resolution caps without browser capabilities', () => {
    expect(calculateOptimalWorkerCount(undefined, 3840, 2160)).toBe(1);
  });
});
