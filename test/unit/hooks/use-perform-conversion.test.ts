// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { ConversionSettings, ProgressPhase, VideoMetadata } from '@t/conversion-types';
import { createComputed, createRoot, createSignal } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  confirmation: undefined as { onCancel: () => void; onConfirm: () => void } | undefined,
  appState: 'idle' as 'idle' | 'cancelling' | 'error',
  focusElementUnlessUserIsEditing: vi.fn(),
  selectedFile: null as File | null,
  selectGifPartDirectory: vi.fn(),
  createGifPartFileSink: vi.fn(),
  createGifPartOpfsSink: vi.fn(),
  runGifPartsViaWorker: vi.fn(),
  runPipelineWithFallback: vi.fn(),
  runConversionPipeline: vi.fn(),
  setConversionProgress: vi.fn(),
  setInputFile: vi.fn(),
  setConversionResults: vi.fn(),
  setConversionStatusMessage: vi.fn(),
  setCurrentFrame: vi.fn(),
  setErrorMessage: vi.fn(),
  setErrorContext: vi.fn(),
  setOutputFrames: vi.fn(),
  setTotalFrames: vi.fn(),
  setAppState: vi.fn((state: 'idle' | 'cancelling' | 'error') => {
    mocks.appState = state;
  }),
  setVideoMetadata: vi.fn(),
  setVideoPreviewUrl: vi.fn(),
  showConfirmation: vi.fn(),
  transitionToState: vi.fn(),
  validateVideoDuration: vi.fn(),
  readWholeFile: vi.fn(),
  metadata: {
    config: { codec: 'vp09.00.10.08', codedHeight: 16, codedWidth: 16 },
    duration: 1,
    framerate: 30,
  } as VideoMetadata,
  settings: {
    format: 'gif' as ConversionSettings['format'],
    quality: 'medium' as ConversionSettings['quality'],
    scale: 1 as ConversionSettings['scale'],
    smartFrameSkip: 'off' as ConversionSettings['smartFrameSkip'],
    trimEnd: 0,
    trimStart: 0,
  },
}));

vi.mock('@stores/conversion-settings-store', () => ({
  conversionSettings: () => mocks.settings,
}));

vi.mock('@stores/conversion-store', () => ({
  appState: () => mocks.appState,
  inputFile: () => mocks.selectedFile,
  setAppState: mocks.setAppState,
  setConversionProgress: mocks.setConversionProgress,
  setConversionResults: mocks.setConversionResults,
  setConversionStatusMessage: mocks.setConversionStatusMessage,
  setCurrentFrame: mocks.setCurrentFrame,
  setErrorContext: mocks.setErrorContext,
  setErrorMessage: mocks.setErrorMessage,
  setInputFile: mocks.setInputFile,
  setOutputFrames: mocks.setOutputFrames,
  setTotalFrames: mocks.setTotalFrames,
  setVideoMetadata: mocks.setVideoMetadata,
  setVideoPreviewUrl: mocks.setVideoPreviewUrl,
  transitionToState: mocks.transitionToState,
  videoMetadata: () => mocks.metadata,
  videoPreviewUrl: vi.fn(),
}));

vi.mock('@stores/confirmation-store', () => ({
  showConfirmation: (warnings: unknown, onConfirm: () => void, onCancel: () => void) => {
    mocks.confirmation = { onCancel, onConfirm };
    mocks.showConfirmation(warnings, onConfirm, onCancel);
  },
}));
vi.mock('@services/conversion-worker/main-thread-proxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@services/conversion-worker/main-thread-proxy')>()),
  runPipelineWithFallback: mocks.runPipelineWithFallback,
  runGifPartsViaWorker: mocks.runGifPartsViaWorker,
}));
vi.mock('@services/gif-part-file-sink', () => ({
  createGifPartFileSink: mocks.createGifPartFileSink,
  selectGifPartDirectory: mocks.selectGifPartDirectory,
}));
vi.mock('@services/gif-part-opfs-sink', () => ({
  createGifPartOpfsSink: mocks.createGifPartOpfsSink,
}));
vi.mock('@services/conversion-pipeline', () => ({
  runConversionPipeline: mocks.runConversionPipeline,
}));
vi.mock('@utils/file-validation', () => ({
  validateVideoDuration: mocks.validateVideoDuration,
}));
vi.mock('@utils/dom-utils', () => ({
  focusElementUnlessUserIsEditing: mocks.focusElementUnlessUserIsEditing,
  focusPrimaryErrorAction: vi.fn(),
}));

