// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { OwnedVp8MemoryAdmissionError } from './owned-vp8-memory-admission-error';

export { OwnedVp8MemoryAdmissionError };

export class OwnedVp8LoadError extends Error {
  override name = 'OwnedVp8LoadError';
}
export class OwnedVp8AbiError extends Error {
  override name = 'OwnedVp8AbiError';
}
export class OwnedVp8InitializationAbiError extends OwnedVp8AbiError {
  override name = 'OwnedVp8InitializationAbiError';
}
export class OwnedVp8InvalidInputError extends Error {
  override name = 'OwnedVp8InvalidInputError';
}
export class OwnedVp8UnsupportedLayoutError extends Error {
  override name = 'OwnedVp8UnsupportedLayoutError';
}
export class OwnedVp8UnsupportedPixelsError extends Error {
  override name = 'OwnedVp8UnsupportedPixelsError';
}
export class OwnedVp8OutputLimitError extends Error {
  override name = 'OwnedVp8OutputLimitError';
}
export class OwnedVp8PartitionLimitError extends Error {
  override name = 'OwnedVp8PartitionLimitError';
}
export class OwnedVp8TrapError extends Error {
  override name = 'OwnedVp8TrapError';
}
export class OwnedVp8CancelledError extends Error {
  override name = 'OwnedVp8CancelledError';
}
export class OwnedVp8BusyError extends Error {
  override name = 'OwnedVp8BusyError';
}

export const OWNED_VP8_FAILURE_CODES = {
  'invalid-input': 'ENCODER_ERROR',
  'unsupported-layout': 'ENCODER_ERROR',
  'unsupported-pixels': 'ENCODER_ERROR',
  resource: 'OUT_OF_MEMORY',
  'output-limit': 'OUT_OF_MEMORY',
  'partition-limit': 'ENCODER_ERROR',
  abi: 'ENCODER_ERROR',
  'abi-initialization': 'ENCODER_ERROR',
  load: 'ENCODER_ERROR',
  trap: 'ENCODER_ERROR',
  busy: 'ENCODER_ERROR',
} as const;

export type OwnedVp8FailureKind = keyof typeof OWNED_VP8_FAILURE_CODES;

export function isOwnedVp8FailureKind(value: unknown): value is OwnedVp8FailureKind {
  return typeof value === 'string' && Object.hasOwn(OWNED_VP8_FAILURE_CODES, value);
}

type OwnedVp8Failure = OwnedVp8FailureKind | 'cancelled';

type ErrorConstructor = abstract new (...args: never[]) => Error;

const failureTypes: ReadonlyArray<readonly [ErrorConstructor, OwnedVp8Failure]> = [
  [OwnedVp8InvalidInputError, 'invalid-input'],
  [OwnedVp8UnsupportedLayoutError, 'unsupported-layout'],
  [OwnedVp8UnsupportedPixelsError, 'unsupported-pixels'],
  [OwnedVp8MemoryAdmissionError, 'resource'],
  [OwnedVp8OutputLimitError, 'output-limit'],
  [OwnedVp8PartitionLimitError, 'partition-limit'],
  [OwnedVp8InitializationAbiError, 'abi-initialization'],
  [OwnedVp8AbiError, 'abi'],
  [OwnedVp8LoadError, 'load'],
  [OwnedVp8TrapError, 'trap'],
  [OwnedVp8BusyError, 'busy'],
  [OwnedVp8CancelledError, 'cancelled'],
];

export function ownedVp8FailureKind(error: Error): OwnedVp8Failure | undefined {
  return failureTypes.find(([ErrorType]) => error instanceof ErrorType)?.[1];
}

/** The streaming decoder wraps producer failures with the original cause. */
export function findOwnedVp8FailureKind(error: unknown): OwnedVp8Failure | undefined {
  const seen = new Set<Error>();
  let current = error;
  for (let depth = 0; depth < 16 && current instanceof Error && !seen.has(current); depth++) {
    const kind = ownedVp8FailureKind(current);
    if (kind !== undefined) return kind;
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}
