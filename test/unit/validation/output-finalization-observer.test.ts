// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { Blob as NativeBlob, File as NativeFile } from 'node:buffer';

import { BlobSource } from 'mediabunny';
import { expect, test } from 'vite-plus/test';

import { classifyWebpRoute } from '../../../validation/windows/output-finalization';

test('production WebP branch messages identify the actual encoder', () => {
  expect(
    classifyWebpRoute('  ├─ Branch: WebP encoder (parallel Worker pool + OffscreenCanvas)')
  ).toBe('webp-parallel-canvas');
  expect(classifyWebpRoute('  ├─ Branch: WebP encoder (OffscreenCanvas convertToBlob + mux)')).toBe(
    'webp-serial-canvas'
  );
  expect(classifyWebpRoute('  ├─ Branch: WebP encoder (streaming encodeRGB + mux)')).toBe(
    'webp-wasm'
  );
  expect(classifyWebpRoute('▶ Pipeline route: MAINTHREAD_WEBP')).toBeNull();
});

test('native File remains a Blob accepted by Mediabunny', () => {
  const originalBlob = globalThis.Blob;
  const originalFile = globalThis.File;
  try {
    globalThis.Blob = NativeBlob as typeof Blob;
    globalThis.File = NativeFile as typeof File;
    const file = new File(['video'], 'input.mp4', { type: 'video/mp4' });
    expect(file instanceof Blob).toBe(true);
    expect(() => new BlobSource(file)).not.toThrow();
  } finally {
    globalThis.Blob = originalBlob;
    globalThis.File = originalFile;
  }
});
