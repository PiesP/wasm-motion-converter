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

import * as conversionModule from '@hooks/conversion-handlers/use-perform-conversion';

const { handleConvert } = conversionModule;

const localizedProgressT = ((key: string, params?: Record<string, string | number>) => {
  const translations: Record<string, string> = {
    'progress.preparing': '준비 중',
    'progress.decoding': '디코딩 중',
    'progress.encoding': '인코딩 중',
    'progress.finalizing': '마무리 중',
    'progress.frameCounter': '프레임 {current}/{total}',
    'progress.statusFrame': '{frame} — {phase}',
    'progress.statusFrameFps': '{frame} — {phase} @ 초당 {fps}프레임',
  };
  let value = translations[key] ?? key;
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replace(`{${name}}`, String(replacement));
  }
  return value;
}) as Parameters<typeof handleConvert>[1];

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

describe('localized conversion progress status', () => {
  const formatConversionProgressStatus = (
    conversionModule as unknown as {
      formatConversionProgressStatus?: (
        progress: {
          phase: 'demuxing' | 'decoding' | 'encoding' | 'assembling';
          currentFrame?: number;
          totalFrames?: number;
          fps: number;
        },
        t: typeof localizedProgressT
      ) => string;
    }
  ).formatConversionProgressStatus;

  it('uses translated frame, phase, and fps text', () => {
    expect(formatConversionProgressStatus).toBeTypeOf('function');
    expect(
      formatConversionProgressStatus?.(
        { phase: 'decoding', currentFrame: 4, totalFrames: 20, fps: 30 },
        localizedProgressT
      )
    ).toBe('프레임 4/20 — 디코딩 중 @ 초당 30프레임');
  });

  it('uses only the translated phase when frame progress is unavailable', () => {
    expect(
      formatConversionProgressStatus?.(
        { phase: 'assembling', currentFrame: 0, totalFrames: 20, fps: 0 },
        localizedProgressT
      )
    ).toBe('마무리 중');
  });
});
