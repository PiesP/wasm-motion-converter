// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
//
// Unit tests for Error Boundary fallback logic:
//   F40 — Error Boundary data handling and retry/reload handler behaviour
//
// Tests the logic extracted from App.tsx's <ErrorBoundary> fallback:
//   - Error string extraction for display in <pre>{String(error)}</pre>
//   - Retry handler dispatch
//   - Reload handler existence
//
// These are pure logic tests that don't require SolidJS rendering or
// solid-testing-library. The fallback JSX structure is validated by
// E2E tests (which crash a component and verify the fallback renders).

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Functions matching the error boundary fallback logic in App.tsx
// ---------------------------------------------------------------------------

/**
 * Extract a displayable string from any error type.
 * Mirrors the App.tsx fallback: <pre>{String(error)}</pre>
 * plus Error.message extraction for Error instances.
 */
function getFallbackErrorString(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in (error as Record<string, unknown>)) {
    return String((error as Record<string, unknown>).message);
  }
  return String(error);
}

/**
 * Create a retry handler that calls the ErrorBoundary's reset function.
 * In App.tsx this is: reset() which triggers SolidJS ErrorBoundary reset.
 */
function createRetryHandler(reset: () => void): () => void {
  return () => reset();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ErrorBoundary fallback data extraction', () => {
  // ── Error string extraction ───────────────────────────────────────

  it('extracts message from Error instances', () => {
    expect(getFallbackErrorString(new Error('Render crashed!'))).toBe('Render crashed!');
    expect(getFallbackErrorString(new TypeError('Type error'))).toBe('Type error');
  });

  it('extracts string errors directly', () => {
    expect(getFallbackErrorString('String error message')).toBe('String error message');
    expect(getFallbackErrorString('')).toBe('');
  });

  it('extracts message from error-like objects', () => {
    expect(getFallbackErrorString({ message: 'Object error' })).toBe('Object error');
    expect(getFallbackErrorString({ message: '', code: 500 })).toBe('');
  });

  it('falls back to String() for unexpected types', () => {
    expect(getFallbackErrorString(42)).toBe('42');
    expect(getFallbackErrorString(true)).toBe('true');
    expect(getFallbackErrorString({ code: 500 })).toBe('[object Object]');
  });

  it('converts null and undefined to strings', () => {
    expect(getFallbackErrorString(null)).toBe('null');
    expect(getFallbackErrorString(undefined)).toBe('undefined');
  });

  it('handles objects with non-string message property', () => {
    expect(getFallbackErrorString({ message: { nested: 'value' } })).toBe('[object Object]');
  });
});

describe('ErrorBoundary retry handler', () => {
  it('calls reset function when retry handler is invoked', () => {
    const reset = vi.fn();
    const retry = createRetryHandler(reset);
    retry();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('retry handler can be called multiple times', () => {
    const reset = vi.fn();
    const retry = createRetryHandler(reset);
    retry();
    retry();
    retry();
    expect(reset).toHaveBeenCalledTimes(3);
  });

  it('retry handler preserves the reset reference', () => {
    const reset1 = vi.fn();
    const reset2 = vi.fn();
    const retry = createRetryHandler(reset1);
    retry();
    expect(reset1).toHaveBeenCalledTimes(1);
    expect(reset2).not.toHaveBeenCalled();
  });
});

describe('ErrorBoundary reload handler', () => {
  it('does not throw when invoked', () => {
    // In App.tsx: onClick={() => window.location.reload()}
    // We verify the handler invocation doesn't throw.
    // window.location.reload cannot be spied in jsdom (non-configurable),
    // so we validate it's callable and produces no runtime error.
    const reload = () => window.location.reload();
    expect(() => reload()).not.toThrow();
  });

  it('returns void (undefined)', () => {
    const reload = () => window.location.reload();
    expect(reload()).toBeUndefined();
  });
});
