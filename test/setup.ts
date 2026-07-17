// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP
//
// Global test setup for wasm-motion-converter
// - DOM polyfills for jsdom gaps
// - Logger mock (silences logs during tests)
// - Browser API stubs

import { vi } from 'vitest';

// ── DOM Polyfills ─────────────────────────────────────────────

// requestAnimationFrame / cancelAnimationFrame
const rafCallbacks = new Map<number, () => void>();
let rafId = 0;

Object.defineProperty(window, 'requestAnimationFrame', {
  value: (cb: FrameRequestCallback): number => {
    const id = ++rafId;
    rafCallbacks.set(id, () => cb(performance.now()));
    setTimeout(() => {
      const cb = rafCallbacks.get(id);
      if (cb) {
        cb();
        rafCallbacks.delete(id);
      }
    }, 16);
    return id;
  },
  writable: true,
});

Object.defineProperty(window, 'cancelAnimationFrame', {
  value: (id: number): void => {
    rafCallbacks.delete(id);
  },
  writable: true,
});

// ResizeObserver
class MockResizeObserver {
  observe(): void {
    /* noop */
  }
  unobserve(): void {
    /* noop */
  }
  disconnect(): void {
    /* noop */
  }
}
Object.defineProperty(window, 'ResizeObserver', {
  value: MockResizeObserver,
  writable: true,
});

// IntersectionObserver
class MockIntersectionObserver {
  constructor(
    _callback: IntersectionObserverCallback,
    _options?: IntersectionObserverInit
  ) {
    // noop
  }
  observe(): void {
    /* noop */
  }
  unobserve(): void {
    /* noop */
  }
  disconnect(): void {
    /* noop */
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  readonly root: Element | null = null;
  readonly rootMargin = '0px';
  readonly thresholds: ReadonlyArray<number> = [0];
}
Object.defineProperty(window, 'IntersectionObserver', {
  value: MockIntersectionObserver,
  writable: true,
});

// matchMedia
Object.defineProperty(window, 'matchMedia', {
  value: (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {
      /* deprecated */
    },
    removeListener: () => {
      /* deprecated */
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
  writable: true,
});

// ── Logger Mock ───────────────────────────────────────────────

vi.mock('@utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Virtual CDN Module Mock ───────────────────────────────────

vi.mock('virtual:cdn-deps', () => ({
  esmShModuleUrl: 'https://esm.sh/mock-module',
}));

// Mock cdn-config to prevent virtual:cdn-deps resolution failure in jsdom
vi.mock('@utils/cdn-config', () => ({
  getRuntimeDepVersion: () => '0.12.10',
  getCDNProviders: () => [],
  esmShModuleUrl: 'https://esm.sh/mock',
}));

// ── Lifecycle Hooks ───────────────────────────────────────────

beforeEach(() => {
  if (typeof document !== 'undefined') {
    document.body.innerHTML = '';
  }
});
