// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { readFileSync } from 'node:fs';

import { OwnedDemuxSession } from '@services/owned-demux-session';
import { beforeAll, describe, expect, it } from 'vite-plus/test';

const MAX_READ = 64 * 1024;
const MAX_WASM = 64 * 1024 * 1024;
const fixtureRoot = new URL('../../fixtures/owned-demux/', import.meta.url);
let module: WebAssembly.Module;

beforeAll(async () => {
  module = await WebAssembly.compile(
    Uint8Array.from(
      readFileSync(new URL('../../../src/services/owned-demux.wasm', import.meta.url))
    )
  );
});

function fixture(name: string): Buffer {
  return Buffer.from(readFileSync(new URL(name + '.base64', fixtureRoot), 'utf8'), 'base64');
}

function corruptedFixture(name: string, change: (bytes: Buffer) => void): Blob {
  const bytes = fixture(name);
  change(bytes);
  return new Blob([Uint8Array.from(bytes)]);
}

async function rejectsWithinBounds(source: Blob, maxReads: number): Promise<void> {
  const session = new OwnedDemuxSession(source, module);
  try {
    await expect(session.analyze()).rejects.toThrow(/Owned demux parser error/);
    const stats = session.transferStats;
    expect(stats.rangeReads).toBeLessThanOrEqual(maxReads);
    expect(stats.sourceReadBytes).toBeLessThanOrEqual(maxReads * MAX_READ);
    expect(stats.inputCopiedToWasmBytes).toBeLessThanOrEqual(maxReads * MAX_READ);
    expect(stats.stepCalls).toBeLessThanOrEqual(128);
    expect(stats.wasmCapacityBytes).toBeLessThanOrEqual(MAX_WASM);
  } finally {
    session.release();
  }
}

describe('compiled demux malformed input bounds', () => {
  it('rejects short and overflowing MP4 top-level lengths', async () => {
    await rejectsWithinBounds(new Blob([Uint8Array.of(0, 0, 0, 7, 109, 111, 111, 118)]), 2);
    const extended = Uint8Array.of(0, 0, 0, 1, 109, 100, 97, 116, ...Array(8).fill(255));
    await rejectsWithinBounds(new Blob([extended]), 2);
  });

  it('rejects an MP4 sample-count claim without allocating the claimed index', async () => {
    const source = corruptedFixture('avc-baseline.mp4', (bytes) => {
      const marker = bytes.indexOf('stsz');
      expect(marker).toBeGreaterThan(0);
      bytes.writeUInt32BE(0xffff_ffff, marker + 12);
    });
    await rejectsWithinBounds(source, 8);
  });

  it('bounds MP4 child-box count within one small moov', async () => {
    const child = Buffer.from([0, 0, 0, 8, 102, 114, 101, 101]);
    const body = Buffer.concat(Array.from({ length: 4098 }, () => child));
    const moov = Buffer.alloc(8 + body.length);
    moov.writeUInt32BE(moov.length);
    moov.write('moov', 4, 'ascii');
    body.copy(moov, 8);
    await rejectsWithinBounds(new Blob([Uint8Array.from(moov)]), 4);
  });

  it('rejects invalid EBML VINT and nested Tracks length', async () => {
    await rejectsWithinBounds(
      corruptedFixture('vp8.webm', (bytes) => {
        bytes[4] = 0;
      }),
      4
    );
    await rejectsWithinBounds(
      corruptedFixture('vp8.webm', (bytes) => {
        const marker = bytes.indexOf(Buffer.from([0x16, 0x54, 0xae, 0x6b]), 100);
        expect(marker).toBeGreaterThan(0);
        bytes[marker + 4] = 0x81;
      }),
      8
    );
  });

  it('rejects an oversized TS PAT section and a truncated program', async () => {
    await rejectsWithinBounds(
      corruptedFixture('avc.ts', (bytes) => {
        bytes[6] = 0xff;
        bytes[7] = 0xff;
      }),
      4
    );
    await rejectsWithinBounds(new Blob([Uint8Array.from(fixture('avc.ts').subarray(0, 188))]), 2);
  });

  it('skips a sparse mdat without reading its body before rejecting the trailing moov', async () => {
    const size = 64 * 1024 * 1024;
    const source = new Blob([new Uint8Array(8)]);
    const ranges: Array<[number, number]> = [];
    Object.defineProperty(source, 'size', { value: size });
    Object.defineProperty(source, 'slice', {
      value: (start: number, end: number) => {
        ranges.push([start, end]);
        const bytes = new Uint8Array(end - start);
        const header = (offset: number, kind: string, length: number) => {
          const record = new Uint8Array(8);
          new DataView(record.buffer).setUint32(0, length);
          record.set(Buffer.from(kind, 'ascii'), 4);
          const overlapStart = Math.max(start, offset);
          const overlapEnd = Math.min(end, offset + record.length);
          if (overlapStart < overlapEnd)
            bytes.set(
              record.subarray(overlapStart - offset, overlapEnd - offset),
              overlapStart - start
            );
        };
        header(0, 'mdat', size - 8);
        header(size - 8, 'moov', 8);
        return new Blob([bytes]);
      },
    });
    await rejectsWithinBounds(source, 4);
    expect(ranges.some(([start]) => start === size - 8)).toBe(true);
    expect(ranges.every(([start, end]) => end - start <= MAX_READ)).toBe(true);
  });

  it('recovers after format-specific failures using fresh sessions of the same module', async () => {
    for (const [bad, good, codec] of [
      [new Blob([Uint8Array.of(0, 0, 0, 7, 109, 111, 111, 118)]), 'avc-baseline.mp4', 'avc1'],
      [
        corruptedFixture('vp8.webm', (bytes) => {
          bytes[4] = 0;
        }),
        'vp8.webm',
        'VP80',
      ],
      [new Blob([Uint8Array.from(fixture('avc.ts').subarray(0, 188))]), 'avc.ts', 'avc1'],
    ] as const) {
      await rejectsWithinBounds(bad, 2);
      const recovered = new OwnedDemuxSession(new Blob([Uint8Array.from(fixture(good))]), module);
      try {
        const track = await recovered.analyze();
        expect(track.codec).toBe(codec);
        expect(track.packetCount).toBeGreaterThan(0);
        expect(recovered.transferStats.wasmCapacityBytes).toBeLessThanOrEqual(MAX_WASM);
      } finally {
        recovered.release();
      }
    }
  });
});
