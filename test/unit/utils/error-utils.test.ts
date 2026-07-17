// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { describe, it, expect } from 'vitest';
import { getErrorMessage } from '@utils/error-utils';

describe('getErrorMessage', () => {
  it('extracts message from Error instances', () => {
    expect(getErrorMessage(new Error('test error'))).toBe('test error');
    expect(getErrorMessage(new TypeError('type error'))).toBe('type error');
    expect(getErrorMessage(new RangeError('range error'))).toBe('range error');
  });

  it('extracts message from objects with message property', () => {
    expect(getErrorMessage({ message: 'custom error' })).toBe('custom error');
    expect(getErrorMessage({ message: '', code: 404 })).toBe('');
  });

  it('returns string errors as-is', () => {
    expect(getErrorMessage('string error')).toBe('string error');
    expect(getErrorMessage('')).toBe('');
  });

  it('converts null and undefined to string', () => {
    expect(getErrorMessage(null)).toBe('null');
    expect(getErrorMessage(undefined)).toBe('undefined');
  });

  it('converts numbers and booleans to string', () => {
    expect(getErrorMessage(42)).toBe('42');
    expect(getErrorMessage(true)).toBe('true');
    expect(getErrorMessage(false)).toBe('false');
  });

  it('handles objects without message property', () => {
    expect(getErrorMessage({ code: 500 })).toBe('[object Object]');
  });

  it('prefers message property over Error instance check', () => {
    const error = new Error('native error');
    (error as unknown as Record<string, unknown>).message = 'overridden';
    expect(getErrorMessage(error)).toBe('overridden');
  });

  it('handles nested error-like objects', () => {
    expect(getErrorMessage({ message: { nested: 'object' } })).toBe('[object Object]');
  });
});
