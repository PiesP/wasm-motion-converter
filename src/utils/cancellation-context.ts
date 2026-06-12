// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Cancellation Context Utility
 *
 * Centralised cancellation primitives for conversion operations.
 * Eliminates duplicated cancellation message strings and isCancellationError
 * checks scattered across the codebase.
 */

/** Canonical cancellation error message */
export const CANCELLED_MESSAGE = 'Conversion cancelled by user';

/**
 * Type guard: check whether an error was triggered by a user cancellation.
 *
 * Matches against the canonical message and common variants that may come
 * from AbortController, FFmpeg.terminate(), or worker cancellation.
 */
export function isCancellationError(error: unknown): boolean {
  // Check for DOMException with name 'AbortError' (standard from AbortController)
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }

  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message).toLowerCase()
      : String(error).toLowerCase();

  return (
    message.includes('cancelled by user') ||
    message.includes('conversion cancelled') ||
    message.includes('aborterror') ||
    message.includes('aborted')
  );
}

/**
 * Throw CANCELLED_MESSAGE if the signal has been triggered.
 *
 * @param signal - AbortSignal to check
 * @param guard - Optional additional guard that must be truthy for the throw to occur
 */
export function throwIfAborted(signal: AbortSignal, guard?: boolean): void {
  if (guard !== undefined && !guard) {
    return;
  }
  if (signal.aborted) {
    throw new Error(CANCELLED_MESSAGE);
  }
}

/**
 * Create an AbortError for user-initiated cancellation.
 *
 * Returns a DOMException with name 'AbortError' so that it is correctly
 * identified by isCancellationError() and standard AbortSignal handlers.
 */
export function createUserCancelledAbortError(): DOMException {
  return new DOMException(CANCELLED_MESSAGE, 'AbortError');
}

/**
 * Convenience: create a rejected promise when the signal fires.
 */
export function createAbortPromise(signal?: AbortSignal): Promise<never> {
  if (!signal) {
    return new Promise<never>(() => {
      // Never resolves
    });
  }

  if (signal.aborted) {
    return Promise.reject(new Error(CANCELLED_MESSAGE));
  }

  return new Promise<never>((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error(CANCELLED_MESSAGE));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
