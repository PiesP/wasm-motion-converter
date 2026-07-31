// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('@utils/logger', () => ({ logger }));

import { createDynamicDecimationController } from '@services/dynamic-decimation-controller';

describe('createDynamicDecimationController', () => {
  beforeEach(() => {
    logger.info.mockReset();
    logger.warn.mockReset();
  });

  it('checks memory only on frame multiples of five and skips nothing below threshold', () => {
    const check = vi.fn(() => ({ usagePercentage: 50 }));
    const controller = createDynamicDecimationController(check);

    expect(controller.shouldSkip(1)).toBe(false);
    expect(controller.shouldSkip(5)).toBe(false);
    expect(controller.shouldSkip(6)).toBe(false);
    expect(controller.shouldSkip(10)).toBe(false);
    expect(check).toHaveBeenCalledTimes(2);
    expect(controller.getSkipCount()).toBe(0);
  });

  it('samples every five frames and then skips every other frame under critical pressure', () => {
    const controller = createDynamicDecimationController(() => ({ usagePercentage: 90 }));

    expect(controller.shouldSkip(5)).toBe(true);
    expect(controller.shouldSkip(6)).toBe(false);
    expect(controller.shouldSkip(7)).toBe(true);
    expect(controller.shouldSkip(8)).toBe(false);
    expect(controller.shouldSkip(9)).toBe(true);
    expect(controller.shouldSkip(10)).toBe(false);
    expect(controller.getSkipCount()).toBe(3);
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('always keeps the first frame when memory is already critical', () => {
    const controller = createDynamicDecimationController(() => ({ usagePercentage: 90 }));

    expect(controller.shouldSkip(0)).toBe(false);
    expect(controller.shouldSkip(1)).toBe(true);
  });

  it('starts sustained-pressure skipping after three warnings', () => {
    const controller = createDynamicDecimationController(() => ({ usagePercentage: 80 }));

    expect(controller.shouldSkip(5)).toBe(false);
    expect(controller.shouldSkip(6)).toBe(false);
    expect(controller.shouldSkip(10)).toBe(false);
    expect(controller.shouldSkip(15)).toBe(true);
    expect(controller.shouldSkip(16)).toBe(false);
    expect(controller.shouldSkip(17)).toBe(false);
    expect(controller.shouldSkip(18)).toBe(true);
    expect(controller.getSkipCount()).toBe(2);
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it('resets warning streak when memory becomes unavailable or safe', () => {
    const check = vi
      .fn<() => { usagePercentage: number } | null>()
      .mockReturnValueOnce({ usagePercentage: 80 })
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ usagePercentage: 80 })
      .mockReturnValueOnce({ usagePercentage: 80 });
    const controller = createDynamicDecimationController(check);

    expect(controller.shouldSkip(5)).toBe(false);
    expect(controller.shouldSkip(10)).toBe(false);
    expect(controller.shouldSkip(15)).toBe(false);
    expect(controller.shouldSkip(20)).toBe(false);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
