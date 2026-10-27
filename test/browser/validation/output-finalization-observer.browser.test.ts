// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, test } from 'vite-plus/test';

import { installOutputFinalizationObserver } from '../../../validation/windows/output-finalization-observer';

test('output observer records native Blob construction, reads, URLs, and conversion clicks', async () => {
  const NativeBlob = globalThis.Blob;
  const originalArrayBuffer = NativeBlob.prototype.arrayBuffer;
  const originalCreateObjectURL = URL.createObjectURL;
  let url: string | undefined;
  try {
    const observer = installOutputFinalizationObserver();
    const output = new Blob(['RIFF'], { type: 'image/webp' });
    const nativePromise = output.arrayBuffer();
    expect((await nativePromise).byteLength).toBe(4);
    url = URL.createObjectURL(output);
    expect(url).toMatch(/^blob:/);
    expect(observer.events.map((event) => [event.kind, event.size])).toEqual([
      ['construct', 4],
      ['read', 4],
      ['url', 4],
    ]);
    const convert = document.createElement('button');
    convert.dataset.testid = 'convert-button';
    document.body.appendChild(convert);
    convert.click();
    expect(observer.clickMs).toBeTypeOf('number');
  } finally {
    globalThis.Blob = NativeBlob;
    NativeBlob.prototype.arrayBuffer = originalArrayBuffer;
    URL.createObjectURL = originalCreateObjectURL;
    if (url) URL.revokeObjectURL(url);
    document.body.innerHTML = '';
    Reflect.deleteProperty(globalThis, '__wmcOutputFinalizationObserver');
  }
});