import { ConversionRuntimeController } from '@hooks/conversion-handlers/use-conversion-runtime-controller';
import * as conversionModule from '@hooks/conversion-handlers/use-perform-conversion';
import { ConversionMemoryLimitError } from '@services/conversion-memory-limit-error';
import {
  WorkerMemoryLimitError,
  WorkerPipelineError,
  WorkerTimeoutError,
} from '@services/conversion-worker/main-thread-proxy';
import { GifStagedOutputLimitError } from '@services/gif-staged-output-limit-error';
import {
  OwnedVp8AbiError,
  OwnedVp8InitializationAbiError,
  OwnedVp8InvalidInputError,
  OwnedVp8LoadError,
  OwnedVp8MemoryAdmissionError,
  OwnedVp8TrapError,
} from '@services/owned-vp8-errors';

const { handleCancelConversion, handleConvert, handleDismissError, handleRetry } = conversionModule;

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
  mocks.appState = 'idle';
  mocks.focusElementUnlessUserIsEditing.mockReset();
  mocks.runPipelineWithFallback
    .mockReset()
    .mockResolvedValue(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]).buffer);
  mocks.runConversionPipeline
    .mockReset()
    .mockResolvedValue(
      new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).buffer
    );
  mocks.setConversionProgress.mockReset();
  mocks.readWholeFile.mockReset().mockRejectedValue(new Error('Full-file reads are forbidden'));
  mocks.selectedFile = new File(['video'], 'video.mp4', { type: 'video/mp4' });
  Object.defineProperty(mocks.selectedFile, 'arrayBuffer', { value: mocks.readWholeFile });
  mocks.selectGifPartDirectory.mockReset();
  mocks.createGifPartFileSink.mockReset();
  mocks.createGifPartOpfsSink.mockReset();
  mocks.runGifPartsViaWorker.mockReset();
  mocks.setInputFile.mockClear();
  mocks.setConversionResults.mockClear();
  mocks.setConversionStatusMessage.mockReset();
  mocks.setCurrentFrame.mockReset();
  mocks.setErrorMessage.mockClear();
  mocks.setErrorContext.mockClear();
  mocks.setOutputFrames.mockReset();
  mocks.setTotalFrames.mockReset();
  mocks.setAppState.mockClear();
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
  mocks.metadata = {
    config: { codec: 'vp09.00.10.08', codedHeight: 16, codedWidth: 16 },
    duration: 1,
    framerate: 30,
  } as VideoMetadata;
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

it.each([
  {
    outcome: 'memory guidance before the first part',
    workerError: new WorkerMemoryLimitError('Decoded frame dimensions exceed the per-frame limit'),
    count: 0,
    message: 'error.memory',
  },
  {
    outcome: 'destination guidance when saving fails',
    workerError: new DOMException('Destination full', 'QuotaExceededError'),
    count: 0,
    message: 'error.gifPartsSaveFailed',
  },
  {
    outcome: 'partial output after a later memory failure',
    workerError: new WorkerMemoryLimitError('Frame admission failed'),
    count: 1,
    message: 'result.gifPartsPartial',
  },
])('reports GIF parts $outcome', async ({ workerError, count, message }) => {
  const removeEmptyFolder = vi.fn();
  mocks.selectGifPartDirectory.mockResolvedValue({});
  mocks.createGifPartFileSink.mockReturnValue({
    count,
    folderName: 'owned',
    save: vi.fn(),
    finish: vi.fn(),
    removeEmptyFolder,
  });
  mocks.runGifPartsViaWorker.mockRejectedValue(workerError);
  const runtime = createRuntime();
  const report = vi.fn();

  try {
    await conversionModule.handleConvertGifParts(runtime, localizedProgressT, report);
    expect(removeEmptyFolder).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledExactlyOnceWith(message);
  } finally {
    runtime.dispose();
  }
});

