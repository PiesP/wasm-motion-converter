// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  validateVideoDuration: vi.fn(),
}));

vi.mock('@stores/conversion-settings-store', () => ({
  conversionSettings: () => ({
    format: 'gif',
    quality: 'medium',
    scale: 1,
    smartFrameSkip: 'off',
  }),
}));

vi.mock('@stores/conversion-store', () => ({
  appState: () => 'idle',
  getInputBuffer: vi.fn(),
  inputFile: () => new File(['video'], 'video.mp4', { type: 'video/mp4' }),
  setAppState: vi.fn(),
  setConversionElapsedMs: vi.fn(),
  setConversionFps: vi.fn(),
  setConversionResults: vi.fn(),
  setConversionStatusMessage: vi.fn(),
  setCurrentFrame: vi.fn(),
  setErrorContext: vi.fn(),
  setErrorMessage: vi.fn(),
  setInputBuffer: vi.fn(),
  setInputFile: vi.fn(),
  setTotalFrames: vi.fn(),
  setVideoMetadata: vi.fn(),
  setVideoPreviewUrl: vi.fn(),
  transitionToState: vi.fn(),
  videoMetadata: () => ({ framerate: 30 }),
  videoPreviewUrl: vi.fn(),
}));

vi.mock('@stores/confirmation-store', () => ({
  showConfirmation: (
    _warnings: unknown,
    _onConfirm: () => void,
    onCancel: () => void
  ) => onCancel(),
}));
vi.mock('@utils/file-validation', () => ({
  validateVideoDuration: mocks.validateVideoDuration,
}));
vi.mock('@utils/dom-utils', () => ({
  focusElement: vi.fn(),
  focusRetryButton: vi.fn(),
  getStartViewTransition: () => undefined,
}));

import { handleConvert } from '@hooks/conversion-handlers/use-perform-conversion';

describe('handleConvert conversion ownership', () => {
  it('admits only one request while duration validation is pending', async () => {
    let resolveValidation: ((value: unknown) => void) | undefined;
    mocks.validateVideoDuration.mockReturnValue(
      new Promise((resolve) => {
        resolveValidation = resolve;
      })
    );
    const runtime = {} as Parameters<typeof handleConvert>[0];
    const t = ((key: string) => key) as Parameters<typeof handleConvert>[1];

    const first = handleConvert(runtime, t);
    const second = handleConvert(runtime, t);

    expect(mocks.validateVideoDuration).toHaveBeenCalledTimes(1);

    resolveValidation?.({
      duration: 1_000,
      warnings: [{ message: 'confirm', requiresConfirmation: true }],
    });
    await Promise.all([first, second]);
  });
});
