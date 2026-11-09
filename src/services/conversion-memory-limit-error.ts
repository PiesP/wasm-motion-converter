// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** A conversion-owned memory estimate refused work before another allocation. */
export class ConversionMemoryLimitError extends Error {
  readonly code = 'OUT_OF_MEMORY' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ConversionMemoryLimitError';
  }
}
