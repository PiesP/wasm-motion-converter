// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  confirmation: undefined as
    | { onCancel: () => void; onConfirm: () => void }
    | undefined,
  runPipelineWithFallback: vi.fn(),
  runConversionPipeline: vi.fn(),
  setInputBuffer: vi.fn(),
  setInputFile: vi.fn(),
  setConversionResults: vi.fn(),
  setErrorMessage: vi.fn(),
  setVideoMetadata: vi.fn(),
  setVideoPreviewUrl: vi.fn(),
  showConfirmation: vi.fn(),
  transitionToState: vi.fn(),
  validateVideoDuration: vi.fn(),
  settings: {
    format: 'gif' as const,
    quality: 'medium' as const,
    scale: 1 as const,
    smartFrameSkip: 'off' as const,
    trimEnd: 0,
    trimStart: 0,
  },
}));

vi.mock('@stores/conversion-settings-store', () => ({
  conversionSettings: () => mocks.settings,
}));

vi.mock('@stores/conversion-store', () => ({
  appState: () => 'idle',
  getInputBuffer: () => new ArrayBuffer(8),
  inputFile: () => new File(['video'], 'video.mp4', { type: 'video/mp4' }),
  setAppState: vi.fn(),
  setConversionElapsedMs: vi.fn(),
  setConversionFps: vi.fn(),
  setConversionProgress: vi.fn(),
  setConversionResults: mocks.setConversionResults,
  setConversionStatusMessage: vi.fn(),
  setCurrentFrame: vi.fn(),
  setErrorContext: vi.fn(),
  setErrorMessage: mocks.setErrorMessage,
  setInputBuffer: mocks.setInputBuffer,
  setInputFile: mocks.setInputFile,
  setOutputFrames: vi.fn(),
  setTotalFrames: vi.fn(),
  setVideoMetadata: mocks.setVideoMetadata,
  setVideoPreviewUrl: mocks.setVideoPreviewUrl,
  transitionToState: mocks.transitionToState,
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
vi.mock('@services/conversion-pipeline', () => ({
  runConversionPipeline: mocks.runConversionPipeline,
}));
vi.mock('@utils/file-validation', () => ({
  validateVideoDuration: mocks.validateVideoDuration,
}));
vi.mock('@utils/dom-utils', () => ({
  focusElement: vi.fn(),
  focusRetryButton: vi.fn(),
}));

import * as conversionModule from '@hooks/conversion-handlers/use-perform-conversion';
import { ConversionRuntimeController } from '@hooks/conversion-handlers/use-conversion-runtime-controller';

const { handleCancelConversion, handleConvert, handleDismissError } = conversionModule;

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
  mocks.runConversionPipeline.mockReset().mockResolvedValue(
    new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).buffer
  );
  mocks.setInputBuffer.mockClear();
  mocks.setInputFile.mockClear();
  mocks.setConversionResults.mockClear();
  mocks.setErrorMessage.mockClear();
  mocks.setVideoMetadata.mockClear();
  mocks.setVideoPreviewUrl.mockClear();
  mocks.showConfirmation.mockClear();
  mocks.transitionToState.mockClear();
  mocks.validateVideoDuration.mockReset();
  mocks.settings = {
    format: 'gif',
    quality: 'medium',
    scale: 1,
    smartFrameSkip: 'off',
    trimEnd: 0,
    trimStart: 0,
  };
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

  it('uses the settings snapshot captured before asynchronous validation', async () => {
    let resolveValidation: ((value: unknown) => void) | undefined;
    mocks.validateVideoDuration.mockReturnValue(
      new Promise((resolve) => {
        resolveValidation = resolve;
      })
    );
    const runtime = createRuntime();
    const t = ((key: string) => key) as Parameters<typeof handleConvert>[1];

    const conversion = handleConvert(runtime, t);
    mocks.settings = {
      format: 'gif',
      quality: 'high',
      scale: 0.5,
      smartFrameSkip: 'high',
      trimStart: 0.25,
      trimEnd: 0.75,
    };
    resolveValidation?.({ duration: 1_000, warnings: [] });
    await conversion;

    expect(mocks.runPipelineWithFallback).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      expect.any(Object),
      expect.objectContaining({
        format: 'gif',
        quality: 'medium',
        scale: 1,
        smartFrameSkip: 'off',
        trimStart: 0,
        trimEnd: 0,
      }),
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(File),
      expect.anything(),
      expect.anything()
    );
  });

  it('uses the input Blob without creating or retaining an ArrayBuffer for WebP', async () => {
    mocks.settings = { ...mocks.settings, format: 'webp' };
    mocks.validateVideoDuration.mockResolvedValue({ duration: 1_000, warnings: [] });
    const runtime = createRuntime();

    await handleConvert(runtime, ((key: string) => key) as Parameters<typeof handleConvert>[1]);

    expect(mocks.runPipelineWithFallback).not.toHaveBeenCalled();
    expect(mocks.runConversionPipeline).toHaveBeenCalledWith(
      expect.not.objectContaining({ inputBuffer: expect.anything() }),
      expect.any(Function),
      expect.any(AbortSignal)
    );
    expect(mocks.runConversionPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ inputBlob: expect.any(File), format: 'webp' }),
      expect.any(Function),
      expect.any(AbortSignal)
    );
  });

  it.each([
    ['gif', new Uint8Array([0x50, 0x4e, 0x47, 0x00]).buffer],
    ['webp', new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x50, 0x4e, 0x47, 0x00]).buffer],
  ] as const)('rejects invalid %s output before publishing a result', async (format, output) => {
    mocks.settings = { ...mocks.settings, format };
    mocks.validateVideoDuration.mockResolvedValue({ duration: 1_000, warnings: [] });
    const pipeline = format === 'gif' ? mocks.runPipelineWithFallback : mocks.runConversionPipeline;
    pipeline.mockResolvedValueOnce(output);

    await handleConvert(createRuntime(), ((key: string) => key) as Parameters<typeof handleConvert>[1]);

    expect(mocks.setErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('invalid output header')
    );
    expect(mocks.transitionToState).toHaveBeenLastCalledWith('error');
    expect(mocks.setConversionResults).not.toHaveBeenCalledWith([
      expect.objectContaining({ outputBlob: expect.any(Blob) }),
    ]);
  });
});

describe('handleDismissError resource cleanup', () => {
  it('releases the input buffer and metadata when the error is dismissed', () => {
    handleDismissError();

    expect(mocks.setInputBuffer).toHaveBeenCalledWith(null);
    expect(mocks.setVideoMetadata).toHaveBeenCalledWith(null);
    expect(mocks.setInputFile).toHaveBeenCalledWith(null);
    expect(mocks.setVideoPreviewUrl).toHaveBeenCalledWith(null);
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