it('reports completed GIF parts when the manifest close wins a racing Stop', async () => {
  const manifestClose = Promise.withResolvers<void>();
  const finish = vi.fn(() => manifestClose.promise);
  mocks.selectGifPartDirectory.mockResolvedValue({});
  mocks.createGifPartFileSink.mockReturnValue({
    count: 2,
    folderName: 'owned',
    save: vi.fn(),
    finish,
    removeEmptyFolder: vi.fn(),
  });
  mocks.runGifPartsViaWorker.mockResolvedValue({ partCount: 2, frameCount: 9001 });
  const runtime = createRuntime();
  const report = vi.fn();
  const conversion = conversionModule.handleConvertGifParts(runtime, localizedProgressT, report);
  await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
  try {
    handleCancelConversion(runtime);
    expect(mocks.appState).toBe('cancelling');
    expect(runtime.beginConversionIntent()).toBeNull();
    expect(report).not.toHaveBeenCalled();
  } finally {
    manifestClose.resolve();
    await conversion;
  }
  expect(report).toHaveBeenCalledWith('result.gifPartsSaved');
  expect(mocks.appState).toBe('idle');
  runtime.dispose();
});

it.each([
  {
    outcome: 'application staging limit',
    error: new GifStagedOutputLimitError(512),
    dispose: vi.fn().mockResolvedValue(undefined),
    message: 'error.gifContinuousOutputLimit',
  },
  {
    outcome: 'native quota failure',
    error: new DOMException('Origin quota exhausted', 'QuotaExceededError'),
    dispose: vi.fn().mockResolvedValue(undefined),
    message: 'error.gifPartsStorageFailed',
  },
  {
    outcome: 'storage cleanup failure after hitting the staging limit',
    error: new GifStagedOutputLimitError(512),
    dispose: vi.fn().mockRejectedValue(new DOMException('Removal failed', 'InvalidStateError')),
    message: 'error.gifPartsStorageFailed',
  },
])('reports the $outcome after discarding incomplete OPFS output', async (testCase) => {
  const storage = {
    count: 1,
    ready: false,
    save: vi.fn(),
    finish: vi.fn(),
    dispose: testCase.dispose,
  };
  mocks.createGifPartOpfsSink.mockResolvedValue(storage);
  mocks.runGifPartsViaWorker.mockRejectedValue(testCase.error);
  const runtime = createRuntime();
  const report = vi.fn();
  const t = vi.fn(localizedProgressT);
  const retain = vi.fn(() => true);

  try {
    await conversionModule.handleConvertGifParts(runtime, t, report, retain);
    expect(report).toHaveBeenCalledExactlyOnceWith(testCase.message);
    if (testCase.message === 'error.gifContinuousOutputLimit') {
      expect(t).toHaveBeenCalledWith(testCase.message, { limitMiB: 512 });
    }
    expect(storage.dispose).toHaveBeenCalledOnce();
    expect(storage.finish).not.toHaveBeenCalled();
    expect(retain).not.toHaveBeenCalled();
    expect(mocks.appState).toBe('idle');
  } finally {
    runtime.dispose();
  }
});

