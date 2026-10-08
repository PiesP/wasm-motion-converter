// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { extractVideoMetadata } from '@services/video-metadata';
import { MP4_MAX_LOGICAL_SAMPLES, MP4_METADATA_BUDGET_BYTES } from '@utils/constants';
import { createMediaBunnyInput } from '@utils/mediabunny-utils';
import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';

type Table = {
  sampleSizes: number[];
  sampleTimingEntries: { count: number }[];
  presentationTimestamps: { sampleIndex: number }[] | null;
  presentationTimestampIndexMap: number[] | null;
};
type Track = {
  id: number;
  info: { type: string; codec?: string; numberOfChannels?: number };
  sampleTableByteOffset: number;
  sampleTable: Table | null;
  fragmentLookupTable: unknown[];
  fragmentPositionCache: unknown[];
};
type Slice = { filePos: number };
type Parser = {
  moovSlice: Slice;
  tracks: Track[];
  getSampleTableForTrack(track: Track): Table;
  traverseBox(slice: Slice): boolean;
  currentFragment: { trackData: Map<number, { samples: unknown[] }> } | null;
  lastReadFragment: { trackData: Map<number, { samples: unknown[] }> } | null;
};

// Import the installed patched parser, rather than copying its expansion loops.
const require = createRequire(`${process.cwd()}/package.json`);
const modules = new URL('../modules/src/', pathToFileURL(require.resolve('mediabunny')));
const { IsobmffDemuxer } = (await import(`${modules.href}isobmff/isobmff-demuxer.js`)) as {
  IsobmffDemuxer: new (input: Input) => Parser;
};
const { FileSlice } = (await import(`${modules.href}reader.js`)) as {
  FileSlice: { tempFromBytes(bytes: Uint8Array): Slice };
};

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function words(...values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value));
  return bytes;
}

function box(name: string, ...parts: Uint8Array[]): Uint8Array {
  const content = concat(...parts);
  return concat(words(content.length + 8), new TextEncoder().encode(name), content);
}

function timing(count: number, composition = false): Uint8Array {
  return box(composition ? 'ctts' : 'stts', words(0, 1, count, composition ? 0 : 1));
}

function sizes(count: number, width?: number): Uint8Array {
  if (width === undefined) return box('stsz', words(0, 1, count));
  const entries = new Uint8Array(Math.ceil((count * width) / 8));
  entries.fill(width === 4 ? 0x11 : 1);
  return box('stz2', words(0, width, count), entries);
}

function track(id = 1): Track {
  return {
    id,
    info: { type: 'video' },
    sampleTableByteOffset: 0,
    sampleTable: null,
    fragmentLookupTable: [],
    fragmentPositionCache: [],
  };
}

function parser(bytes = 4096, samples = 100): { input: Input; parser: Parser } {
  const input = createMediaBunnyInput(new ArrayBuffer(0));
  Object.assign(input, { _maxIsobmffMetadataBytes: bytes, _maxIsobmffSamples: samples });
  return { input, parser: new IsobmffDemuxer(input) };
}

function readTable(parser: Parser, target: Track, ...parts: Uint8Array[]): Table {
  parser.moovSlice = FileSlice.tempFromBytes(box('stbl', ...parts));
  return parser.getSampleTableForTrack(target);
}

function fragment(id: number, ...counts: number[]): Uint8Array {
  return box(
    'moof',
    box('traf', box('tfhd', words(0x020038, id, 1, 1, 0)),
      ...counts.map((count) => box('trun', words(0, count))))
  );
}

async function normalMp4(): Promise<ArrayBuffer> {
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const source = new EncodedVideoPacketSource('vp9');
  output.addVideoTrack(source);
  await output.start();
  for (let index = 0; index < 6; index++) {
    await source.add(new EncodedPacket(new Uint8Array([0x82, 0, 0, 0]), 'key', index / 30, 1 / 30), {
      decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 },
    });
  }
  await output.finalize();
  if (!target.buffer) throw new Error('MP4 fixture was not finalized');
  return target.buffer;
}

afterEach(() => vi.restoreAllMocks());

