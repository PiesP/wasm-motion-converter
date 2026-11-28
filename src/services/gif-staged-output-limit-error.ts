// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export class GifStagedOutputLimitError extends Error {
  constructor(readonly limitMiB: number) {
    super(`Staged GIF output exceeds the ${limitMiB} MiB limit`);
    this.name = 'GifStagedOutputLimitError';
  }
}