it('discards the incomplete OPFS result on Stop without opening a directory picker', async () => {
  const worker = Promise.withResolvers<never>();
  const storage = { count: 1, ready: false, save: vi.fn(), finish: vi.fn(), dispose: vi.fn() };
  mocks.createGifPartOpfsSink.mockResolvedValue(storage);
  mocks.runGifPartsViaWorker.mockReturnValue(worker.promise);
  const runtime = createRuntime();
  const report = vi.fn();
  const retain = vi.fn(() => true);
  const conversion = conversionModule.handleConvertGifParts(
    runtime,
    localizedProgressT,
    report,
    retain
  );
  try {
    await vi.waitFor(() => expect(mocks.runGifPartsViaWorker).toHaveBeenCalledOnce());
    handleCancelConversion(runtime);
  } finally {
    worker.reject(new DOMException('Cancelled', 'AbortError'));
    await conversion;
  }
  expect(retain).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
  expect(mocks.selectGifPartDirectory).not.toHaveBeenCalled();
  expect(storage.finish).not.toHaveBeenCalled();
  expect(storage.dispose).toHaveBeenCalledOnce();
  expect(mocks.appState).toBe('idle');
  runtime.dispose();
});

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

  it('keeps restart blocked until a cancelled WebP pipeline physically settles', async () => {
    mocks.settings = { ...mocks.settings, format: 'webp' };
    mocks.validateVideoDuration.mockResolvedValue({ duration: 1_000, warnings: [] });
    let resolvePipeline: ((output: ArrayBuffer) => void) | undefined;
    mocks.runConversionPipeline.mockReturnValueOnce(
      new Promise<ArrayBuffer>((resolve) => {
        resolvePipeline = resolve;
      })
    );
    const runtime = createRuntime();

    const first = handleConvert(runtime, localizedProgressT);
    await vi.waitFor(() => expect(mocks.runConversionPipeline).toHaveBeenCalledOnce());
    handleCancelConversion(runtime);
    const blockedRestart = handleConvert(runtime, localizedProgressT);

    expect(mocks.appState).toBe('cancelling');
    expect(mocks.runConversionPipeline).toHaveBeenCalledTimes(1);

    resolvePipeline?.(
      new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).buffer
    );
    await Promise.all([first, blockedRestart]);
    expect(mocks.appState).toBe('idle');
    expect(mocks.transitionToState).not.toHaveBeenCalledWith('done');
    expect(mocks.setConversionResults).not.toHaveBeenCalledWith([
      expect.objectContaining({ outputBlob: expect.any(Blob) }),
    ]);
    expect(mocks.focusElementUnlessUserIsEditing).toHaveBeenCalledWith(
      '[data-testid="convert-button"]'
    );

    await handleConvert(runtime, localizedProgressT);
    expect(mocks.runConversionPipeline).toHaveBeenCalledTimes(2);
  });

  it.each(['cancellation', 'new-file revision'] as const)(
    'discards a result invalidated by %s at the final rendering microtask',
    async (reason) => {
      mocks.settings = { ...mocks.settings, format: 'webp' };
      mocks.validateVideoDuration.mockResolvedValue({ duration: 1_000, warnings: [] });
      let resolvePipeline: ((output: ArrayBuffer) => void) | undefined;
      mocks.runConversionPipeline.mockReturnValueOnce(
        new Promise<ArrayBuffer>((resolve) => {
          resolvePipeline = resolve;
        })
      );
      const runtime = createRuntime();
      const conversion = handleConvert(runtime, localizedProgressT);
      await vi.waitFor(() => expect(mocks.runConversionPipeline).toHaveBeenCalledOnce());
      mocks.setConversionResults.mockClear();
      const stopMonitoring = runtime.stopMemoryMonitoring.bind(runtime);
      let invalidatedAtBoundary = false;
      const stop = vi.spyOn(runtime, 'stopMemoryMonitoring').mockImplementationOnce(() => {
        stopMonitoring();
        // handleResult has passed its first active-run check; this runs before
        // its explicit Promise continuation can publish the result.
        queueMicrotask(() => {
          invalidatedAtBoundary = true;
          if (reason === 'cancellation') handleCancelConversion(runtime);
          else runtime.invalidateActiveConversions();
        });
      });
      try {
        resolvePipeline?.(
          new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).buffer
        );
        await conversion;
        expect(invalidatedAtBoundary).toBe(true);
        expect(mocks.setConversionResults).not.toHaveBeenCalled();
        expect(mocks.transitionToState).not.toHaveBeenCalledWith('done');
        expect(mocks.focusElementUnlessUserIsEditing).not.toHaveBeenCalledWith(
          '[data-testid="download-result-button"]'
        );
      } finally {
        stop.mockRestore();
        runtime.dispose();
      }
    }
  );

  it('keeps the Stop outcome when an owned VP8 load later rejects', async () => {
    mocks.settings = { ...mocks.settings, format: 'webp' };
    mocks.validateVideoDuration.mockResolvedValue({ duration: 1_000, warnings: [] });
    let rejectPipeline: ((error: Error) => void) | undefined;
    mocks.runConversionPipeline.mockReturnValueOnce(
      new Promise<ArrayBuffer>((_resolve, reject) => {
        rejectPipeline = reject;
      })
    );
    const runtime = createRuntime();

    const conversion = handleConvert(runtime, localizedProgressT);
    await vi.waitFor(() => expect(mocks.runConversionPipeline).toHaveBeenCalledOnce());
    mocks.setErrorContext.mockClear();
    handleCancelConversion(runtime);
    expect(mocks.appState).toBe('cancelling');

    rejectPipeline?.(
      new OwnedVp8LoadError('Owned VP8 response stream failed', {
        cause: new DOMException('Response body interrupted', 'AbortError'),
      })
    );
    await conversion;

    expect(mocks.appState).toBe('idle');
    expect(mocks.setErrorContext).not.toHaveBeenCalled();
    expect(mocks.transitionToState).not.toHaveBeenCalledWith('error');
  });

  it('restores idle after a cancelled direct retry physically settles', async () => {
    mocks.appState = 'error';
    mocks.settings = { ...mocks.settings, format: 'webp' };
    let resolvePipeline: ((output: ArrayBuffer) => void) | undefined;
    mocks.runConversionPipeline.mockReturnValueOnce(
      new Promise<ArrayBuffer>((resolve) => {
        resolvePipeline = resolve;
      })
    );
    const runtime = createRuntime();

    handleRetry(runtime, localizedProgressT);
    await vi.waitFor(() => expect(mocks.runConversionPipeline).toHaveBeenCalledOnce());
    handleCancelConversion(runtime);
    expect(mocks.appState).toBe('cancelling');

    resolvePipeline?.(
      new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).buffer
    );
    await vi.waitFor(() => expect(mocks.appState).toBe('idle'));
    expect(runtime.beginConversionIntent()).not.toBeNull();
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

  it('keeps the confirmed conversion intent until Stop settles the pipeline', async () => {
    mocks.settings = { ...mocks.settings, format: 'webp' };
    mocks.validateVideoDuration.mockResolvedValue({
      duration: 1_000,
      warnings: [{ message: 'confirm', requiresConfirmation: true }],
    });
    const pipeline = Promise.withResolvers<ArrayBuffer>();
    mocks.runConversionPipeline.mockReturnValueOnce(pipeline.promise);
    const runtime = createRuntime();
    const conversion = handleConvert(runtime, localizedProgressT);
    await vi.waitFor(() => expect(mocks.confirmation).toBeDefined());
    mocks.confirmation?.onConfirm();
    await vi.waitFor(() => expect(mocks.runConversionPipeline).toHaveBeenCalledOnce());
    mocks.setConversionResults.mockClear();

    try {
      handleCancelConversion(runtime);
      await Promise.resolve();
      expect(mocks.appState).toBe('cancelling');
      expect(runtime.beginConversionIntent()).toBeNull();
    } finally {
      pipeline.resolve(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).buffer
      );
      await conversion;
    }

    expect(mocks.setConversionResults).not.toHaveBeenCalled();
    expect(mocks.appState).toBe('idle');
    expect(runtime.beginConversionIntent()).not.toBeNull();
    runtime.dispose();
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
      expect.any(File),
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
      undefined,
      expect.anything(),
      expect.anything()
    );
  });

  it.each(['gif', 'webp'] as const)(
    'uses the %s metadata admitted before asynchronous validation',
    async (format) => {
      let resolveValidation: ((value: unknown) => void) | undefined;
      mocks.settings = { ...mocks.settings, format };
      mocks.metadata = {
        ...mocks.metadata,
        config: { codec: 'vp09.00.10.08', codedHeight: 16, codedWidth: 16 },
        duration: 2,
        framerate: 24,
        rotation: 0,
      };
      mocks.validateVideoDuration.mockReturnValue(
        new Promise((resolve) => {
          resolveValidation = resolve;
        })
      );

      const conversion = handleConvert(createRuntime(), localizedProgressT);
      mocks.metadata = {
        ...mocks.metadata,
        config: { codec: 'avc1.640028', codedHeight: 32, codedWidth: 32 },
        duration: 9,
        framerate: 60,
        rotation: 90,
      };
      resolveValidation?.({ duration: 2_000, warnings: [] });
      await conversion;

      if (format === 'gif') {
        expect(mocks.runPipelineWithFallback).toHaveBeenCalledWith(
          expect.any(File),
          expect.objectContaining({ codec: 'vp09.00.10.08', rotation: 0 }),
          expect.any(Object),
          expect.any(Function),
          expect.any(AbortSignal),
          undefined,
          2,
          24
        );
      } else {
        expect(mocks.runConversionPipeline).toHaveBeenCalledWith(
          expect.objectContaining({
            preComputedMetadata: expect.objectContaining({
              config: expect.objectContaining({ codec: 'vp09.00.10.08' }),
              duration: 2,
              framerate: 24,
              rotation: 0,
            }),
          }),
          expect.any(Function),
          expect.any(AbortSignal)
        );
      }
    }
  );

  it('passes the original File to the GIF worker without a full-file read', async () => {
    mocks.validateVideoDuration.mockResolvedValue({ duration: 1_000, warnings: [] });
    await handleConvert(
      createRuntime(),
      ((key: string) => key) as Parameters<typeof handleConvert>[1]
    );

    expect(mocks.runPipelineWithFallback).toHaveBeenCalledWith(
      expect.any(File),
      expect.any(Object),
      expect.objectContaining({ format: 'gif' }),
      expect.any(Function),
      expect.any(AbortSignal),
      undefined,
      1,
      30
    );
    expect(mocks.readWholeFile).not.toHaveBeenCalled();
  });

  it('uses the input Blob without creating or retaining an ArrayBuffer for WebP', async () => {
    mocks.settings = { ...mocks.settings, format: 'webp' };
    mocks.validateVideoDuration.mockResolvedValue({ duration: 1_000, warnings: [] });
    const runtime = createRuntime();

    await handleConvert(runtime, ((key: string) => key) as Parameters<typeof handleConvert>[1]);

    expect(mocks.runPipelineWithFallback).not.toHaveBeenCalled();
    expect(mocks.readWholeFile).not.toHaveBeenCalled();
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

    await handleConvert(
      createRuntime(),
      ((key: string) => key) as Parameters<typeof handleConvert>[1]
    );

    expect(mocks.setErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('invalid output header')
    );
    expect(mocks.transitionToState).toHaveBeenLastCalledWith('error');
    expect(mocks.setConversionResults).not.toHaveBeenCalledWith([
      expect.objectContaining({ outputBlob: expect.any(Blob) }),
    ]);
  });

  it('publishes the encoded dimensions and requests guarded download focus', async () => {
    mocks.settings = { ...mocks.settings, scale: 0.5 };
    mocks.validateVideoDuration.mockResolvedValue({ duration: 1_000, warnings: [] });

    await handleConvert(
      createRuntime(),
      ((key: string) => key) as Parameters<typeof handleConvert>[1]
    );
    await Promise.resolve();

    expect(mocks.setConversionResults).toHaveBeenLastCalledWith([
      expect.objectContaining({ outputWidth: 8, outputHeight: 8 }),
    ]);
    const resultCall = mocks.setConversionResults.mock.lastCall;
    expect(resultCall?.[0]).toHaveLength(1);
    expect(mocks.setConversionResults.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mocks.transitionToState.mock.invocationCallOrder.at(-1)!
    );
    expect(mocks.focusElementUnlessUserIsEditing).toHaveBeenCalledWith(
      '[data-testid="download-result-button"]'
    );
  });
});

