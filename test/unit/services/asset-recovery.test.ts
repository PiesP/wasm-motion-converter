import { errorMessage, setErrorMessage } from '@stores/conversion-store';
import { logger } from '@utils/logger';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import {
  assetFailure,
  clearAssetFailure,
  isAppAssetPath,
  observePreloadErrors,
  ownPreloadErrors,
  pathFromPreloadError,
  reportAssetFailure,
} from '@/asset-recovery';

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  clearAssetFailure();
  setErrorMessage(null);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('observes a real Vite event without cancelling its normal rejection', () => {
  const logged = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  stop = observePreloadErrors();
  const event = new Event('vite:preloadError', { cancelable: true }) as Event & {
    payload?: unknown;
  };
  event.payload = new TypeError(
    `Failed to fetch dynamically imported module: ${location.origin}/assets/codec.ABCDef12.js?token=private`
  );
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(assetFailure()).toEqual({
    path: '/assets/codec.ABCDef12.js',
    status: null,
    reason: 'preload-rejected',
    source: 'vite-preload',
  });
  expect(logged).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(logged.mock.calls[0])).not.toContain('private');
  window.dispatchEvent(event);
  expect(logged).toHaveBeenCalledTimes(1);
  stop();
  stop = undefined;
  clearAssetFailure();
  window.dispatchEvent(event);
  expect(assetFailure()).toBeNull();
});

it('keeps foreign origins unknown and strips same-origin query strings', () => {
  expect(
    pathFromPreloadError(
      new TypeError(
        'Failed to fetch dynamically imported module: https://foreign.invalid/assets/codec.ABCDef12.js?secret=1'
      )
    )
  ).toBeNull();
  expect(
    pathFromPreloadError(
      new TypeError(
        'Failed to fetch dynamically imported module: //foreign.invalid/assets/codec.ABCDef12.js'
      )
    )
  ).toBeNull();
  expect(
    pathFromPreloadError(
      new TypeError(
        'Failed to fetch dynamically imported module: /assets/codec.ABCDef12.js?secret=1'
      )
    )
  ).toBe('/assets/codec.ABCDef12.js');
  expect(
    pathFromPreloadError(
      new TypeError(
        `Failed to fetch dynamically imported module: ${location.origin}/assets/codec.ABCDef12.js?secret=1`
      )
    )
  ).toBe('/assets/codec.ABCDef12.js');
});

it('rejects oversized asset paths before retaining or logging them', () => {
  const path = `/assets/${'x'.repeat(256)}.ABCDEFGH.js`;
  const logged = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  expect(isAppAssetPath(path)).toBe(false);
  expect(
    pathFromPreloadError(new TypeError(`Failed to fetch dynamically imported module: ${path}`))
  ).toBeNull();
  reportAssetFailure({ path, status: 404, reason: 'invalid-response', source: 'service-worker' });
  expect(assetFailure()).toBeNull();
  expect(logged).not.toHaveBeenCalled();
});

it('owns one observer across root rendering and removes it on disposal', () => {
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  const root = document.createElement('div');
  const dispose = render(() => {
    ownPreloadErrors();
    ownPreloadErrors();
    return document.createElement('div');
  }, root);
  expect(add.mock.calls.filter(([type]) => String(type) === 'vite:preloadError')).toHaveLength(1);
  const event = new Event('vite:preloadError', { cancelable: true }) as Event & {
    payload?: unknown;
  };
  event.payload = new Error(
    'Failed to fetch dynamically imported module: /assets/codec.ABCDef12.js'
  );
  window.dispatchEvent(event);
  expect(assetFailure()?.path).toBe('/assets/codec.ABCDef12.js');
  expect(event.defaultPrevented).toBe(false);
  dispose();
  expect(remove.mock.calls.filter(([type]) => String(type) === 'vite:preloadError')).toHaveLength(
    1
  );
  clearAssetFailure();
  window.dispatchEvent(event);
  expect(assetFailure()).toBeNull();
});

it('replaces unknown preload evidence with the worker response while keeping one notice', () => {
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  setErrorMessage('Primary conversion failure');
  expect(pathFromPreloadError({ message: '/assets/codec.ABCDef12.js' })).toBeNull();
  reportAssetFailure({
    path: null,
    status: null,
    reason: 'preload-rejected',
    source: 'vite-preload',
  });
  reportAssetFailure({
    path: '/assets/codec.ABCDef12.js',
    status: 404,
    reason: 'invalid-response',
    source: 'service-worker',
  });
  expect(assetFailure()).toMatchObject({
    path: '/assets/codec.ABCDef12.js',
    status: 404,
    source: 'service-worker',
  });
  reportAssetFailure({
    path: null,
    status: null,
    reason: 'preload-rejected',
    source: 'vite-preload',
  });
  expect(assetFailure()?.status).toBe(404);
  expect(errorMessage()).toBe('Primary conversion failure');
});

it('keeps a later observed HTTP status after an earlier unknown worker network status', () => {
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  reportAssetFailure({
    path: '/assets/codec.ABCDef12.js',
    status: 0,
    reason: 'network-error',
    source: 'service-worker',
  });
  reportAssetFailure({
    path: '/assets/codec.ABCDef12.js',
    status: 404,
    reason: 'invalid-response',
    source: 'service-worker',
  });
  expect(assetFailure()?.status).toBe(404);
});
