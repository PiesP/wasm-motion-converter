// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { demuxVideo } from '@services/demuxer-service';
import { extractVideoMetadata } from '@services/video-metadata';
import type { ConversionRequest } from '@t/conversion-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const wasmBytes = Uint8Array.from(
  readFileSync(new URL('../../../src/services/owned-demux.wasm', import.meta.url))
);
const oracle = JSON.parse(
  readFileSync(new URL('../../fixtures/owned-demux/oracle.json', import.meta.url), 'utf8')
) as {
  fixtures: Array<{
    id: string;
    packets: Array<{ timestampUs: number; durationUs: number; sha256: string }>;
  }>;
};
function fixture(id: string): Blob {
  const text = readFileSync(
    new URL(`../../fixtures/owned-demux/${id}.base64`, import.meta.url),
    'utf8'
  );
  return new Blob([Uint8Array.from(Buffer.from(text, 'base64'))]);
}
class TestEncodedVideoChunk {
  readonly type: string;
  readonly timestamp: number;
  readonly duration: number;
  readonly byteLength: number;
  readonly data: ArrayBuffer;
  constructor(init: EncodedVideoChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? 0;
    this.data = init.data as ArrayBuffer;
    this.byteLength = this.data.byteLength;
  }
}

describe('actual compiled owned demux product routes', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(wasmBytes, { headers: { 'content-type': 'application/wasm' } })
      )
    );
    vi.stubGlobal('EncodedVideoChunk', TestEncodedVideoChunk);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('extracts the baseline track and bounded packet statistics', async () => {
    const metadata = await extractVideoMetadata(fixture('avc-baseline.mp4'));
    expect(metadata).toMatchObject({
      width: 96,
      height: 64,
      duration: 2,
      codec: 'avc1',
      framerate: 6,
      bitrate: 38_684,
      rotation: 0,
    });
    expect(metadata.config).toMatchObject({ codec: 'avc1.42c00a' });
  });

  it('streams B-frame dependencies after trimEnd in decode order', async () => {
    const source = fixture('avc-bframes.mp4');
    const request: ConversionRequest = {
      inputBlob: source,
      fileName: 'avc-bframes.mp4',
      format: 'gif',
      quality: 'medium',
      scale: 1,
      trimStart: 1.2,
      trimEnd: 1.3,
      maxMemoryMB: 512,
    };
    const result = await demuxVideo(request);
    const expected = oracle.fixtures
      .find((value) => value.id === request.fileName)!
      .packets.slice(6);
    const output: TestEncodedVideoChunk[] = [];
    for await (const chunk of result.chunks) output.push(chunk as unknown as TestEncodedVideoChunk);
    expect(output).toHaveLength(expected.length);
    for (let index = 0; index < output.length; index++) {
      const chunk = output[index]!;
      expect(chunk.timestamp).toBe(expected[index]!.timestampUs);
      expect(chunk.duration).toBe(expected[index]!.durationUs);
      expect(createHash('sha256').update(new Uint8Array(chunk.data)).digest('hex')).toBe(
        expected[index]!.sha256
      );
    }
    expect(output[1]!.timestamp).toBe(1_500_000);
    expect(result.totalFrames).toBe(6);
    expect(result.sourceTotalMs).toBeCloseTo(999.996);
  });
});
