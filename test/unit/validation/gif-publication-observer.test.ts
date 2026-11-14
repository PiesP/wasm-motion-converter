import { afterEach, expect, it, vi } from 'vite-plus/test';

import { installMotionObserver } from '../../../validation/windows/motion-signature';

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, '__wmcMotionObserver');
});

it('retains a cancelled-run GIF publication across readiness resets', () => {
  vi.stubGlobal(
    'Worker',
    class {
      postMessage() {}
      terminate() {}
    }
  );
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
    }
  );
  vi.stubGlobal('document', {
    addEventListener() {},
    querySelector() {
      return null;
    },
  });
  vi.stubGlobal('location', { href: 'http://localhost/' });
  let created = 0;
  const RealURL = URL;
  vi.stubGlobal(
    'URL',
    class extends RealURL {
      static override createObjectURL() {
        return `blob:owned-${++created}`;
      }
    }
  );
  installMotionObserver();
  const observer = Reflect.get(globalThis, '__wmcMotionObserver') as {
    outputUrls: unknown[];
    gifPublicationCount: number;
    lastGifPublication: { url: string; size: number } | null;
    reset(): void;
  };
  // This is the former false-pass interval: cancellation was already sampled,
  // but recovery has not yet reset its per-conversion readiness observations.
  URL.createObjectURL(new Blob(['stale'], { type: 'image/gif' }));
  observer.reset();
  expect(observer.outputUrls).toEqual([]);
  expect(observer.gifPublicationCount).toBe(1);
  URL.createObjectURL(new Blob(['recovery'], { type: 'image/gif' }));
  expect(observer.outputUrls).toHaveLength(1);
  expect(observer.gifPublicationCount).toBe(2);
  expect(observer.lastGifPublication).toEqual({ url: 'blob:owned-2', size: 8 });
});