describe('handleDismissError resource cleanup', () => {
  it('releases the file and metadata when the error is dismissed', () => {
    handleDismissError();

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

  it('publishes each active progress callback as one reactive snapshot', async () => {
    mocks.validateVideoDuration.mockResolvedValue({ duration: 1_000, warnings: [] });
    let progressCallback:
      | ((progress: {
          phase: 'decoding';
          progress: number;
          fps: number;
          etaSeconds: number | null;
          memoryMB: number;
          currentFrame: number;
          totalFrames: number;
          outputFrames: number;
          elapsedMs: number;
        }) => void)
      | undefined;
    let resolvePipeline: ((output: ArrayBuffer) => void) | undefined;
    mocks.runPipelineWithFallback.mockImplementationOnce(
      (_buffer, _config, _options, onProgress) => {
        progressCallback = onProgress;
        return new Promise<ArrayBuffer>((resolve) => {
          resolvePipeline = resolve;
        });
      }
    );

    const reactive = createRoot((dispose) => {
      const [progress, setProgress] = createSignal(0);
      const [phase, setPhase] = createSignal<ProgressPhase>('demuxing');
      const [memoryUsage, setMemoryUsage] = createSignal<string | null>(null);
      const [currentFrame, setCurrentFrame] = createSignal<number | undefined>();
      const [totalFrames, setTotalFrames] = createSignal<number | undefined>();
      const [outputFrames, setOutputFrames] = createSignal<number | undefined>();
      const [status, setStatus] = createSignal('');
      mocks.setConversionProgress.mockImplementation(setProgress);
      mocks.setCurrentFrame.mockImplementation(setCurrentFrame);
      mocks.setTotalFrames.mockImplementation(setTotalFrames);
      mocks.setOutputFrames.mockImplementation(setOutputFrames);
      mocks.setConversionStatusMessage.mockImplementation(setStatus);

      const snapshots: unknown[] = [];
      createComputed(() => {
        snapshots.push({
          progress: progress(),
          phase: phase(),
          memoryUsage: memoryUsage(),
          currentFrame: currentFrame(),
          totalFrames: totalFrames(),
          outputFrames: outputFrames(),
          status: status(),
        });
      });

      return { dispose, setMemoryUsage, setPhase, snapshots };
    });

    const runtime = new ConversionRuntimeController({
      setConversionStartTime: vi.fn(),
      setEstimatedSecondsRemaining: vi.fn(),
      setMemoryWarning: vi.fn(),
      setMemoryUsageText: reactive.setMemoryUsage,
      setConversionPhase: reactive.setPhase,
    });
    const run = handleConvert(runtime, localizedProgressT);
    let primaryFailure: unknown;
    const cleanupFailures: unknown[] = [];
    try {
      await vi.waitFor(() => expect(progressCallback).toBeTypeOf('function'));
      reactive.snapshots.length = 0;

      progressCallback?.({
        phase: 'decoding',
        progress: 25,
        fps: 30,
        etaSeconds: 3,
        memoryMB: 42,
        currentFrame: 4,
        totalFrames: 20,
        outputFrames: 3,
        elapsedMs: 1_250,
      });

      expect(reactive.snapshots).toEqual([
        {
          progress: 25,
          phase: 'decoding',
          memoryUsage: '42 MB',
          currentFrame: 4,
          totalFrames: 20,
          outputFrames: 3,
          status: '프레임 4/20 — 디코딩 중 @ 초당 30프레임',
        },
      ]);
    } catch (error) {
      primaryFailure = error;
    } finally {
      try {
        resolvePipeline?.(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]).buffer);
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        await run;
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        runtime.dispose();
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        reactive.dispose();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }

    if (primaryFailure) throw primaryFailure;
    if (cleanupFailures.length > 0) throw cleanupFailures[0];
  });
});

it.each([
  [new OwnedVp8LoadError('Owned VP8 WASM request failed (HTTP 503)'), 'owned_vp8_initialization'],
  [
    new Error('Frame processing failed: owned WASM request interrupted', {
      cause: new OwnedVp8LoadError('Owned VP8 WASM load failed', {
        cause: new DOMException('Failed load request', 'AbortError'),
      }),
    }),
    'owned_vp8_initialization',
  ],
  [
    new OwnedVp8InitializationAbiError('Owned VP8 WASM header is invalid'),
    'owned_vp8_initialization',
  ],
  [new OwnedVp8TrapError('Owned VP8 WASM trapped'), 'owned_vp8_runtime'],
  [
    new WorkerPipelineError('ENCODER_ERROR', 'Owned VP8 WASM trapped', undefined, 'trap'),
    'owned_vp8_runtime',
  ],
] as const)('offers an explicit new conversion for recoverable %s', async (reason, phase) => {
  mocks.settings = { ...mocks.settings, format: 'webp' };
  mocks.validateVideoDuration.mockResolvedValue({ duration: 1000, warnings: [] });
  mocks.runConversionPipeline.mockRejectedValueOnce(reason);
  const runtime = createRuntime();

  await handleConvert(runtime, localizedProgressT);

  expect(mocks.runConversionPipeline).toHaveBeenCalledOnce();
  expect(mocks.transitionToState).toHaveBeenLastCalledWith('error');
  expect(mocks.setErrorContext).toHaveBeenCalledWith(
    expect.objectContaining({
      code: 'ENCODER_ERROR',
      type: 'format',
      phase,
      originalError: reason.message,
      recovery: 'retry',
    })
  );
  expect(mocks.runPipelineWithFallback).not.toHaveBeenCalled();

  // The real conversion-store transition sets this before a click can reach Retry.
  mocks.appState = 'error';
  handleRetry(runtime, localizedProgressT);

  await vi.waitFor(() => expect(mocks.transitionToState).toHaveBeenLastCalledWith('done'));
  expect(mocks.runConversionPipeline).toHaveBeenCalledTimes(2);
  expect(mocks.validateVideoDuration).toHaveBeenCalledOnce();
  expect(mocks.setConversionResults).toHaveBeenCalledWith([
    expect.objectContaining({ outputBlob: expect.any(Blob) }),
  ]);
  expect(mocks.runPipelineWithFallback).not.toHaveBeenCalled();
});

it.each([
  new OwnedVp8AbiError('Owned VP8 raw keyframe header or geometry is invalid'),
  new OwnedVp8InvalidInputError('Owned VP8 rejected the input'),
  new Error('The native WebP encoding failed'),
])('keeps %s on the ordinary format failure path', async (reason) => {
  mocks.settings = { ...mocks.settings, format: 'webp' };
  mocks.validateVideoDuration.mockResolvedValue({ duration: 1000, warnings: [] });
  mocks.runConversionPipeline.mockRejectedValueOnce(reason);

  await handleConvert(createRuntime(), localizedProgressT);

  expect(mocks.runConversionPipeline).toHaveBeenCalledOnce();
  expect(mocks.setErrorContext).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'format', code: 'ENCODER_ERROR' })
  );
  expect(mocks.setErrorContext).not.toHaveBeenCalledWith(
    expect.objectContaining({ recovery: 'retry' })
  );
});