describe('installed MP4 sample metadata allocation policy', () => {
  it('applies explicit metadata and logical-count budgets to application inputs', () => {
    const input = createMediaBunnyInput(new ArrayBuffer(0));
    expect(input).toMatchObject({
      _maxIsobmffMetadataBytes: MP4_METADATA_BUDGET_BYTES,
      _maxIsobmffSamples: MP4_MAX_LOGICAL_SAMPLES,
    });
    input.dispose();
  });

  it.each([4, 8, 16])('preserves supported compact width %i and exact sample indices', (width) => {
    const probe = parser();
    try {
      const table = readTable(probe.parser, track(), timing(6), sizes(6, width), timing(6, true));
      expect(table.sampleSizes).toHaveLength(6);
      expect(table.presentationTimestampIndexMap).toEqual([0, 1, 2, 3, 4, 5]);
    } finally {
      probe.input.dispose();
    }
  });

  it.each([0, 1, 2, 32])('rejects unsupported width %i before any sample push', (width) => {
    const probe = parser();
    const target = track();
    try {
      expect(() => readTable(probe.parser, target, sizes(6, width))).toThrow('compact sample-size width');
      expect(target.sampleTable?.sampleSizes).toEqual([]);
      expect(() => probe.parser.getSampleTableForTrack(target)).toThrow('compact sample-size width');
    } finally {
      probe.input.dispose();
    }
  });

  it('admits exactly the size-array budget and rejects its next entry before expansion', () => {
    const accepted = parser(128 + 96 + 6 * 16);
    const rejected = parser(128 + 96 + 5 * 16);
    const target = track();
    try {
      expect(readTable(accepted.parser, track(), timing(6), sizes(6, 4)).sampleSizes).toHaveLength(6);
      expect(() => readTable(rejected.parser, target, timing(6), sizes(6, 4))).toThrow('memory limit');
      expect(target.sampleTable?.sampleSizes).toEqual([]);
    } finally {
      accepted.input.dispose();
      rejected.input.dispose();
    }
  });

  it('rejects truncated compact and ordinary size arrays before sample materialization', () => {
    for (const table of [box('stz2', words(0, 16, 6), new Uint8Array(2)), box('stsz', words(0, 0, 6, 1))]) {
      const probe = parser();
      const target = track();
      try {
        expect(() => readTable(probe.parser, target, table)).toThrow('truncated');
        expect(target.sampleTable?.sampleSizes).toEqual([]);
      } finally {
        probe.input.dispose();
      }
    }
  });

  it('rejects timing expansion before presentation arrays and inverse maps are allocated', () => {
    const probe = parser(128 + 96 * 2 + 16 + 5 * 128);
    const target = track();
    try {
      expect(() => readTable(probe.parser, target, timing(6), sizes(6), timing(6, true))).toThrow('memory limit');
      expect(target.sampleTable?.presentationTimestamps).toBeNull();
      expect(target.sampleTable?.presentationTimestampIndexMap).toBeNull();
    } finally {
      probe.input.dispose();
    }
  });

  it('shares allocation and logical counts across independently small tracks', () => {
    const probe = parser(1500, 10);
    try {
      readTable(probe.parser, track(1), timing(6), sizes(6), timing(6, true));
      expect(() => readTable(probe.parser, track(2), timing(6), sizes(6))).toThrow('sample count');
    } finally {
      probe.input.dispose();
    }
  });

  it('shares retained allocation across tracks even when all logical counts fit', () => {
    const probe = parser(1500);
    try {
      readTable(probe.parser, track(1), timing(6), sizes(6), timing(6, true));
      expect(() => readTable(probe.parser, track(2), timing(6), sizes(6), timing(6, true))).toThrow('memory limit');
    } finally {
      probe.input.dispose();
    }
  });

  it('rejects duplicate size representations and out-of-range chunk and key indices', () => {
    for (const parts of [
      [timing(6), sizes(6), sizes(6, 4)],
      [timing(6), sizes(6), box('stss', words(0, 1, 0xffffffff))],
      [timing(6), sizes(6), box('stsc', words(0, 2, 1, 1, 1, 100, 1, 1)), box('stco', words(0, 1, 0))],
    ]) {
      const probe = parser();
      try {
        expect(() => readTable(probe.parser, track(), ...parts)).toThrow('ISOBMFF sample metadata');
      } finally {
        probe.input.dispose();
      }
    }
  });

  it('rejects inconsistent counts and oversized timing sums without expanding them', () => {
    for (const parts of [
      [timing(6), sizes(5), timing(6, true)],
      [timing(6), timing(5, true)],
      [box('stts', words(0, 2, 60, 1, 60, 1))],
      [box('stts', words(0, 2, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff))],
    ]) {
      const probe = parser();
      try {
        expect(() => readTable(probe.parser, track(), ...parts)).toThrow('ISOBMFF sample metadata');
      } finally {
        probe.input.dispose();
      }
    }
  });

  it('keeps a large constant-size PCM declaration compact before chunk coalescing', () => {
    const probe = parser(1024, MP4_MAX_LOGICAL_SAMPLES);
    try {
      const target = track();
      target.info = { type: 'audio', codec: 'pcm-s16', numberOfChannels: 2 };
      const table = readTable(probe.parser, target, timing(43_200_000), sizes(43_200_000),
        box('stsc', words(0, 1, 1, 43_200_000, 1)), box('stco', words(0, 1, 0)));
      expect(table.sampleSizes).toEqual([43_200_000 * 4]);
      expect(table.sampleTimingEntries).toHaveLength(1);
      expect(table.presentationTimestamps).toBeNull();
    } finally {
      probe.input.dispose();
    }
  });

  it('bounds default-only runs cumulatively before the next sample object', () => {
    const probe = parser(128 + 128 + 96 + 6 * 304);
    const target = track();
    probe.parser.tracks.push(target);
    try {
      expect(() => probe.parser.traverseBox(FileSlice.tempFromBytes(fragment(1, 6, 1)))).toThrow('memory limit');
      expect(probe.parser.lastReadFragment).toBeNull();
      expect(probe.parser.currentFragment?.trackData.get(1)?.samples).toHaveLength(6);
    } finally {
      probe.input.dispose();
    }
  });

  it('combines multiple tracks in one fragment before their presentation maps', () => {
    const probe = parser(4096);
    probe.parser.tracks.push(track(1), track(2));
    const first = fragment(1, 6).slice(8);
    const second = fragment(2, 6).slice(8);
    try {
      expect(() => probe.parser.traverseBox(FileSlice.tempFromBytes(box('moof', first, second)))).toThrow('memory limit');
      expect(probe.parser.currentFragment?.trackData.get(2)?.samples).toHaveLength(0);
    } finally {
      probe.input.dispose();
    }
  });

  it('shares fragment work across tracks and unique offsets without charging rereads twice', () => {
    const probe = parser(4096);
    probe.parser.tracks.push(track(1));
    try {
      const bytes = fragment(1, 6);
      expect(probe.parser.traverseBox(FileSlice.tempFromBytes(bytes))).toBe(true);
      expect(probe.parser.lastReadFragment?.trackData.get(1)?.samples).toHaveLength(6);
      expect(probe.parser.traverseBox(FileSlice.tempFromBytes(bytes))).toBe(true);
      const next = FileSlice.tempFromBytes(concat(box('free', new Uint8Array()), bytes));
      next.filePos = 8;
      expect(() => probe.parser.traverseBox(next)).toThrow('cumulative fragment work');
    } finally {
      probe.input.dispose();
    }
  });

  it('propagates production metadata rejection, disposes the input, then accepts a normal selection', async () => {
    const normal = await normalMp4();
    const bad = normal.slice(0);
    const bytes = new Uint8Array(bad);
    const marker = new TextEncoder().encode('stsz');
    const offset = bytes.findIndex((_, index) => marker.every((byte, part) => bytes[index + part] === byte));
    expect(offset).toBeGreaterThan(0);
    const view = new DataView(bad);
    view.setUint32(offset + 8, 1);
    view.setUint32(offset + 12, MP4_MAX_LOGICAL_SAMPLES + 1);
    const dispose = vi.spyOn(Input.prototype, 'dispose');
    await expect(extractVideoMetadata(bad)).rejects.toThrow('sample count');
    expect(dispose).toHaveBeenCalledOnce();
    await expect(extractVideoMetadata(normal)).resolves.toMatchObject({ width: 16, height: 16, framerate: 30 });
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
