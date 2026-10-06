// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { ProgressState } from '@hooks/conversion-handlers/use-progress-state';
import { outputFrames, setOutputFrames } from '@stores/conversion-store';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('ProgressState', () => {
  afterEach(() => setOutputFrames(undefined));

  it('records a real conversion phase and output count even while overall progress is zero', () => {
    const setConversionPhase = vi.fn();
    const state = new ProgressState({
      setConversionStartTime: vi.fn(),
      setEstimatedSecondsRemaining: vi.fn(),
      setMemoryWarning: vi.fn(),
      setMemoryUsageText: vi.fn(),
      setConversionPhase,
    });

    state.updateProgress(0, 'encoding', 4);

    expect(setConversionPhase).toHaveBeenCalledWith('encoding');
    expect(outputFrames()).toBe(4);
    expect(state.lastProgressValue).toBe(0);
    state.resetProgressState();
  });
});
