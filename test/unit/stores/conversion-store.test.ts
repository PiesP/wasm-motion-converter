// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock logger before importing stores
vi.mock('@utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('conversion-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset all signals by importing fresh
    vi.resetModules();
  });

  it('appState starts as idle', async () => {
    const { appState } = await import('@stores/conversion-store');
    expect(appState()).toBe('idle');
  });

  it('can transition through app states', async () => {
    const { appState, setAppState, transitionToState } = await import('@stores/conversion-store');

    setAppState('analyzing');
    expect(appState()).toBe('analyzing');

    setAppState('converting');
    expect(appState()).toBe('converting');

    setAppState('done');
    expect(appState()).toBe('done');

    transitionToState('converting');
    expect(appState()).toBe('converting');
    transitionToState('converting');
    expect(appState()).toBe('converting');

    setAppState('idle');
    expect(appState()).toBe('idle');
  });

  it('conversionProgress starts at 0', async () => {
    const { conversionProgress } = await import('@stores/conversion-store');
    expect(conversionProgress()).toBe(0);
  });

  it('can set and read conversion progress', async () => {
    const { conversionProgress, setConversionProgress } = await import('@stores/conversion-store');

    setConversionProgress(50);
    expect(conversionProgress()).toBe(50);

    setConversionProgress(100);
    expect(conversionProgress()).toBe(100);
  });

  it('inputFile starts as null', async () => {
    const { inputFile } = await import('@stores/conversion-store');
    expect(inputFile()).toBeNull();
  });

  it('can set and read input file', async () => {
    const { inputFile, setInputFile } = await import('@stores/conversion-store');

    const mockFile = new File(['dummy'], 'test.mp4', { type: 'video/mp4' });
    setInputFile(mockFile);
    expect(inputFile()).toBe(mockFile);

    setInputFile(null);
    expect(inputFile()).toBeNull();
  });

  it('videoMetadata starts as null', async () => {
    const { videoMetadata } = await import('@stores/conversion-store');
    expect(videoMetadata()).toBeNull();
  });

  it('can set and read video metadata', async () => {
    const { videoMetadata, setVideoMetadata } = await import('@stores/conversion-store');

    const mockMetadata = { width: 1920, height: 1080, duration: 5, codec: 'h264', framerate: 30, bitrate: 5000000 };
    setVideoMetadata(mockMetadata);
    expect(videoMetadata()).toEqual(mockMetadata);

    setVideoMetadata(null);
    expect(videoMetadata()).toBeNull();
  });

  it('errorMessage starts as null', async () => {
    const { errorMessage } = await import('@stores/conversion-store');
    expect(errorMessage()).toBeNull();
  });

  it('can set and read error message', async () => {
    const { errorMessage, setErrorMessage } = await import('@stores/conversion-store');

    setErrorMessage('Test error');
    expect(errorMessage()).toBe('Test error');

    setErrorMessage(null);
    expect(errorMessage()).toBeNull();
  });

  it('environmentSupported starts as true', async () => {
    const { environmentSupported } = await import('@stores/conversion-store');
    expect(environmentSupported()).toBe(true);
  });

  it('can set environment supported flag', async () => {
    const { environmentSupported, setEnvironmentSupported } = await import('@stores/conversion-store');

    setEnvironmentSupported(false);
    expect(environmentSupported()).toBe(false);

    setEnvironmentSupported(true);
    expect(environmentSupported()).toBe(true);
  });

  it('stores conversion result, progress metadata, and the input buffer', async () => {
    const {
      conversionResults,
      setConversionResults,
      conversionStatusMessage,
      setConversionStatusMessage,
      conversionFps,
      setConversionFps,
      conversionElapsedMs,
      setConversionElapsedMs,
      outputFrames,
      setOutputFrames,
      getInputBuffer,
      setInputBuffer,
      setCurrentFrame,
      setTotalFrames,
    } = await import('@stores/conversion-store');

    const results = [
      {
        id: 'result-1',
        outputBlob: new Blob(['result']),
        originalName: 'input.mp4',
        originalSize: 6,
        createdAt: 123,
        settings: {
          format: 'gif' as const,
          quality: 'high' as const,
          scale: 1.0 as const,
          trimStart: 0,
          trimEnd: 0,
          smartFrameSkip: 'off' as const,
        },
        conversionDurationSeconds: 1.2,
      },
    ];
    setConversionResults(results);
    expect(conversionResults()).toEqual(results);
    setConversionStatusMessage('encoding');
    setConversionFps(24);
    setConversionElapsedMs(1234);
    setOutputFrames(12);
    setCurrentFrame(4);
    setTotalFrames(12);
    expect(conversionStatusMessage()).toBe('encoding');
    expect(conversionFps()).toBe(24);
    expect(conversionElapsedMs()).toBe(1234);
    expect(outputFrames()).toBe(12);

    const buffer = new ArrayBuffer(8);
    setInputBuffer(buffer);
    expect(getInputBuffer()).toBe(buffer);
    setInputBuffer(null);
    expect(getInputBuffer()).toBeNull();
  });
});
