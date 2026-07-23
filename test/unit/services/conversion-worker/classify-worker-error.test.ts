// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { classifyWorkerError } from '@services/conversion-worker/classify-worker-error';

describe('classifyWorkerError', () => {
  it('recognizes a libavif encoder failure', () => {
    expect(classifyWorkerError('AVIF frame encoding failed: Encoding of color planes failed')).toBe(
      'ENCODER_ERROR'
    );
  });

  it('keeps an explicit AVIF memory failure classified as out of memory', () => {
    expect(classifyWorkerError('AVIF frame encoding failed: out of memory')).toBe('OUT_OF_MEMORY');
  });

  it('classifies opaque Emscripten AVIF exceptions as memory failures', () => {
    expect(classifyWorkerError('Frame processing failed: {"excPtr":1087288}', 'avif')).toBe(
      'OUT_OF_MEMORY'
    );
  });

  it('does not classify an opaque non-AVIF exception as memory exhaustion', () => {
    expect(classifyWorkerError('Frame processing failed: {"excPtr":1087288}', 'webp')).toBe(
      'UNKNOWN'
    );
  });
});
