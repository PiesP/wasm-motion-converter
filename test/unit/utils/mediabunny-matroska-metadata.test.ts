// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { extractVideoMetadata } from '@services/video-metadata';
import { createMediaBunnyInput } from '@utils/mediabunny-utils';
import { ALL_FORMATS, AttachedFile, BufferSource, EncodedPacketSink, Input } from 'mediabunny';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const ID = {
  ebml: 0x1a45dfa3,
  docType: 0x4282,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
  info: 0x1549a966,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackUid: 0x73c5,
  trackType: 0x83,
  codecId: 0x86,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  cluster: 0x1f43b675,
  timestamp: 0xe7,
  simpleBlock: 0xa3,
  tags: 0x1254c367,
  tag: 0x7373,
  simpleTag: 0x67c8,
  tagName: 0x45a3,
  tagString: 0x4487,
  attachments: 0x1941a469,
  attachedFile: 0x61a7,
  fileUid: 0x46ae,
  fileName: 0x466e,
  fileMediaType: 0x4660,
  fileData: 0x465c,
} as const;

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function unsigned(value: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index--) {
    bytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return bytes;
}

function sizeBytes(size: number): Uint8Array {
  if (size < 0x7f) return Uint8Array.of(0x80 | size);
  if (size < 0x3fff) return Uint8Array.of(0x40 | (size >>> 8), size & 0xff);
  if (size < 0x1fffff) return Uint8Array.of(0x20 | (size >>> 16), (size >>> 8) & 0xff, size & 0xff);
  throw new RangeError('Fixture exceeds the small EBML element limit');
}

