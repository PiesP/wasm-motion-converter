// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { readFileSync } from 'node:fs';

import { buildConversionRequest } from '@services/conversion-worker/build-conversion-request';
import { demuxVideo } from '@services/demuxer-service';
import { OwnedDemuxSession } from '@services/owned-demux-session';
import {
  beginOwnedInputSelection,
  clearOwnedInputSelection,
  publishOwnedInputIndex,
} from '@services/owned-input-index-cache';
import { ENCODED_PACKET_BUDGET_BYTES, MP4_METADATA_BUDGET_BYTES } from '@utils/constants';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const wasmBytes = Uint8Array.from(
  readFileSync(new URL('../../../src/services/owned-demux.wasm', import.meta.url))
);
const fixtureBytes = Buffer.from(
  readFileSync(
    new URL('../../fixtures/owned-demux/avc-baseline.mp4.base64', import.meta.url),
    'utf8'
  ),
  'base64'
);
const admission = {
  packetCount: Math.floor(MP4_METADATA_BUDGET_BYTES / 48),
  maxPacketBytes: ENCODED_PACKET_BUDGET_BYTES - 1024,
  descriptionBytes: 1024 * 1024,
};

afterEach(() => {
  clearOwnedInputSelection();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('selected index admission before conversion', () => {
  it.each([
    { name: 'default zero trim', snapshotBytes: 8 * 1024 * 1024, trimStart: 0 },
    { name: 'nonzero trim seek', snapshotBytes: 3 * 1024 * 1024, trimStart: 0.001 },
  ])('evicts a near-limit $name cache and parses the source exactly once', async (case_) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(wasmBytes, { headers: { 'content-type': 'application/wasm' } })
      )
    );
    const source = new Blob([fixtureBytes]);
    const generation = beginOwnedInputSelection(source);
    expect(
      publishOwnedInputIndex(
        source,
        generation,
        new ArrayBuffer(case_.snapshotBytes),
        'a'.repeat(64),
        undefined,
        admission
      )
    ).toBe(true);
    const analyze = vi.spyOn(OwnedDemuxSession.prototype, 'analyze');
    const request = buildConversionRequest(
      undefined,
      {
        format: 'gif',
        quality: 'medium',
        fps: 30,
        scale: 1,
        trimStart: case_.trimStart,
        trimEnd: 10,
        smartFrameSkip: 'off',
        maxFrames: 100,
        maxOutputBytes: 1024,
      },
      undefined,
      source
    );
    expect(request).not.toHaveProperty('indexSnapshot');
    const result = await demuxVideo(request);
    expect(result.indexRoute).toBe('parsed');
    expect(analyze).toHaveBeenCalledTimes(1);
    result.dispose?.();
  });
});
