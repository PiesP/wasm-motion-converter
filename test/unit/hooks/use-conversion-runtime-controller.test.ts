// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { ConversionRuntimeController } from '@hooks/conversion-handlers/use-conversion-runtime-controller';
import { describe, expect, it, vi } from 'vitest';

function createController(): ConversionRuntimeController {
  return new ConversionRuntimeController({
    setConversionStartTime: vi.fn(),
    setEstimatedSecondsRemaining: vi.fn(),
    setMemoryWarning: vi.fn(),
    setMemoryUsageText: vi.fn(),
  });
}

describe('ConversionRuntimeController preparation intent', () => {
  it('admits only one preparation intent at a time', () => {
    const controller = createController();

    const first = controller.beginConversionIntent();

    expect(first).not.toBeNull();
    expect(controller.beginConversionIntent()).toBeNull();
  });

  it('aborts and invalidates the active intent on cancellation', () => {
    const controller = createController();
    const intent = controller.beginConversionIntent();

    controller.abortConversionIntent();

    expect(intent?.signal.aborted).toBe(true);
    expect(intent?.isActive()).toBe(false);
  });

  it('aborts and invalidates the active intent on disposal', () => {
    const controller = createController();
    const intent = controller.beginConversionIntent();

    controller.dispose();

    expect(intent?.signal.aborted).toBe(true);
    expect(intent?.isActive()).toBe(false);
  });
});
