// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Cancellation Context Utility
 *
 * Centralised cancellation primitives for conversion operations.
 */

/**
 * Type guard: check whether an error was triggered by a user cancellation.
 */
export function isCancellationError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message).toLowerCase()
      : String(error).toLowerCase();

  // Only match explicit cancellation phrases — avoid matching generic "aborted"
  // which can appear in legitimate decoding errors (e.g., "decoding aborted").
  return (
    message.includes('cancelled by user') ||
    message.includes('conversion cancelled') ||
    message.includes('aborterror')
  );
}
