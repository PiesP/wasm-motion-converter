// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  confirmation: undefined as
    | { onCancel: () => void; onConfirm: () => void }
    | undefined,
  runPipelineWithFallback: vi.fn(),
  showConfirmation: vi.fn(),
  validateVideoDuration: vi.fn(),
}));

vi.mock('@stores/conversion-settings-store', () => ({
  conversionSettings: () => ({
    format: 'gif',
    quality: 'medium',
    scale: 1,
    smartFrameSkip: 'off',
    trimEnd: 0,
    trimStart: 0,
  }),
}));

vi.mock('@stores/conversion-store', () => ({
  appState: () => 'idle',
  getInputBuffer: () => new ArrayBuffer(8),
  inputFile: () => new File(['video'], 'video.mp4', { type: 'video/mp4' }),
  setAppState: vi.fn(),
  setConversionElapsedMs: vi.fn(),
  setConversionFps: vi.fn(),
  setConversionProgress: vi.fn(),
  setConversionResults: vi.fn(),
  setConversionStatusMessage: vi.fn(),
  setCurrentFrame: vi.fn(),
  setErrorContext: vi.fn(),
  setErrorMessage: vi.fn(),
  setInputBuffer: vi.fn(),
  setInputFile: vi.fn(),
  setOutputFrames: vi.fn(),
  setTotalFrames: vi.fn(),
  setVideoMetadata: vi.fn(),
  setVideoPreviewUrl: vi.fn(),
  transitionToState: vi.fn(),
  videoMetadata: () => ({
    config: { codec: 'vp09.00.10.08', codedHeight: 16, codedWidth: 16 },
    duration: 1,
    framerate: 30,
  }),
  videoPreviewUrl: vi.fn(),
}));

vi.mock('@stores/confirmation-store', () => ({
  showConfirmation: (warnings: unknown, onConfirm: () => void, onCancel: () => void) => {
    mocks.confirmation = { onCancel, onConfirm };
    mocks.showConfirmation(warnings, onConfirm, onCancel);
  },
}));
vi.mock('@services/conversion-worker/main-thread-proxy', () => ({
  runPipelineWithFallback: mocks.runPipelineWithFallback,
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
import { ConversionRuntimeController } from '@hooks/conversion-handlers/use-conversion-runtime-controller';

const { handleCancelConversion, handleConvert } = conversionModule;

function createRuntime(): ConversionRuntimeController {
  return new ConversionRuntimeController({
    setConversionStartTime: vi.fn(),
    setEstimatedSecondsRemaining: vi.fn(),
    setMemoryWarning: vi.fn(),
    setMemoryUsageText: vi.fn(),
  });
}

beforeEach(() => {
  mocks.confirmation = undefined;
  mocks.runPipelineWithFallback.mockReset().mockResolvedValue(
    new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]).buffer
  );
  mocks.showConfirmation.mockClear();
  mocks.validateVideoDuration.mockReset();
});

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
    const runtime = createRuntime();
    const t = ((key: string) => key) as Parameters<typeof handleConvert>[1];

    const first = handleConvert(runtime, t);
    const second = handleConvert(runtime, t);

    expect(mocks.validateVideoDuration).toHaveBeenCalledTimes(1);

    resolveValidation?.({ duration: 1_000, warnings: [] });
    await Promise.all([first, second]);

    expect(mocks.runPipelineWithFallback).toHaveBeenCalledTimes(1);
  });

  it('does not start a pipeline after cancellation during duration validation', async () => {
    let resolveValidation: ((value: unknown) => void) | undefined;
    mocks.validateVideoDuration.mockReturnValue(
      new Promise((resolve) => {
        resolveValidation = resolve;
      })
    );
    const runtime = createRuntime();
    const t = ((key: string) => key) as Parameters<typeof handleConvert>[1];

    const conversion = handleConvert(runtime, t);
    handleCancelConversion(runtime);
    resolveValidation?.({ duration: 1_000, warnings: [] });
    await conversion;

    expect(mocks.runPipelineWithFallback).not.toHaveBeenCalled();
  });

  it('does not start a pipeline after disposal during duration validation', async () => {
    let resolveValidation: ((value: unknown) => void) | undefined;
    mocks.validateVideoDuration.mockReturnValue(
      new Promise((resolve) => {
        resolveValidation = resolve;
      })
    );
    const runtime = createRuntime();
    const t = ((key: string) => key) as Parameters<typeof handleConvert>[1];

    const conversion = handleConvert(runtime, t);
    runtime.dispose();
    resolveValidation?.({ duration: 1_000, warnings: [] });
    await conversion;

    expect(mocks.runPipelineWithFallback).not.toHaveBeenCalled();
  });

  it('settles without starting a confirmed pipeline after disposal', async () => {
    mocks.validateVideoDuration.mockResolvedValue({
      duration: 1_000,
      warnings: [{ message: 'confirm', requiresConfirmation: true }],
    });
    const runtime = createRuntime();
    const t = ((key: string) => key) as Parameters<typeof handleConvert>[1];

    const conversion = handleConvert(runtime, t);
    await vi.waitFor(() => expect(mocks.confirmation).toBeDefined());
    runtime.dispose();
    await conversion;

    expect(mocks.runPipelineWithFallback).not.toHaveBeenCalled();
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
