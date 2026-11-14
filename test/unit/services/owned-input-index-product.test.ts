// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { demuxVideo } from '@services/demuxer-service';
import {
  beginOwnedInputSelection,
  clearOwnedInputSelection,
  copyOwnedInputIndex,
} from '@services/owned-input-index-cache';
import { extractVideoMetadata } from '@services/video-metadata';
import type { ConversionRequest } from '@t/conversion-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

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
const fixture = JSON.parse(
  readFileSync(new URL('../../fixtures/owned-demux/oracle.json', import.meta.url), 'utf8')
).fixtures.find((entry: { id: string }) => entry.id === 'avc-baseline.mp4') as {
  packets: Array<{ timestampUs: number; durationUs: number; sha256: string }>;
};

class CapturedChunk {
  readonly timestamp: number;
  readonly duration: number;
  readonly data: ArrayBuffer;
  constructor(init: EncodedVideoChunkInit) {
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? 0;
    this.data = init.data as ArrayBuffer;
  }
}

const requestFor = (source: Blob): ConversionRequest => ({
  inputBlob: source,
  fileName: 'avc-baseline.mp4',
  format: 'gif',
  quality: 'medium',
  scale: 1,
  trimStart: 0,
  trimEnd: 0,
  maxMemoryMB: 512,
});

async function packetTrace(result: Awaited<ReturnType<typeof demuxVideo>>) {
  const trace = [];
  for await (const encoded of result.chunks) {
    const packet = encoded as unknown as CapturedChunk;
    trace.push({
      timestampUs: packet.timestamp,
      durationUs: packet.duration,
      sha256: createHash('sha256').update(new Uint8Array(packet.data)).digest('hex'),
    });
  }
  return trace;
}

describe('actual compiled selected-input index route', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(wasmBytes, { headers: { 'content-type': 'application/wasm' } })
      )
    );
    vi.stubGlobal('EncodedVideoChunk', CapturedChunk);
  });
  afterEach(() => {
    clearOwnedInputSelection();
    vi.unstubAllGlobals();
  });

  it('imports the same checked metadata index for repeated conversions with exact packet bytes', async () => {
    const source = new Blob([fixtureBytes]);
    beginOwnedInputSelection(source);
    const metadata = await extractVideoMetadata(source);
    expect(metadata.framerate).toBe(6);
    const first = copyOwnedInputIndex(source)!;
    const second = copyOwnedInputIndex(source)!;
    expect(first.bytes.byteLength).toBeGreaterThan(96);
    expect(first.bytes).not.toBe(second.bytes);
    const expected = fixture.packets.map(({ timestampUs, durationUs, sha256 }) => ({
      timestampUs,
      durationUs,
      sha256,
    }));
    for (const indexSnapshot of [first, second]) {
      const result = await demuxVideo({ ...requestFor(source), indexSnapshot }, metadata);
      expect(result.indexRoute).toBe('imported');
      expect(result.indexSnapshotBytes).toBe(indexSnapshot.bytes.byteLength);
      expect(result.inputBufferBytes).toBe(0);
      expect(await packetTrace(result)).toEqual(expected);
    }
  });

  const admitted = JSON.parse(
    readFileSync(new URL('../../fixtures/owned-demux/oracle.json', import.meta.url), 'utf8')
  ).fixtures as Array<{
    id: string;
    duration: number;
    stats: { averagePacketRate: number; averageBitrate: number };
    packets: Array<{ timestampUs: number; durationUs: number; sha256: string }>;
  }>;
  for (const entry of admitted) {
    it(`preserves metadata and imported product demux packets: ${entry.id}`, async () => {
      const bytes = Buffer.from(
        readFileSync(
          new URL(`../../fixtures/owned-demux/${entry.id}.base64`, import.meta.url),
          'utf8'
        ),
        'base64'
      );
      const source = new Blob([bytes]);
      beginOwnedInputSelection(source);
      const metadata = await extractVideoMetadata(source);
      expect(metadata.duration).toBe(entry.duration);
      expect(metadata.framerate).toBe(Math.round(entry.stats.averagePacketRate * 100) / 100);
      expect(metadata.bitrate).toBe(Math.round(entry.stats.averageBitrate));
      const indexSnapshot = copyOwnedInputIndex(source);
      expect(indexSnapshot).not.toBeNull();
      const result = await demuxVideo(
        { ...requestFor(source), indexSnapshot: indexSnapshot! },
        metadata
      );
      expect(result.indexRoute).toBe('imported');
      expect(await packetTrace(result)).toEqual(
        entry.packets.map(({ timestampUs, durationUs, sha256 }) => ({
          timestampUs,
          durationUs,
          sha256,
        }))
      );
    });
  }

  it('treats a different source token as a pre-use miss and a malformed import as terminal', async () => {
    const source = new Blob([fixtureBytes]);
    beginOwnedInputSelection(source);
    const metadata = await extractVideoMetadata(source);
    const copied = copyOwnedInputIndex(source)!;
    const miss = await demuxVideo(
      { ...requestFor(source), indexSnapshot: { ...copied, fingerprint: 'b'.repeat(64) } },
      metadata
    );
    expect(miss.indexRoute).toBe('parsed');
    expect(await packetTrace(miss)).toHaveLength(fixture.packets.length);
    const damaged = copied.bytes.slice(0);
    const damagedBytes = new Uint8Array(damaged);
    damagedBytes[damagedBytes.length - 1] = damagedBytes[damagedBytes.length - 1]! ^ 1;
    await expect(
      demuxVideo({ ...requestFor(source), indexSnapshot: { ...copied, bytes: damaged } }, metadata)
    ).rejects.toBeInstanceOf(Error);
  });
});
