// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * @fileoverview GIF Encoder Service tests
 * Tests module-level constants and import integrity.
 * The main encodeGif function requires WebCodecs APIs and is E2E-only.
 */
import { describe, expect, it } from 'vitest';

describe('gif-encoder-service (module integrity)', () => {
  it('imports successfully', async () => {
    const mod = await import('@services/gif-encoder-service');
    expect(mod).toBeDefined();
    expect(typeof mod.encodeGif).toBe('function');
  });

  it('exports encodeGif as an async function', async () => {
    const { encodeGif } = await import('@services/gif-encoder-service');
    // encodeGif should be an async function (returns Promise)
    expect(encodeGif.constructor.name).toBe('AsyncFunction');
  });
});
