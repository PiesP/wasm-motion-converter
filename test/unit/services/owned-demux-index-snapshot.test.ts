// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it } from 'vitest';

import { fingerprintOwnedDemuxSource } from '@services/owned-demux-index-snapshot';

describe('owned demux source fingerprint', () => {
  it('binds source size and bounded head/tail ranges', async () => {
    const original = new Uint8Array(192 * 1024);
    original[0] = 1;
    original[original.length - 1] = 2;
    const fromBuffer = await fingerprintOwnedDemuxSource(original.buffer);
    const fromBlob = await fingerprintOwnedDemuxSource(new Blob([original]));
    expect(fromBuffer).toBe(fromBlob);
    expect(fromBuffer).toMatch(/^[0-9a-f]{64}$/);

    const changedHead = original.slice();
    changedHead[0] = 3;
    expect(await fingerprintOwnedDemuxSource(changedHead.buffer)).not.toBe(fromBuffer);
    const changedTail = original.slice();
    changedTail[changedTail.length - 1] = 4;
    expect(await fingerprintOwnedDemuxSource(changedTail.buffer)).not.toBe(fromBuffer);
    expect(await fingerprintOwnedDemuxSource(original.slice(0, -1).buffer)).not.toBe(fromBuffer);
  });

  it('rejects a cancelled fingerprint before a source read', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(fingerprintOwnedDemuxSource(new Blob([new Uint8Array(8)]), controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
