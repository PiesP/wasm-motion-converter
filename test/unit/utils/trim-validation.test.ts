// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import {
  clampToStep,
  formatTimePrecise,
  isFullDuration,
  parseTimeInput,
} from '@utils/trim-time';
import { describe, expect, it } from 'vitest';

describe('trim time helpers', () => {
  it('recognizes only the full-duration sentinel', () => {
    expect(isFullDuration(0)).toBe(true);
    expect(isFullDuration(5)).toBe(false);
    expect(isFullDuration(-1)).toBe(false);
    expect(isFullDuration(0.1)).toBe(false);
  });

  it.each([
    [1.05, 1.1],
    [1.04, 1],
    [0, 0],
    [-0.04, 0],
    [0.25, 0.3],
    [0.45, 0.5],
  ])('rounds %s to the nearest tenth', (value, expected) => {
    expect(clampToStep(value)).toBe(expected);
  });

  it.each([
    [0, '0:00.0'],
    [5.5, '0:05.5'],
    [65.3, '1:05.3'],
    [3661.2, '1:01:01.2'],
    [-1, '0:00.0'],
  ])('formats %s seconds precisely', (seconds, expected) => {
    expect(formatTimePrecise(seconds)).toBe(expected);
  });

  it.each([
    ['1:30', 90],
    ['0:05.25', 5.25],
    ['1:00:00', 3600],
    ['2:30:00.5', 9000.5],
    ['90.5', 90.5],
    ['  1:30  ', 90],
  ])('parses %j as %s seconds', (input, expected) => {
    expect(parseTimeInput(input)).toBe(expected);
  });

  it.each(['', '   ', 'abc', '1:', ':30', '1:2:', '1:2:3:4', 'a:30', '1:b', 'a:b:c'])(
    'rejects invalid input %j',
    (input) => {
      expect(parseTimeInput(input)).toBeNull();
    }
  );
});
