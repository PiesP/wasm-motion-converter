// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
//
// Unit tests for sw-register.ts:
//   F36 — Service worker registration logic
//
// Tests cover: feature detection, production registration, lifecycle callbacks
// (updatefound, activation state), visibility-change auto-update, cleanup, and
// error handling. Dev mode tests are omitted because import.meta.env.MODE
// cannot be reliably mocked at the module level in vitest — the production
// logic is the meaningful code path under test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// ---------------------------------------------------------------------------
// ServiceWorker mocks
// ---------------------------------------------------------------------------

interface MockServiceWorkerRegistration {
  scope: string;
  active: ServiceWorker | null;
  installing: ServiceWorker | null;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
}

let mockRegistration: MockServiceWorkerRegistration;

function createMockRegistration(
  overrides: Partial<MockServiceWorkerRegistration> = {}
): MockServiceWorkerRegistration {
  return {
    scope: location.origin + '/',
    active: null,
    installing: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    unregister: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function setupNavigator(): void {
  mockRegistration = createMockRegistration();

  Object.defineProperty(navigator, 'serviceWorker', {
    value: {
      register: vi.fn().mockResolvedValue(mockRegistration),
      getRegistrations: vi.fn().mockResolvedValue([]),
      ready: Promise.resolve(mockRegistration as unknown as ServiceWorkerRegistration),
      controller: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('registerServiceWorker', () => {
  // ── Feature detection ────────────────────────────────────────────

  // ── Production registration ──────────────────────────────────────

  it('registers with module type and correct path in production', async () => {
    setupNavigator();
    const { registerServiceWorker } = await import('@/sw-register');
    await registerServiceWorker();

    expect(navigator.serviceWorker!.register).toHaveBeenCalledWith('/service-worker.js', {
      type: 'module',
    });
  });

  it('returns {supported: true, registered: true} on successful registration', async () => {
    setupNavigator();
    const { registerServiceWorker } = await import('@/sw-register');
    const result = await registerServiceWorker();
    expect(result).toEqual({
      supported: true,
      registered: true,
      cleanup: expect.any(Function),
    });
  });

  it('registration includes cleanup function in result', async () => {
    setupNavigator();
    const { registerServiceWorker } = await import('@/sw-register');
    const result = await registerServiceWorker();
    expect(result.cleanup).toBeDefined();
    expect(typeof result.cleanup).toBe('function');
  });

  // ── Lifecycle callbacks ──────────────────────────────────────────

  it('attaches updatefound listener on registration', async () => {
    setupNavigator();
    const { registerServiceWorker } = await import('@/sw-register');
    await registerServiceWorker();

    expect(mockRegistration.addEventListener).toHaveBeenCalledWith(
      'updatefound',
      expect.any(Function)
    );
  });

  // ── Visibility change auto-update ────────────────────────────────

  it('adds visibilitychange listener on document', async () => {
    setupNavigator();
    const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

    const { registerServiceWorker } = await import('@/sw-register');
    await registerServiceWorker();

    expect(addEventListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('calls registration.update() when page becomes visible', async () => {
    setupNavigator();
    const { registerServiceWorker } = await import('@/sw-register');
    await registerServiceWorker();

    // Dispatch visibilitychange as visible
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(mockRegistration.update).toHaveBeenCalled();
  });

  it('calls registration.update() when visibility becomes visible multiple times', async () => {
    setupNavigator();
    const { registerServiceWorker } = await import('@/sw-register');
    await registerServiceWorker();

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));

    expect(mockRegistration.update).toHaveBeenCalledTimes(2);
  });

  it('does not call registration.update() for hidden visibility', async () => {
    setupNavigator();
    const { registerServiceWorker } = await import('@/sw-register');
    await registerServiceWorker();

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(mockRegistration.update).not.toHaveBeenCalled();
  });

  // ── Cleanup ──────────────────────────────────────────────────────

  it('cleanup removes visibilitychange listener', async () => {
    setupNavigator();
    const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

    const { registerServiceWorker } = await import('@/sw-register');
    const result = await registerServiceWorker();

    result.cleanup!();

    expect(removeEventListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('adds pagehide listener for cleanup on unload', async () => {
    setupNavigator();
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    const { registerServiceWorker } = await import('@/sw-register');
    await registerServiceWorker();

    expect(addEventListenerSpy).toHaveBeenCalledWith('pagehide', expect.any(Function));
  });

  it('cleanup can be called more than once without error', async () => {
    setupNavigator();
    const { registerServiceWorker } = await import('@/sw-register');
    const result = await registerServiceWorker();

    expect(() => {
      result.cleanup!();
      result.cleanup!();
    }).not.toThrow();
  });

  it('accepts unavailable messages only from the current controller and removes the listener on cleanup', async () => {
    setupNavigator();
    const controller = {} as ServiceWorker;
    Object.defineProperty(navigator.serviceWorker, 'controller', {
      value: controller,
      configurable: true,
    });
    const onAssetUnavailable = vi.fn();
    const { registerServiceWorker } = await import('@/sw-register');
    const result = await registerServiceWorker({ onAssetUnavailable });
    const listener = vi
      .mocked(navigator.serviceWorker.addEventListener)
      .mock.calls.find(([type]) => type === 'message')?.[1];
    if (typeof listener !== 'function') throw new Error('Message listener was not registered');
    const dispatch = (source: unknown, data: unknown): void => {
      const event = new Event('message');
      Object.assign(event, { source, data });
      listener(event);
    };
    const data = {
      type: 'dropconvert:asset-unavailable',
      path: '/assets/codec.ABCDef12.js',
      status: 404,
      reason: 'invalid-response',
    };
    dispatch({}, data);
    dispatch(controller, { ...data, path: '/private.mp4' });
    dispatch(controller, { ...data, status: -1 });
    dispatch(controller, { ...data, reason: 'forged' });
    dispatch(controller, { ...data, path: '/assets/codec.ABCDef12.js?private=1' });
    dispatch(controller, { ...data, path: `/assets/${'x'.repeat(256)}.ABCDEFGH.js` });
    expect(onAssetUnavailable).not.toHaveBeenCalled();
    dispatch(controller, data);
    expect(onAssetUnavailable).toHaveBeenCalledTimes(1);
    expect(onAssetUnavailable).toHaveBeenCalledWith({
      path: data.path,
      status: 404,
      reason: 'invalid-response',
      source: 'service-worker',
    });
    result.cleanup?.();
    dispatch(controller, data);
    expect(onAssetUnavailable).toHaveBeenCalledTimes(1);
    expect(navigator.serviceWorker.removeEventListener).toHaveBeenCalledWith('message', listener);
    expect(mockRegistration.removeEventListener).toHaveBeenCalledWith(
      'updatefound',
      expect.any(Function)
    );
  });

  // ── Error handling ───────────────────────────────────────────────

  it('keeps the observer through BFCache restoration and removes it on final departure', async () => {
    setupNavigator();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    const { registerServiceWorker } = await import('@/sw-register');
    await registerServiceWorker();
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    expect(mockRegistration.removeEventListener).not.toHaveBeenCalled();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(mockRegistration.update).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(mockRegistration.update).toHaveBeenCalledTimes(1);
  });

  it('observes an installation already in progress once and distinguishes first activation from an update', async () => {
    setupNavigator();
    const worker = new EventTarget();
    Object.assign(worker, { state: 'installing' });
    mockRegistration.installing = worker as ServiceWorker;
    const onUpdate = vi.fn();
    const onOfflineReady = vi.fn();
    const { registerServiceWorker } = await import('@/sw-register');
    const registration = await registerServiceWorker({ onUpdate, onOfflineReady });
    const updatefound = mockRegistration.addEventListener.mock.calls.find(
      ([type]) => type === 'updatefound'
    )?.[1];
    updatefound();
    updatefound();
    Object.assign(worker, { state: 'activated' });
    worker.dispatchEvent(new Event('statechange'));
    worker.dispatchEvent(new Event('statechange'));
    expect(onOfflineReady).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();
    const nextWorker = new EventTarget();
    Object.assign(nextWorker, { state: 'installing' });
    mockRegistration.installing = nextWorker as ServiceWorker;
    updatefound();
    Object.assign(nextWorker, { state: 'activated' });
    nextWorker.dispatchEvent(new Event('statechange'));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    registration.cleanup?.();
  });

  it('returns {supported: true, registered: false} when registration throws', async () => {
    setupNavigator();
    navigator.serviceWorker!.register = vi.fn().mockRejectedValue(new Error('Network error'));

    const { registerServiceWorker } = await import('@/sw-register');
    const result = await registerServiceWorker();
    expect(result).toEqual({ supported: true, registered: false });
  });
});
