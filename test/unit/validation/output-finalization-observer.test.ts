// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { Blob as NativeBlob, File as NativeFile } from 'node:buffer';

import { BlobSource } from 'mediabunny';
import { expect, test, vi } from 'vitest';

import { installOutputFinalizationObserver } from '../../../validation/windows/output-finalization';

test('output observer preserves native File admission and records WebP construction and reads', async () => {
  const originalBlob = globalThis.Blob;
  const originalFile = globalThis.File;
  const originalArrayBuffer = NativeBlob.prototype.arrayBuffer;
  const originalCreateObjectURL = URL.createObjectURL;
  try {
    globalThis.Blob = NativeBlob as typeof Blob;
    globalThis.File = NativeFile as typeof File;
    URL.createObjectURL = vi.fn(() => 'blob:observed');
    const observer = installOutputFinalizationObserver();

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
  } finally {
    globalThis.Blob = originalBlob;
    globalThis.File = originalFile;
    NativeBlob.prototype.arrayBuffer = originalArrayBuffer;
    URL.createObjectURL = originalCreateObjectURL;
    Reflect.deleteProperty(globalThis, '__wmcOutputFinalizationObserver');
  }
});
