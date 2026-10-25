// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { Blob as NativeBlob, File as NativeFile } from 'node:buffer';

import { BlobSource } from 'mediabunny';
import { expect, test, vi } from 'vitest';

import {
  classifyWebpRoute,
  installOutputFinalizationObserver,
} from '../../../validation/windows/output-finalization';

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

test('output observer preserves native File admission and records WebP construction and reads', async () => {
  const originalBlob = globalThis.Blob;
  const originalFile = globalThis.File;
  const originalArrayBuffer = NativeBlob.prototype.arrayBuffer;
  const originalCreateObjectURL = URL.createObjectURL;
  let observer: ReturnType<typeof installOutputFinalizationObserver> | undefined;
  let diagnostic: HTMLElement | undefined;
  try {
    globalThis.Blob = NativeBlob as typeof Blob;
    globalThis.File = NativeFile as typeof File;
    URL.createObjectURL = vi.fn(() => 'blob:observed');
    observer = installOutputFinalizationObserver();

    const file = new File(['video'], 'input.mp4', { type: 'video/mp4' });
    expect(file instanceof Blob).toBe(true);
    expect(() => new BlobSource(file)).not.toThrow();

    const output = new Blob(['RIFF'], { type: 'image/webp' });
    const nativePromise = output.arrayBuffer();
    expect((await nativePromise).byteLength).toBe(4);
    const url = URL.createObjectURL(output);
    expect(url).toBe('blob:observed');
    expect(observer.events.map((event) => [event.kind, event.size])).toEqual([
      ['construct', 4],
      ['read', 4],
      ['url', 4],
    ]);

    diagnostic = document.createElement('details');
    diagnostic.dataset.testid = 'progress-diagnostics';
    document.body.append(diagnostic);
    diagnostic.textContent = 'Frame 240/240 (225 out)';
    await Promise.resolve();
    expect(observer.frameCounters.at(-1)).toMatchObject({
      current: 240,
      total: 240,
      output: 225,
      outputExplicit: true,
    });
    observer.reset();
    diagnostic.textContent = 'Frame 240/240';
    await Promise.resolve();
    expect(observer.frameCounters).toHaveLength(1);
    expect(observer.frameCounters[0]).toMatchObject({
      current: 240,
      total: 240,
      output: 240,
      outputExplicit: false,
    });
  } finally {
    observer?.disconnect();
    diagnostic?.remove();
    globalThis.Blob = originalBlob;
    globalThis.File = originalFile;
    NativeBlob.prototype.arrayBuffer = originalArrayBuffer;
    URL.createObjectURL = originalCreateObjectURL;
    Reflect.deleteProperty(globalThis, '__wmcOutputFinalizationObserver');
  }
});
