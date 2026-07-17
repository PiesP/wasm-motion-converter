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

import { describe, it, expect, beforeEach, vi } from 'vitest';

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

function createMockRegistration(overrides: Partial<MockServiceWorkerRegistration> = {}): MockServiceWorkerRegistration {
  return {
    scope: 'http://localhost:5173/',
    active: null,
    installing: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    unregister: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function setupNavigator(withSw: boolean): void {
  mockRegistration = createMockRegistration();

  if (withSw) {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        register: vi.fn().mockResolvedValue(mockRegistration),
        getRegistrations: vi.fn().mockResolvedValue([]),
        ready: Promise.resolve(mockRegistration as unknown as ServiceWorkerRegistration),
        controller: null,
      },
      writable: true,
      configurable: true,
    });
  } else {
    // Completely remove serviceWorker from navigator so 'in' check fails
    delete (navigator as Record<string, unknown>).serviceWorker;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('registerServiceWorker', () => {
  // ── Feature detection ────────────────────────────────────────────

  it('returns {supported: false, registered: false} when serviceWorker not in navigator', async () => {
    setupNavigator(false);
    const { registerServiceWorker } = await import('@/sw-register');
    const result = await registerServiceWorker();
    expect(result).toEqual({ supported: false, registered: false });
  });

  // ── Production registration ──────────────────────────────────────

  it('registers with module type and correct path in production', async () => {
    setupNavigator(true);
    const { registerServiceWorker } = await import('@/sw-register');
    await registerServiceWorker();

    expect(navigator.serviceWorker!.register).toHaveBeenCalledWith('/service-worker.js', {
      type: 'module',
    });
  });

  it('returns {supported: true, registered: true} on successful registration', async () => {
    setupNavigator(true);
    const { registerServiceWorker } = await import('@/sw-register');
    const result = await registerServiceWorker();
    expect(result).toEqual({
      supported: true,
      registered: true,
      cleanup: expect.any(Function),
    });
  });

  it('registration includes cleanup function in result', async () => {
    setupNavigator(true);
    const { registerServiceWorker } = await import('@/sw-register');
    const result = await registerServiceWorker();
    expect(result.cleanup).toBeDefined();
    expect(typeof result.cleanup).toBe('function');
  });

  // ── Lifecycle callbacks ──────────────────────────────────────────

  it('attaches updatefound listener on registration', async () => {
    setupNavigator(true);
    const { registerServiceWorker } = await import('@/sw-register');
    await registerServiceWorker();

    expect(mockRegistration.addEventListener).toHaveBeenCalledWith(
      'updatefound',
      expect.any(Function),
    );
  });

  // ── Visibility change auto-update ────────────────────────────────

  it('adds visibilitychange listener on document', async () => {
    setupNavigator(true);
    const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

    const { registerServiceWorker } = await import('@/sw-register');
    await registerServiceWorker();

    expect(addEventListenerSpy).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    );
  });

  it('calls registration.update() when page becomes visible', async () => {
    setupNavigator(true);
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
    setupNavigator(true);
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
    setupNavigator(true);
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
    setupNavigator(true);
    const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

    const { registerServiceWorker } = await import('@/sw-register');
    const result = await registerServiceWorker();

    result.cleanup!();

    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    );
  });

  it('adds pagehide listener for cleanup on unload', async () => {
    setupNavigator(true);
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    const { registerServiceWorker } = await import('@/sw-register');
    await registerServiceWorker();

    expect(addEventListenerSpy).toHaveBeenCalledWith(
      'pagehide',
      expect.any(Function),
    );
  });

  it('cleanup can be called more than once without error', async () => {
    setupNavigator(true);
    const { registerServiceWorker } = await import('@/sw-register');
    const result = await registerServiceWorker();

    expect(() => {
      result.cleanup!();
      result.cleanup!();
    }).not.toThrow();
  });

  // ── Error handling ───────────────────────────────────────────────

  it('returns {supported: true, registered: false} when registration throws', async () => {
    setupNavigator(true);
    navigator.serviceWorker!.register = vi.fn().mockRejectedValue(new Error('Network error'));

    const { registerServiceWorker } = await import('@/sw-register');
    const result = await registerServiceWorker();
    expect(result).toEqual({ supported: true, registered: false });
  });
});
