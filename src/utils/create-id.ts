/**
 * ID generation utility
 *
 * Provides a cross-browser way to generate collision-resistant IDs.
 * Prefers `crypto.randomUUID()` when available and falls back to a timestamp-based
 * ID for older browsers/contexts.
 */
export function createId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) {
      return uuid;
    }
  } catch {
    // Ignore and fall back below
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
