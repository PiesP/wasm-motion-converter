// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { Page } from '@playwright/test';

type BlobEvent = {
  kind: 'construct' | 'read' | 'url';
  size: number;
  startMs: number;
  endMs: number;
};
export type Observer = {
  clickMs: number | null;
  events: BlobEvent[];
  reset: () => void;
};

/** Installed before the built app to observe browser output construction and reads. */
export function installOutputFinalizationObserver() {
  const observer: Observer = {
    clickMs: null,
    events: [],
    reset() {
      this.clickMs = null;
      this.events = [];
    },
  };
  Reflect.set(globalThis, '__wmcOutputFinalizationObserver', observer);
  const NativeBlob = Blob;
  globalThis.Blob = new Proxy(NativeBlob, {
    construct(target, parts, newTarget) {
      const startMs = performance.now();
      const blob = Reflect.construct(target, parts, newTarget) as Blob;
      if (blob.type === 'image/webp')
        observer.events.push({
          kind: 'construct',
          size: blob.size,
          startMs,
          endMs: performance.now(),
        });
      return blob;
    },
  });
  const nativeArrayBuffer = NativeBlob.prototype.arrayBuffer;
  NativeBlob.prototype.arrayBuffer = function () {
    if (this.type !== 'image/webp') return nativeArrayBuffer.call(this);
    const startMs = performance.now();
    const promise = nativeArrayBuffer.call(this);
    // Return the native promise unchanged so consumers retain its timing and identity.
    void promise.then(
      () =>
        observer.events.push({
          kind: 'read',
          size: this.size,
          startMs,
          endMs: performance.now(),
        }),
      () =>
        observer.events.push({ kind: 'read', size: this.size, startMs, endMs: performance.now() })
    );
    return promise;
  };
  const nativeCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (object: Blob | MediaSource) {
    const startMs = performance.now();
    const url = nativeCreateObjectURL.call(URL, object);
    if (object instanceof NativeBlob && object.type === 'image/webp')
      observer.events.push({ kind: 'url', size: object.size, startMs, endMs: performance.now() });
    return url;
  };
  document.addEventListener(
    'click',
    (event) => {
      if (event.target instanceof Element && event.target.closest('[data-testid="convert-button"]'))
        observer.clickMs = performance.now();
    },
    true
  );
  return observer;
}

export async function installOutputFinalizationObserverOnPage(page: Page) {
  await page.addInitScript(installOutputFinalizationObserver);
}
