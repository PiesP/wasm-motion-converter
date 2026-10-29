// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  checkVideoDecoderSupport: vi.fn(),
  extractVideoMetadata: vi.fn(),
  metadataModuleGate: null as Promise<void> | null,
  metadataModuleRequested: vi.fn(),
  focusPrimaryErrorAction: vi.fn(),
  focusElementUnlessUserIsEditing: vi.fn(),
  appState: 'idle',
  setErrorContext: vi.fn(),
  setErrorMessage: vi.fn(),
  setInputFile: vi.fn(),
  setVideoPreviewUrl: vi.fn(),
  setVideoMetadata: vi.fn(),
  setConversionSettings: vi.fn(),
  transitionToState: vi.fn(),
  validateVideoFile: vi.fn(),
  settings: {
    format: 'gif' as const,
    quality: 'medium' as const,
    scale: 0.75 as const,
    smartFrameSkip: 'off' as const,
    trimStart: 7,
    trimEnd: 12,
  },
  previewUrl: null as string | null,
}));

vi.mock('@services/video-metadata', () => ({
  extractVideoMetadata: mocks.extractVideoMetadata,
}));
vi.mock('@services/video-decoder-support', () => ({
  checkVideoDecoderSupport: mocks.checkVideoDecoderSupport,
}));
vi.mock('@stores/conversion-settings-store', () => ({
  conversionSettings: () => mocks.settings,
  setConversionSettings: mocks.setConversionSettings,
}));
vi.mock('@stores/conversion-store', () => ({
  appState: () => mocks.appState,
  setErrorContext: mocks.setErrorContext,
  setErrorMessage: mocks.setErrorMessage,
  setInputFile: mocks.setInputFile,
  setVideoMetadata: mocks.setVideoMetadata,
  setVideoPreviewUrl: mocks.setVideoPreviewUrl,
  transitionToState: mocks.transitionToState,
  videoPreviewUrl: () => mocks.previewUrl,
}));
vi.mock('@utils/file-validation', () => ({
  validateVideoFile: mocks.validateVideoFile,
}));
vi.mock('@utils/dom-utils', () => ({
  focusElementUnlessUserIsEditing: mocks.focusElementUnlessUserIsEditing,
  focusPrimaryErrorAction: mocks.focusPrimaryErrorAction,
}));
vi.mock('@utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { ConversionRuntimeController } from '@hooks/conversion-handlers/use-conversion-runtime-controller';
import { handleFileSelected } from '@hooks/conversion-handlers/use-handle-file-selected';

function createRuntime(): ConversionRuntimeController {
  let sequence = 0;
  let activeController: AbortController | null = null;
  return {
    startNewRun: () => {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      const run = ++sequence;
      return {
        signal: controller.signal,
        isActive: () => run === sequence && !controller.signal.aborted,
        isLatest: () => run === sequence,
      };
    },
    invalidateActiveConversions: () => activeController?.abort(),
    finishAnalysisRun: vi.fn(),
    resetRuntimeState: vi.fn(),
  } as unknown as ConversionRuntimeController;
}

async function freshHandleFileSelected(): Promise<typeof handleFileSelected> {
  vi.doMock('@services/video-metadata', async () => {
    mocks.metadataModuleRequested();
    if (mocks.metadataModuleGate) await mocks.metadataModuleGate;
    return { extractVideoMetadata: mocks.extractVideoMetadata };
  });
  vi.resetModules();
  return (await import('@hooks/conversion-handlers/use-handle-file-selected')).handleFileSelected;
}

describe('handleFileSelected conversion settings', () => {
  beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    mocks.checkVideoDecoderSupport.mockReset().mockResolvedValue(true);
    mocks.focusPrimaryErrorAction.mockReset();
    mocks.focusElementUnlessUserIsEditing.mockReset();
    mocks.appState = 'idle';
    mocks.setErrorContext.mockReset();
    mocks.setErrorMessage.mockReset();
    mocks.setInputFile.mockReset();
    mocks.setVideoPreviewUrl.mockReset();
    mocks.setVideoMetadata.mockReset();
    mocks.setConversionSettings.mockReset();
    mocks.transitionToState.mockReset();
    mocks.previewUrl = null;
    mocks.validateVideoFile.mockReset().mockResolvedValue({ valid: true });
    mocks.extractVideoMetadata.mockReset().mockResolvedValue({
      config: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 },
      duration: 10,
      framerate: 30,
      width: 16,
      height: 16,
    });
    mocks.metadataModuleGate = null;
    mocks.metadataModuleRequested.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resets file-specific trim when a valid new file is accepted', async () => {
    const signal = new AbortController().signal;
    const runtime = {
      startNewRun: () => ({ isActive: () => true, signal }),
      finishAnalysisRun: vi.fn(),
      resetRuntimeState: vi.fn(),
    } as unknown as ConversionRuntimeController;

    const file = new File(['video'], 'next.mp4', { type: 'video/mp4' });
    const arrayBufferSpy = vi.spyOn(file, 'arrayBuffer');

    await handleFileSelected(
      file,
      runtime,
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    );

    expect(mocks.setConversionSettings).toHaveBeenCalledWith({
      ...mocks.settings,
      trimStart: 0,
      trimEnd: 0,
    });
    expect(mocks.extractVideoMetadata).toHaveBeenCalledWith(file, 30, signal);
    expect(mocks.checkVideoDecoderSupport).toHaveBeenCalledWith({
      codec: 'vp09.00.10.08',
      codedWidth: 16,
      codedHeight: 16,
    });
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it('rejects an explicitly unsupported decoder configuration before enabling conversion', async () => {
    mocks.checkVideoDecoderSupport.mockResolvedValue(false);
    const signal = new AbortController().signal;
    const runtime = {
      startNewRun: () => ({ isActive: () => true, signal }),
      finishAnalysisRun: vi.fn(),
      resetRuntimeState: vi.fn(),
    } as unknown as ConversionRuntimeController;

    await handleFileSelected(
      new File(['video'], 'unsupported.mp4', { type: 'video/mp4' }),
      runtime,
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    );

    expect(mocks.setVideoMetadata).toHaveBeenCalledOnce();
    expect(mocks.setVideoMetadata).toHaveBeenCalledWith(null);
    expect(mocks.setErrorContext).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'codec',
        code: 'CODEC_NOT_SUPPORTED',
        phase: 'codec_error',
      })
    );
    expect(mocks.transitionToState).toHaveBeenLastCalledWith('error');
    expect(mocks.focusPrimaryErrorAction).toHaveBeenCalledOnce();
    expect(mocks.setErrorContext).toHaveBeenCalledWith(
      expect.objectContaining({ suggestion: 'error.codecSuggestion' })
    );
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('does not expose a file to the video preview while metadata is pending or rejected', async () => {
    let rejectMetadata: ((reason: Error) => void) | undefined;
    mocks.extractVideoMetadata.mockReturnValueOnce(
      new Promise<never>((_resolve, reject) => {
        rejectMetadata = reject;
      })
    );
    const runtime = {
      startNewRun: () => ({ isActive: () => true, signal: new AbortController().signal }),
      finishAnalysisRun: vi.fn(),
      resetRuntimeState: vi.fn(),
    } as unknown as ConversionRuntimeController;
    const file = new File(['invalid video'], 'invalid.mp4', { type: 'video/mp4' });

    const selection = handleFileSelected(
      file,
      runtime,
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    );
    await vi.waitFor(() => expect(mocks.extractVideoMetadata).toHaveBeenCalledOnce());
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(mocks.setVideoPreviewUrl).not.toHaveBeenCalledWith('blob:test-preview');

    rejectMetadata?.(new Error('Invalid metadata'));
    await selection;
    expect(mocks.setInputFile).toHaveBeenLastCalledWith(file);
    expect(mocks.transitionToState).toHaveBeenLastCalledWith('error');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(mocks.setVideoPreviewUrl).not.toHaveBeenCalledWith('blob:test-preview');
  });

  it('does not expose a file to the video preview while decoder support is pending or rejected', async () => {
    let resolveSupport: ((supported: boolean) => void) | undefined;
    mocks.checkVideoDecoderSupport.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveSupport = resolve;
      })
    );
    const runtime = {
      startNewRun: () => ({ isActive: () => true, signal: new AbortController().signal }),
      finishAnalysisRun: vi.fn(),
      resetRuntimeState: vi.fn(),
    } as unknown as ConversionRuntimeController;
    const file = new File(['unsupported video'], 'unsupported.mp4', { type: 'video/mp4' });

    const selection = handleFileSelected(
      file,
      runtime,
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    );
    await vi.waitFor(() => expect(mocks.checkVideoDecoderSupport).toHaveBeenCalledOnce());
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(mocks.setVideoPreviewUrl).not.toHaveBeenCalledWith('blob:test-preview');

    resolveSupport?.(false);
    await selection;
    expect(mocks.setInputFile).toHaveBeenLastCalledWith(file);
    expect(mocks.transitionToState).toHaveBeenLastCalledWith('error');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(mocks.setVideoPreviewUrl).not.toHaveBeenCalledWith('blob:test-preview');
  });

  it('publishes the preview only after both metadata and decoder preflight succeed', async () => {
    let resolveSupport: ((supported: boolean) => void) | undefined;
    mocks.checkVideoDecoderSupport.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveSupport = resolve;
      })
    );
    const runtime = {
      startNewRun: () => ({ isActive: () => true, signal: new AbortController().signal }),
      finishAnalysisRun: vi.fn(),
      resetRuntimeState: vi.fn(),
    } as unknown as ConversionRuntimeController;
    const file = new File(['valid video'], 'valid.mp4', { type: 'video/mp4' });

    const selection = handleFileSelected(
      file,
      runtime,
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    );
    await vi.waitFor(() => expect(mocks.checkVideoDecoderSupport).toHaveBeenCalledOnce());
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    resolveSupport?.(true);
    await selection;
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledWith(file);
    expect(mocks.setVideoPreviewUrl).toHaveBeenCalledWith('blob:test-preview');
    expect(mocks.transitionToState).toHaveBeenLastCalledWith('idle');
  });

  it('clears the previous selection before reporting a new file validation error', async () => {
    mocks.previewUrl = 'blob:previous-preview';
    mocks.validateVideoFile.mockResolvedValueOnce({
      valid: false,
      error: new Error('invalid file'),
    });
    const runtime = {
      startNewRun: () => ({ isActive: () => true, signal: new AbortController().signal }),
      finishAnalysisRun: vi.fn(),
      resetRuntimeState: vi.fn(),
    } as unknown as ConversionRuntimeController;

    await handleFileSelected(
      new File(['bad'], 'replacement.bin'),
      runtime,
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    );

    expect(mocks.setInputFile).toHaveBeenCalledWith(null);
    expect(mocks.setVideoPreviewUrl).toHaveBeenCalledWith(null);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:previous-preview');
    expect(mocks.extractVideoMetadata).not.toHaveBeenCalled();
    expect(mocks.transitionToState).toHaveBeenLastCalledWith('error');
  });

  it('ignores a stale invalid result after a newer file is accepted', async () => {
    let resolveStaleValidation: ((result: { valid: false; error: Error }) => void) | undefined;
    const staleValidation = new Promise<{ valid: false; error: Error }>((resolve) => {
      resolveStaleValidation = resolve;
    });
    mocks.validateVideoFile
      .mockImplementationOnce(() => staleValidation)
      .mockResolvedValueOnce({ valid: true });

    let activeRun = 0;
    const runtime = {
      startNewRun: () => {
        const run = ++activeRun;
        return {
          isActive: () => run === activeRun,
          runId: `run-${run}`,
          signal: new AbortController().signal,
        };
      },
      finishAnalysisRun: vi.fn(),
      resetRuntimeState: vi.fn(),
    } as unknown as ConversionRuntimeController;

    const staleSelection = handleFileSelected(
      new File(['old'], 'old.bin'),
      runtime,
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    );
    const newFile = new File(['new'], 'new.mp4', { type: 'video/mp4' });
    await handleFileSelected(
      newFile,
      runtime,
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    );

    mocks.setErrorMessage.mockClear();
    mocks.transitionToState.mockClear();
    mocks.focusPrimaryErrorAction.mockClear();
    resolveStaleValidation?.({ valid: false, error: new Error('stale validation failed') });
    await staleSelection;

    expect(mocks.setErrorMessage).not.toHaveBeenCalled();
    expect(mocks.transitionToState).not.toHaveBeenCalled();
    expect(mocks.focusPrimaryErrorAction).not.toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledWith(newFile);
  });

  it('ignores a stale unsupported-codec result after a newer file is accepted', async () => {
    let resolveStaleSupport: ((supported: boolean) => void) | undefined;
    const staleSupport = new Promise<boolean>((resolve) => {
      resolveStaleSupport = resolve;
    });
    mocks.checkVideoDecoderSupport
      .mockImplementationOnce(() => staleSupport)
      .mockResolvedValueOnce(true);

    let activeRun = 0;
    const runtime = {
      startNewRun: () => {
        const run = ++activeRun;
        return {
          isActive: () => run === activeRun,
          runId: `run-${run}`,
          signal: new AbortController().signal,
        };
      },
      finishAnalysisRun: vi.fn(),
      resetRuntimeState: vi.fn(),
    } as unknown as ConversionRuntimeController;

    const staleSelection = handleFileSelected(
      new File(['old'], 'old-hevc.mp4', { type: 'video/mp4' }),
      runtime,
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    );
    await vi.waitFor(() => expect(mocks.checkVideoDecoderSupport).toHaveBeenCalledOnce());

    const newFile = new File(['new'], 'new.mp4', { type: 'video/mp4' });
    await handleFileSelected(
      newFile,
      runtime,
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    );

    mocks.setErrorContext.mockClear();
    mocks.setErrorMessage.mockClear();
    mocks.transitionToState.mockClear();
    mocks.focusPrimaryErrorAction.mockClear();
    resolveStaleSupport?.(false);
    await staleSelection;

    expect(mocks.setErrorContext).not.toHaveBeenCalled();
    expect(mocks.setErrorMessage).not.toHaveBeenCalled();
    expect(mocks.transitionToState).not.toHaveBeenCalled();
    expect(mocks.focusPrimaryErrorAction).not.toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledWith(newFile);
  });

  it('keeps analysis cancellation busy until metadata cleanup settles', async () => {
    let finishMetadata: ((value: unknown) => void) | undefined;
    mocks.extractVideoMetadata.mockReturnValueOnce(
      new Promise<unknown>((resolve) => {
        finishMetadata = resolve;
      })
    );
    const abort = new AbortController();
    const runtime = {
      startNewRun: () => ({
        isActive: () => !abort.signal.aborted,
        isLatest: () => true,
        signal: abort.signal,
      }),
      finishAnalysisRun: vi.fn(),
      resetRuntimeState: vi.fn(),
    } as unknown as ConversionRuntimeController;

    const selection = handleFileSelected(
      new File(['video'], 'cancelled.mp4', { type: 'video/mp4' }),
      runtime,
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    );
    await vi.waitFor(() => expect(mocks.extractVideoMetadata).toHaveBeenCalledOnce());
    mocks.appState = 'cancelling';
    abort.abort();

    expect(mocks.transitionToState).not.toHaveBeenCalledWith('idle');
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    finishMetadata?.({});
    await selection;
    expect(mocks.transitionToState).toHaveBeenLastCalledWith('idle');
    expect(mocks.setInputFile).toHaveBeenLastCalledWith(null);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(mocks.setVideoPreviewUrl).not.toHaveBeenCalledWith('blob:test-preview');
    expect(runtime.finishAnalysisRun).toHaveBeenCalledOnce();
  });

  it('settles cancellation during the advisory decoder query and ignores a late rejection', async () => {
    let rejectSupport: ((reason: Error) => void) | undefined;
    mocks.checkVideoDecoderSupport.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectSupport = reject;
      })
    );
    const runtime = createRuntime();
    let settled = false;
    const selection = handleFileSelected(
      new File(['video'], 'cancelled.mp4', { type: 'video/mp4' }),
      runtime,
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    ).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(mocks.checkVideoDecoderSupport).toHaveBeenCalledOnce());
    mocks.appState = 'cancelling';
    runtime.invalidateActiveConversions();
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 200 });
    expect(mocks.transitionToState).toHaveBeenLastCalledWith('idle');
    expect(mocks.setInputFile).toHaveBeenLastCalledWith(null);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    rejectSupport?.(new Error('late support failure'));
    await selection;
  });

  it('does not request the metadata module for an invalid file', async () => {
    const selectFile = await freshHandleFileSelected();
    mocks.validateVideoFile.mockResolvedValueOnce({ valid: false, error: new Error('invalid') });

    await selectFile(
      new File(['bad'], 'bad.bin'),
      createRuntime(),
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    );

    expect(mocks.metadataModuleRequested).not.toHaveBeenCalled();
    expect(mocks.extractVideoMetadata).not.toHaveBeenCalled();
  });

  it('settles cancellation while module loading remains pending and observes its late rejection', async () => {
    const selectFile = await freshHandleFileSelected();
    let rejectLoad: ((reason: Error) => void) | undefined;
    mocks.metadataModuleGate = new Promise<void>((_resolve, reject) => {
      rejectLoad = reject;
    });
    const runtime = createRuntime();
    const file = new File(['video'], 'cancel-during-load.mp4', { type: 'video/mp4' });

    const selection = selectFile(
      file,
      runtime,
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    );
    await vi.waitFor(() => expect(mocks.metadataModuleRequested).toHaveBeenCalledOnce());
    expect(mocks.transitionToState).toHaveBeenCalledWith('analyzing');
    expect(mocks.extractVideoMetadata).not.toHaveBeenCalled();

    mocks.appState = 'cancelling';
    runtime.invalidateActiveConversions();
    await selection;

    expect(mocks.transitionToState).toHaveBeenLastCalledWith('idle');
    expect(mocks.setInputFile).toHaveBeenLastCalledWith(null);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    rejectLoad?.(new Error('late chunk rejection'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.extractVideoMetadata).not.toHaveBeenCalled();
    expect(mocks.setErrorMessage).not.toHaveBeenCalledWith('late chunk rejection');
  });

  it('does not let a retired module load clear the newer selection', async () => {
    const selectFile = await freshHandleFileSelected();
    let resolveLoad: (() => void) | undefined;
    mocks.metadataModuleGate = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
    const runtime = createRuntime();
    const oldFile = new File(['old'], 'old.mp4', { type: 'video/mp4' });
    const newFile = new File(['new'], 'new.mp4', { type: 'video/mp4' });

    const oldSelection = selectFile(
      oldFile,
      runtime,
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    );
    await vi.waitFor(() => expect(mocks.metadataModuleRequested).toHaveBeenCalledOnce());

    // Keep the cancelling state visible while the replacement starts. The old
    // run's finally must not clear the replacement's file or preview.
    mocks.appState = 'cancelling';
    const newSelection = selectFile(
      newFile,
      runtime,
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    );
    await oldSelection;
    expect(mocks.setInputFile).toHaveBeenLastCalledWith(newFile);
    expect(mocks.extractVideoMetadata).not.toHaveBeenCalled();

    resolveLoad?.();
    await newSelection;
    expect(mocks.extractVideoMetadata).toHaveBeenCalledOnce();
    expect(mocks.extractVideoMetadata).toHaveBeenCalledWith(newFile, 30, expect.any(AbortSignal));
    expect(URL.createObjectURL).toHaveBeenCalledWith(newFile);
    expect(mocks.setInputFile).toHaveBeenLastCalledWith(newFile);
    expect(mocks.transitionToState).toHaveBeenLastCalledWith('idle');
  });

  it('does not turn a stale module rejection into a second error for the replacement', async () => {
    const selectFile = await freshHandleFileSelected();
    let rejectLoad: ((reason: Error) => void) | undefined;
    mocks.metadataModuleGate = new Promise<void>((_resolve, reject) => {
      rejectLoad = reject;
    });
    const runtime = createRuntime();

    const oldSelection = selectFile(
      new File(['old'], 'old.mp4', { type: 'video/mp4' }),
      runtime,
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    );
    await vi.waitFor(() => expect(mocks.metadataModuleRequested).toHaveBeenCalledOnce());
    const replacement = new File(['new'], 'new.mp4', { type: 'video/mp4' });
    const newSelection = selectFile(
      replacement,
      runtime,
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    );
    await oldSelection;
    expect(mocks.setInputFile).toHaveBeenLastCalledWith(replacement);

    rejectLoad?.(new Error('chunk unavailable'));
    await newSelection;
    expect(mocks.setErrorMessage.mock.calls.filter(([message]) => message !== null)).toHaveLength(
      1
    );
    expect(mocks.focusPrimaryErrorAction).toHaveBeenCalledOnce();
    expect(mocks.transitionToState).toHaveBeenLastCalledWith('error');
    expect(mocks.extractVideoMetadata).not.toHaveBeenCalled();
  });

  it('surfaces a current module-load rejection through the existing error path', async () => {
    const selectFile = await freshHandleFileSelected();
    let rejectLoad: ((reason: Error) => void) | undefined;
    mocks.metadataModuleGate = new Promise<void>((_resolve, reject) => {
      rejectLoad = reject;
    });

    const selection = selectFile(
      new File(['video'], 'load-error.mp4', { type: 'video/mp4' }),
      createRuntime(),
      ((key: string) => key) as Parameters<typeof handleFileSelected>[2]
    );
    await vi.waitFor(() => expect(mocks.metadataModuleRequested).toHaveBeenCalledOnce());
    rejectLoad?.(new Error('metadata chunk unavailable'));
    await selection;

    // Vitest wraps a rejected mock factory; the browser rejection is covered by
    // the built-chunk failure profile. The handler must still expose an error.
    expect(mocks.setErrorMessage).toHaveBeenCalledWith(expect.any(String));
    expect(mocks.transitionToState).toHaveBeenLastCalledWith('error');
    expect(mocks.focusPrimaryErrorAction).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
