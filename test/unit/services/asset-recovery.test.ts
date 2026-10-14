import { errorMessage, setErrorMessage } from '@stores/conversion-store';
import { logger } from '@utils/logger';
import { afterEach, expect, it, vi } from 'vitest';
import {
  assetFailure,
  clearAssetFailure,
  observePreloadErrors,
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
});

it('observes a real Vite event without cancelling its normal rejection', () => {
  const logged = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  stop = observePreloadErrors();
  const event = new Event('vite:preloadError', { cancelable: true }) as Event & {
    payload?: unknown;
  };
  event.payload = new TypeError(
    'Failed to fetch dynamically imported module: https://example.test/assets/codec.ABCDef12.js?token=private'
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