function element(id: number, ...parts: Uint8Array[]): Uint8Array {
  const data = concat(...parts);
  const idLength = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
  return concat(unsigned(id, idLength), sizeBytes(data.length), data);
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function segment(
  index: number,
  location: 'leading' | 'later',
  attachmentCount = 1,
  infoChildren: Uint8Array[] = [],
  clusterChildren: Uint8Array[] = []
): Uint8Array {
  const duration = new Uint8Array(8);
  new DataView(duration.buffer).setFloat64(0, 1_000);
  const info = element(ID.info, element(ID.duration, duration), ...infoChildren);
  const tracks = element(
    ID.tracks,
    element(
      ID.trackEntry,
      element(ID.trackNumber, Uint8Array.of(1)),
      element(ID.trackUid, Uint8Array.of(index)),
      element(ID.trackType, Uint8Array.of(1)),
      element(ID.codecId, text('V_VP8')),
      element(
        ID.video,
        element(ID.pixelWidth, Uint8Array.of(16)),
        element(ID.pixelHeight, Uint8Array.of(16))
      )
    )
  );
  const cluster = element(
    ID.cluster,
    element(ID.timestamp, Uint8Array.of(0)),
    element(ID.simpleBlock, Uint8Array.of(0x81, 0, 0, 0x80, 0, 0, 0, 0)),
    ...clusterChildren
  );
  const tags = element(
    ID.tags,
    element(
      ID.tag,
      element(
        ID.simpleTag,
        element(ID.tagName, text('TITLE')),
        element(ID.tagString, text(`part-${index}`))
      )
    )
  );
  const attachments = Array.from({ length: attachmentCount }, (_, entry) =>
    element(
      ID.attachments,
      element(
        ID.attachedFile,
        element(ID.fileUid, Uint8Array.of(index * 10 + entry)),
        element(ID.fileName, text(`cover-${index}-${entry}.png`)),
        element(ID.fileMediaType, text('image/png')),
        element(ID.fileData, new Uint8Array(128).fill(index + entry))
      )
    )
  );
  if (location === 'leading')
    return element(ID.segment, info, tracks, tags, ...attachments, cluster);

  const seekEntry = (id: number, position: number): Uint8Array =>
    element(
      ID.seek,
      element(ID.seekId, unsigned(id, 4)),
      element(ID.seekPosition, unsigned(position, 4))
    );
  const seekHead = (tagPosition: number, attachmentPositions: number[]): Uint8Array =>
    element(
      ID.seekHead,
      seekEntry(ID.tags, tagPosition),
      ...attachmentPositions.map((position) => seekEntry(ID.attachments, position))
    );
  const placeholder = seekHead(
    0,
    attachments.map(() => 0)
  );
  const tagPosition = placeholder.length + info.length + tracks.length + cluster.length;
  let nextPosition = tagPosition + tags.length;
  const attachmentPositions = attachments.map((attachment) => {
    const position = nextPosition;
    nextPosition += attachment.length;
    return position;
  });
  return element(
    ID.segment,
    seekHead(tagPosition, attachmentPositions),
    info,
    tracks,
    cluster,
    tags,
    ...attachments
  );
}

function matroska(...segments: Uint8Array[]): ArrayBuffer {
  const bytes = concat(element(ID.ebml, element(ID.docType, text('matroska'))), ...segments);
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

type SliceRequest = { start: number; length: number };

function descriptivePayloads(media: ArrayBuffer): SliceRequest[] {
  const bytes = new Uint8Array(media);
  const spans: SliceRequest[] = [];
  for (const [id, child] of [
    [ID.tags, ID.tag],
    [ID.attachments, ID.attachedFile],
  ] as const) {
    const marker = unsigned(id, 4);
    const childMarker = unsigned(child, 2);
    for (let index = 0; index < bytes.length - 8; index++) {
      if (!marker.every((byte, offset) => bytes[index + offset] === byte)) continue;
      const firstSizeByte = bytes[index + 4]!;
      const sizeLength = firstSizeByte >= 0x80 ? 1 : firstSizeByte >= 0x40 ? 2 : 3;
      const length = Array.from(bytes.subarray(index + 4, index + 4 + sizeLength)).reduce(
        (value, byte, offset) => (offset === 0 ? byte & (0xff >>> sizeLength) : value * 256 + byte),
        0
      );
      const start = index + 4 + sizeLength;
      if (childMarker.every((byte, offset) => bytes[start + offset] === byte)) {
        spans.push({ start, length });
      }
    }
  }
  return spans;
}

async function payloadReads(input: Input): Promise<SliceRequest[]> {
  await input.getFormat();
  const reader = (
    input as Input & { _reader: { requestSlice(start: number, length: number): unknown } }
  )._reader;
  const reads: SliceRequest[] = [];
  const original = reader.requestSlice.bind(reader);
  vi.spyOn(reader, 'requestSlice').mockImplementation((start, length) => {
    reads.push({ start, length });
    return original(start, length);
  });
  return reads;
}

afterEach(() => vi.restoreAllMocks());

describe('installed Matroska descriptive metadata policy', () => {
  it('does not decode or retain descriptive children reached through shared traversal', async () => {
    const privateTitle = 'SKIP_ME_361';
    const orphanTitle = 'CLUSTER_361';
    const nestedTag = element(
      ID.tag,
      element(
        ID.simpleTag,
        element(ID.tagName, text('TITLE')),
        element(ID.tagString, text(privateTitle))
      )
    );
    const nestedAttachment = element(
      ID.attachedFile,
      element(ID.fileUid, Uint8Array.of(7)),
      element(ID.fileName, text('nested.png')),
      element(ID.fileMediaType, text('image/png')),
      element(ID.fileData, Uint8Array.of(1, 2, 3))
    );
    const orphanTag = element(
      ID.tag,
      element(
        ID.simpleTag,
        element(ID.tagName, text('TITLE')),
        element(ID.tagString, text(orphanTitle))
      )
    );
    const media = matroska(segment(1, 'leading', 1, [nestedTag, nestedAttachment], [orphanTag]));
    const bounded = createMediaBunnyInput(media);
    const decoded = vi.spyOn(TextDecoder.prototype, 'decode');
    const decodedValue = (value: string): boolean =>
      decoded.mock.calls.some(
        ([bytes]) =>
          bytes instanceof Uint8Array &&
          bytes.length === value.length &&
          bytes.every((byte, index) => byte === value.charCodeAt(index))
      );
    try {
      const [track] = await bounded.getVideoTracks();
      expect(track).toBeDefined();
      expect((await new EncodedPacketSink(track!).getFirstPacket())?.type).toBe('key');
      const demuxer = await (
        bounded as Input & {
          _getDemuxer(): Promise<{
            currentSimpleTagName: string | null;
            segments: { metadataTags: Record<string, unknown> }[];
          }>;
        }
      )._getDemuxer();
      expect(demuxer.segments[0]?.metadataTags).toEqual({});
      expect(demuxer.currentSimpleTagName).toBeNull();
      expect(decodedValue(privateTitle)).toBe(false);
      expect(decodedValue(orphanTitle)).toBe(false);
      expect(await bounded.getMetadataTags()).toEqual({});
    } finally {
      bounded.dispose();
    }

    const defaultInput = new Input({ formats: ALL_FORMATS, source: new BufferSource(media) });
    try {
      const [track] = await defaultInput.getVideoTracks();
      expect(track).toBeDefined();
      expect((await new EncodedPacketSink(track!).getFirstPacket())?.type).toBe('key');
      const demuxer = await (
        defaultInput as Input & {
          _getDemuxer(): Promise<{
            currentSimpleTagName: string | null;
            segments: { metadataTags: Record<string, unknown> }[];
          }>;
        }
      )._getDemuxer();
      expect(demuxer.segments[0]?.metadataTags).toMatchObject({
        title: privateTitle,
        raw: { '7': expect.any(AttachedFile) },
      });
      expect(
        (demuxer.segments[0]?.metadataTags.images as { data: Uint8Array }[] | undefined)?.[0]?.data
      ).toEqual(Uint8Array.of(1, 2, 3));
      expect(demuxer.currentSimpleTagName).toBe('TITLE');
      expect(decodedValue(privateTitle)).toBe(true);
      expect(decodedValue(orphanTitle)).toBe(true);
    } finally {
      defaultInput.dispose();
    }
  });

  it('skips leading tags and attachments while preserving video tracks and ordinary parser metadata', async () => {
    const media = matroska(segment(1, 'leading'));
    const spans = descriptivePayloads(media);
    expect(spans).toHaveLength(2);
    const bounded = createMediaBunnyInput(media);
    const reads = await payloadReads(bounded);
    try {
      const [track] = await bounded.getVideoTracks();
      expect(await track?.getDecoderConfig()).toMatchObject({ codedWidth: 16, codedHeight: 16 });
      expect((await new EncodedPacketSink(track!).getFirstPacket())?.type).toBe('key');
      expect(await bounded.getMetadataTags()).toEqual({});
      expect(
        reads.filter((request) =>
          spans.some((span) => span.start === request.start && span.length === request.length)
        )
      ).toEqual([]);
    } finally {
      bounded.dispose();
    }

    const defaultInput = new Input({ formats: ALL_FORMATS, source: new BufferSource(media) });
    try {
      const defaultReads = await payloadReads(defaultInput);
      const metadata = await defaultInput.getMetadataTags();
      expect(metadata.title).toBe('part-1');
      expect(metadata.images).toHaveLength(1);
      const attachment = metadata.raw?.['10'];
      expect(attachment).toBeInstanceOf(AttachedFile);
      if (attachment instanceof AttachedFile) {
        expect(metadata.images?.[0]?.data).toBe(attachment.data);
      }
      expect(
        defaultReads.filter((request) =>
          spans.some((span) => span.start === request.start && span.length === request.length)
        )
      ).toHaveLength(2);
    } finally {
      defaultInput.dispose();
    }
  });

  it('skips later seek entries across segments even when each item is individually readable', async () => {
    const media = matroska(segment(1, 'later', 3), segment(2, 'later', 3));
    const spans = descriptivePayloads(media);
    expect(spans).toHaveLength(8);
    expect(spans.every(({ length }) => length < 256)).toBe(true);
    expect(spans.reduce((sum, { length }) => sum + length, 0)).toBeGreaterThan(256);
    const input = createMediaBunnyInput(media);
    (input as Input & { _maxContiguousReadBytes: number })._maxContiguousReadBytes = 256;
    const reads = await payloadReads(input);
    try {
      const reader = (
        input as Input & {
          _reader: { maxReadSize: number; requestSlice(start: number, length: number): unknown };
        }
      )._reader;
      expect(reader.maxReadSize).toBe(256);
      expect(await input.getVideoTracks()).toHaveLength(2);
      expect(await input.getMetadataTags()).toEqual({});
      expect(reads.filter(({ length }) => length > 256)).toEqual([]);
      expect(
        reads.filter((request) =>
          spans.some((span) => span.start === request.start && span.length === request.length)
        )
      ).toEqual([]);
      expect(await reader.requestSlice(0, 255)).not.toBeNull();
      expect(await reader.requestSlice(0, 256)).not.toBeNull();
      expect(() => reader.requestSlice(0, 257)).toThrow(/configured memory limit of 256 bytes/);
    } finally {
      input.dispose();
    }

    const defaultInput = new Input({ formats: ALL_FORMATS, source: new BufferSource(media) });
    try {
      expect((await defaultInput.getMetadataTags()).title).toBe('part-2');
    } finally {
      defaultInput.dispose();
    }
  });

  it('disposes failed and cancelled analyses, then accepts a normal Matroska selection', async () => {
    const valid = matroska(segment(1, 'leading'));
    const invalid = matroska(
      element(ID.segment, element(ID.info, element(ID.duration, Uint8Array.of(0))))
    );
    const dispose = vi.spyOn(Input.prototype, 'dispose');
    await expect(extractVideoMetadata(invalid)).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(extractVideoMetadata(valid, undefined, controller.signal)).rejects.toThrow();
    await expect(extractVideoMetadata(valid)).resolves.toMatchObject({ width: 16, height: 16 });
    expect(dispose).toHaveBeenCalledTimes(3);
  });
});
