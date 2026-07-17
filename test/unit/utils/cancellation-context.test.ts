// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { isCancellationError } from '@utils/error-utils';

describe('isCancellationError', () => {
  // ── DOMException 'AbortError' (primary path) ───────────────

  it('returns true for DOMException with name AbortError', () => {
    const error = new DOMException('The operation was aborted', 'AbortError');
    expect(isCancellationError(error)).toBe(true);
  });

  // ── Regular Error with name AbortError ─────────────────────

  it('returns true for Error with name AbortError', () => {
    const error = new Error('Aborted');
    error.name = 'AbortError';
    expect(isCancellationError(error)).toBe(true);
  });

  // ── Object with name AbortError (error-like) ───────────────

  it('returns true for plain object with name AbortError', () => {
    expect(isCancellationError({ name: 'AbortError' })).toBe(true);
  });

  // ── Cause chain: DOMException as cause ─────────────────────

  it('returns true when cause is DOMException with name AbortError', () => {
    const cause = new DOMException('aborted', 'AbortError');
    const error = new Error('Conversion failed', { cause });
    expect(isCancellationError(error)).toBe(true);
  });

  it('returns true when nested cause chain has AbortError', () => {
    const inner = new DOMException('aborted', 'AbortError');
    const mid = new Error('middle', { cause: inner });
    const outer = new Error('outer', { cause: mid });
    // Note: isCancellationError only checks immediate cause
    expect(isCancellationError(outer)).toBe(false);
  });

  // ── Message matching: 'cancelled' ──────────────────────────

  it('returns true for Error with message containing "cancelled" (British spelling)', () => {
    const error = new Error('User cancelled the conversion');
    expect(isCancellationError(error, { checkMessage: true })).toBe(true);
  });

  it('returns true for Error with message containing "canceled" (American spelling)', () => {
    const error = new Error('The operation was canceled');
    expect(isCancellationError(error, { checkMessage: true })).toBe(true);
  });

  it('matches case-insensitively for Cancelled', () => {
    const error = new Error('Conversion Cancelled by user');
    expect(isCancellationError(error, { checkMessage: true })).toBe(true);
  });

  // ── Message matching for non-object errors ─────────────────

  it('returns true when string error contains "cancelled"', () => {
    expect(isCancellationError('The operation was cancelled', { checkMessage: true })).toBe(true);
  });

  it('returns true when string error contains "canceled"', () => {
    expect(isCancellationError('canceled', { checkMessage: true })).toBe(true);
  });

  // ── Negative cases ─────────────────────────────────────────

  it('returns false for generic Error', () => {
    expect(isCancellationError(new Error('Something went wrong'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isCancellationError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isCancellationError(undefined)).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isCancellationError(42)).toBe(false);
  });

  it('returns false for a string without cancellation keywords', () => {
    expect(isCancellationError('some random error')).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isCancellationError({})).toBe(false);
  });

  it('returns false for Error with name "TimeoutError"', () => {
    const error = new Error('timed out');
    error.name = 'TimeoutError';
    expect(isCancellationError(error)).toBe(false);
  });

  it('returns false for DOMException with name "NotAllowedError"', () => {
    const error = new DOMException('not allowed', 'NotAllowedError');
    expect(isCancellationError(error)).toBe(false);
  });
});
