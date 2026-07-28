// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateVideoDuration, validateVideoFile } from '@utils/file-validation';

const t = ((key: string) => key) as never;

const makeFile = (bytes: number[], name = 'video.bin') =>
  new File([new Uint8Array(bytes)], name, { type: '' });

describe('video file validation edge paths', () => {
  it.each([
    ['mp4', [0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]],
    ['moov', [0, 0, 0, 0, 0x6d, 0x6f, 0x6f, 0x76, 0, 0, 0, 0]],
    ['webm', [0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]],
    ['avi', [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]],
    ['ogg', [0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0]],
    ['mpeg-ts', [0x47, 0, 0, 0, 0, 0, 0, 0]],
  ])('accepts a %s magic-byte signature without an extension', async (_name, signature) => {
    const result = await validateVideoFile(makeFile(signature), t);
    expect(result).toEqual({ valid: true });
  });

  it('rejects a short or unknown magic-byte header', async () => {
    expect((await validateVideoFile(makeFile([1, 2, 3]), t)).valid).toBe(false);
    expect((await validateVideoFile(makeFile([1, 2, 3, 4, 5, 6, 7, 8]), t)).valid).toBe(false);
  });
});

describe('validateVideoDuration', () => {
  let video: {
    preload: string;
    src: string;
    duration: number;
    onloadedmetadata: (() => void) | null;
    onerror: (() => void) | null;
  };
  let originalCreateObjectURL: typeof URL.createObjectURL | undefined;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL | undefined;

  beforeEach(() => {
    video = {
      preload: '',
      src: '',
      duration: 5,
      onloadedmetadata: null,
      onerror: null,
    };
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:validation-test'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) =>
      tagName === 'video' ? video : document.createElementNS('http://www.w3.org/1999/xhtml', tagName)) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCreateObjectURL) {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreateObjectURL,
      });
    } else {
      Reflect.deleteProperty(URL, 'createObjectURL');
    }
    if (originalRevokeObjectURL) {
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: originalRevokeObjectURL,
      });
    } else {
      Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });

  it('returns duration and cleans up the blob URL on metadata success', async () => {
    const promise = validateVideoDuration(new File(['x'], 'video.bin'), 'gif', t, 24);
    expect(video.preload).toBe('metadata');
    expect(video.src).toBe('blob:validation-test');
    video.onloadedmetadata?.();

    await expect(promise).resolves.toMatchObject({
      valid: true,
      duration: 5000,
      estimatedFrames: 120,
      warnings: [],
    });
    expect(video.src).toBe('');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:validation-test');
  });

  it('returns WebP warnings for duration and frame limits', async () => {
    video.duration = 901;
    const promise = validateVideoDuration(new File(['x'], 'video.bin'), 'webp', t, 30);
    video.onloadedmetadata?.();

    const result = await promise;
    expect(result.valid).toBe(true);
    expect(result.duration).toBe(901_000);
    expect(result.estimatedFrames).toBe(27_030);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every((warning) => warning.requiresConfirmation === false)).toBe(true);
  });

  it('continues with an informational warning when metadata extraction fails', async () => {
    const promise = validateVideoDuration(new File(['x'], 'video.bin'), 'webp', t);
    video.onerror?.();

    await expect(promise).resolves.toMatchObject({
      valid: true,
      duration: 0,
      estimatedFrames: 0,
      warnings: [{ severity: 'info', requiresConfirmation: false }],
    });
  });

  it('rejects invalid duration metadata and cleans up', async () => {
    video.duration = Number.NaN;
    const promise = validateVideoDuration(new File(['x'], 'video.bin'), 'gif', t);
    video.onloadedmetadata?.();
    await expect(promise).resolves.toMatchObject({ valid: true, duration: 0 });
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('times out when the video emits neither metadata nor an error', async () => {
    vi.useFakeTimers();
    const promise = validateVideoDuration(new File(['x'], 'video.bin'), 'gif', t);
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toMatchObject({ valid: true, duration: 0 });
    vi.useRealTimers();
  });

  it('rejects cancellation and cleans up duration extraction resources', async () => {
    const controller = new AbortController();
    const promise = validateVideoDuration(
      new File(['x'], 'video.bin'),
      'gif',
      t,
      30,
      controller.signal
    );

    controller.abort();
    video.onerror?.();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(video.src).toBe('');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:validation-test');
  });
});
