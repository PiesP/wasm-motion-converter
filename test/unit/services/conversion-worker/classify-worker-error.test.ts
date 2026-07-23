// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { classifyWorkerError } from '@services/conversion-worker/classify-worker-error';

describe('classifyWorkerError', () => {
  it('recognizes a WebP encoder failure', () => {
    expect(classifyWorkerError('WebP frame encoding failed')).toBe(
      'ENCODER_ERROR'
    );
  });

  it('classifies opaque worker exceptions as unknown', () => {
    expect(classifyWorkerError('Frame processing failed: {"excPtr":1087288}')).toBe('UNKNOWN');
  });
});
