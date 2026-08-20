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
  it('aborts and invalidates active file analysis', () => {
    const controller = createController();
    const analysis = controller.startNewRun();
    expect(analysis).not.toBeNull();

    controller.invalidateActiveConversions();

    expect(analysis?.signal.aborted).toBe(true);
    expect(analysis?.isActive()).toBe(false);
  });

  it('finishes an analysis run without aborting its completed signal', () => {
    const controller = createController();
    const analysis = controller.startNewRun();
    if (!analysis) throw new Error('analysis run should start');

    controller.finishAnalysisRun(analysis);

    expect(analysis.signal.aborted).toBe(false);
    expect(analysis.isActive()).toBe(false);
  });

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
    expect(controller.beginConversionIntent()).toBeNull();

    if (intent) controller.finishConversionIntent(intent);
    expect(controller.beginConversionIntent()).not.toBeNull();
  });

  it('blocks a new analysis until cancelled conversion teardown finishes', () => {
    const controller = createController();
    const intent = controller.beginConversionIntent();

    controller.abortConversionIntent();
    expect(controller.startNewRun()).toBeNull();

    if (intent) controller.finishConversionIntent(intent);
    expect(controller.startNewRun()).not.toBeNull();
  });

  it('aborts and invalidates the active intent on disposal', () => {
    const controller = createController();
    const intent = controller.beginConversionIntent();

    controller.dispose();

    expect(intent?.signal.aborted).toBe(true);
    expect(intent?.isActive()).toBe(false);
  });
});
