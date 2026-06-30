// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Shared TypeScript type-narrowing utilities.
 *
 * @module
 */

/**
 * Validate a value is a member of a readonly array (type-narrowing guard).
 *
 * Works with string or number tuples. Returns `true` and narrows the type
 * when the value is found in the allowed array.
 *
 * @typeParam T - The element type of the tuple (string or number)
 * @param value - The value to check
 * @param allowed - Readonly array of allowed values
 * @returns `true` if value is in allowed, narrowing `value is T`
 *
 * @example
 * ```ts
 * const FORMATS = ['gif', 'webp'] as const;
 * const val: unknown = 'gif';
 * if (isInTuple(val, FORMATS)) {
 *   // val is 'gif' | 'webp'
 * }
 * ```
 */
export function isInTuple<T extends string | number>(
  value: unknown,
  allowed: readonly T[]
): value is T {
  return allowed.includes(value as T);
}
