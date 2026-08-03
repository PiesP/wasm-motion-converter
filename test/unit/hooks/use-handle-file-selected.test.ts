// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  extractVideoMetadata: vi.fn(),
  setConversionSettings: vi.fn(),
  validateVideoFile: vi.fn(),
  settings: {
    format: 'gif' as const,
    quality: 'medium' as const,
    scale: 0.75 as const,
    smartFrameSkip: 'off' as const,
    trimStart: 7,
    trimEnd: 12,
  },
}));

vi.mock('@services/video-metadata', () => ({
  extractVideoMetadata: mocks.extractVideoMetadata,
}));
vi.mock('@stores/conversion-settings-store', () => ({
  conversionSettings: () => mocks.settings,
  setConversionSettings: mocks.setConversionSettings,
}));
vi.mock('@stores/conversion-store', () => ({
  setErrorContext: vi.fn(),
  setErrorMessage: vi.fn(),
  setInputBuffer: vi.fn(),
  setInputFile: vi.fn(),
  setVideoMetadata: vi.fn(),
  setVideoPreviewUrl: vi.fn(),
  transitionToState: vi.fn(),
  videoPreviewUrl: () => null,
}));
vi.mock('@utils/file-validation', () => ({
  validateVideoFile: mocks.validateVideoFile,
}));
vi.mock('@utils/dom-utils', () => ({
  focusRetryButton: vi.fn(),
}));
vi.mock('@utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleFileSelected } from '@hooks/conversion-handlers/use-handle-file-selected';
import type { ConversionRuntimeController } from '@hooks/conversion-handlers/use-conversion-runtime-controller';

describe('handleFileSelected conversion settings', () => {
  beforeEach(() => {
    mocks.setConversionSettings.mockReset();
    mocks.validateVideoFile.mockReset().mockResolvedValue({ valid: true });
    mocks.extractVideoMetadata.mockReset().mockResolvedValue({
      config: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 },
      duration: 10,
      framerate: 30,
      width: 16,
      height: 16,
    });
  });

  it('resets file-specific trim when a valid new file is accepted', async () => {
    const runtime = {
      startNewRun: () => ({ isActive: () => true }),
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
    expect(mocks.extractVideoMetadata).toHaveBeenCalledWith(file, 30);
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });
});