it.each([
  ['gif', new WorkerMemoryLimitError('Worker diagnostic changed'), 'OUT_OF_MEMORY', 'memory'],
  [
    'webp',
    new ConversionMemoryLimitError('Main-thread memory estimate reached 240MB of 256MB limit'),
    'OUT_OF_MEMORY',
    'memory',
  ],
  [
    'webp',
    new Error('Frame processing failed: Opaque timeout', {
      cause: new OwnedVp8TrapError('Opaque timeout'),
    }),
    'ENCODER_ERROR',
    'format',
  ],
  [
    'webp',
    new OwnedVp8LoadError('Owned VP8 response stream failed', {
      cause: new DOMException('Response body interrupted', 'AbortError'),
    }),
    'ENCODER_ERROR',
    'format',
  ],
  ['webp', new OwnedVp8MemoryAdmissionError('Diagnostic changed'), 'OUT_OF_MEMORY', 'memory'],
  ['gif', new WorkerTimeoutError(1000), 'TIMEOUT', 'timeout'],
  [
    'gif',
    new WorkerPipelineError('ENCODER_ERROR', 'Diagnostic changed'),
    'ENCODER_ERROR',
    'format',
  ],
] as const)(
  'publishes the %s producer code through the conversion handler',
  async (format, failure, code, type) => {
    mocks.settings = { ...mocks.settings, format };
    mocks.validateVideoDuration.mockResolvedValue({ duration: 1000, warnings: [] });
    const pipeline = format === 'gif' ? mocks.runPipelineWithFallback : mocks.runConversionPipeline;
    pipeline.mockRejectedValueOnce(failure);

    await handleConvert(createRuntime(), localizedProgressT);

    expect(mocks.setErrorContext).toHaveBeenCalledWith(
      expect.objectContaining({ code, type, originalError: failure.message })
    );
    expect(mocks.transitionToState).toHaveBeenLastCalledWith('error');
    expect(mocks.setConversionResults).not.toHaveBeenCalledWith([
      expect.objectContaining({ outputBlob: expect.any(Blob) }),
    ]);
  }
);

it('keeps a known nested Worker code and leaves an untyped failure on text fallback', async () => {
  mocks.validateVideoDuration.mockResolvedValue({ duration: 1000, warnings: [] });
  mocks.runPipelineWithFallback.mockRejectedValueOnce(
    new Error('Frame failed', {
      cause: new WorkerPipelineError('DECODER_ERROR', 'Changed diagnostic'),
    })
  );
  await handleConvert(createRuntime(), localizedProgressT);
  expect(mocks.setErrorContext).toHaveBeenCalledWith(
    expect.objectContaining({
      code: 'DECODER_ERROR',
      type: 'format',
      originalError: 'Frame failed',
    })
  );

  mocks.setErrorContext.mockClear();
  mocks.runPipelineWithFallback.mockRejectedValueOnce(new Error('Unfamiliar external failure'));
  await handleConvert(createRuntime(), localizedProgressT);
  expect(mocks.setErrorContext).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'UNKNOWN', type: 'general' })
  );
});
