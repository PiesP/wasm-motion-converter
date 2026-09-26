// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it } from 'vitest';
import { ENCODED_PACKET_BUDGET_BYTES, MEDIA_BUNNY_BUFFER_BUDGET_BYTES } from '@utils/constants';
import { createMediaBunnyInput } from '@utils/mediabunny-utils';
import { ALL_FORMATS, BufferSource, Input, InputFormat, Source } from 'mediabunny';

class ProbeSource extends Source {
  readLengths: number[] = [];

  constructor(
    private fileSize: number | null = 64,
    private readonly dataLength = 64,
  ) {
    super();
  }

  _getFileSize(): number | null {
    return this.fileSize;
  }

  _read(start: number, end: number) {
    this.readLengths.push(end - start);
    if (start >= this.dataLength) {
      this.fileSize = this.dataLength;
      return null;
    }
    if (end > this.dataLength) this.fileSize = this.dataLength;
    const bytes = new Uint8Array(Math.min(end - start, this.dataLength - start));
    return { bytes, view: new DataView(bytes.buffer), offset: start };
  }

  _dispose(): void {}
}

class ProbeFormat extends InputFormat {
  constructor(
    private readonly readLength: number,
    private readonly readEntireFile = false,
  ) {
    super();
  }

  get name(): string {
    return 'Read limit probe';
  }

  get mimeType(): string {
    return 'application/x-read-limit-probe';
  }

  async _canReadInput(input: Input): Promise<boolean> {
    const reader = (input as unknown as {
      _reader: {
        requestSlice(start: number, length: number): unknown;
        requestEntireFile(): unknown;
      };
    })._reader;
    if (this.readEntireFile) {
      await reader.requestEntireFile();
    } else {
      await reader.requestSlice(0, this.readLength);
    }
    return true;
  }

  _createDemuxer() {
    return {} as never;
  }
}

function setReadLimit(input: Input, maxContiguousReadBytes: number): void {
  (input as Input & { _maxContiguousReadBytes: number })._maxContiguousReadBytes =
    maxContiguousReadBytes;
}

function setInputMemoryLimits(input: Input, limitBytes: number): void {
  const bounded = input as Input & {
    _maxContiguousReadBytes: number;
    _maxEncodedPacketBytes: number;
    _maxBufferedPacketBytes: number;
  };
  bounded._maxContiguousReadBytes = limitBytes;
  bounded._maxEncodedPacketBytes = limitBytes;
  bounded._maxBufferedPacketBytes = limitBytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function makeOggPage(packet: Uint8Array, sequence: number, headerType: number): Uint8Array {
  const page = new Uint8Array(28 + packet.byteLength);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
  page[4] = 0;
  page[5] = headerType;
  page[14] = 1;
  page[18] = sequence;
  page[26] = 1;
  page[27] = packet.byteLength;
  page.set(packet, 28);
  return page;
}

function makeOversizedVorbisHeaders(): ArrayBuffer {
  const first = new Uint8Array(24);
  first.set([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]);
  const second = new Uint8Array(24);
  second[0] = 0x03;
  const third = new Uint8Array(24);
  third[0] = 0x05;

  const pages = [
    makeOggPage(first, 0, 0x02),
    makeOggPage(second, 1, 0),
    makeOggPage(third, 2, 0x04),
  ];
  const file = new Uint8Array(pages.reduce((total, page) => total + page.byteLength, 0));
  let offset = 0;
  for (const page of pages) {
    file.set(page, offset);
    offset += page.byteLength;
  }
  return file.buffer;
}

function makeFlacMetadataBlock(
  type: number,
  payload: Uint8Array,
  isLast = false,
): Uint8Array {
  const block = new Uint8Array(4 + payload.byteLength);
  block[0] = (isLast ? 0x80 : 0) | type;
  block[1] = payload.byteLength >>> 16;
  block[2] = payload.byteLength >>> 8;
  block[3] = payload.byteLength;
  block.set(payload, 4);
  return block;
}

function makeFlacFile(
  blocks: Uint8Array[],
  leadingBytes = new Uint8Array(),
): ArrayBuffer {
  const signature = new Uint8Array([0x66, 0x4c, 0x61, 0x43]); // fLaC
  const file = new Uint8Array(
    leadingBytes.byteLength
      + signature.byteLength
      + blocks.reduce((total, block) => total + block.byteLength, 0),
  );
  file.set(leadingBytes);
  file.set(signature, leadingBytes.byteLength);
  let offset = leadingBytes.byteLength + signature.byteLength;
  for (const block of blocks) {
    file.set(block, offset);
    offset += block.byteLength;
  }
  return file.buffer;
}

function makeFlacStreamInfoBlock(): Uint8Array {
  return makeFlacMetadataBlock(0, new Uint8Array(34));
}

function makeEmptyVorbisCommentBlock(isLast = false): Uint8Array {
  return makeFlacMetadataBlock(4, new Uint8Array(8), isLast);
}

function makeId3v2Tag(contentLength: number): Uint8Array {
  const tag = new Uint8Array(10 + contentLength);
  tag.set([0x49, 0x44, 0x33, 3, 0, 0]); // ID3v2.3
  tag[9] = contentLength;
  return tag;
}

function makeEmptyFlacPictureBlock(isLast = false): Uint8Array {
  return makeFlacMetadataBlock(6, new Uint8Array(32), isLast);
}

describe('MediaBunny input memory limits', () => {
  it('applies the WMC buffer, encoded-packet, and buffered-packet limits to every input', () => {
    const input = createMediaBunnyInput(new ArrayBuffer(0));
    const bounded = input as Input & {
      _maxContiguousReadBytes: number;
      _maxEncodedPacketBytes: number;
      _maxBufferedPacketBytes: number;
    };

    try {
      expect(bounded._maxContiguousReadBytes).toBe(MEDIA_BUNNY_BUFFER_BUDGET_BYTES);
      expect(bounded._maxEncodedPacketBytes).toBe(ENCODED_PACKET_BUDGET_BYTES - 1024);
      expect(bounded._maxBufferedPacketBytes).toBe(MEDIA_BUNNY_BUFFER_BUDGET_BYTES);
    } finally {
      input.dispose();
    }
  });

  it('rejects an oversized source read before the source allocates or reads it', async () => {
    const source = new ProbeSource();
    const input = new Input({
      formats: [new ProbeFormat(9)],
      source,
    });
    setReadLimit(input, 8);

    try {
      await expect(input.getFormat()).rejects.toThrow('memory limit');
      expect(source.readLengths).toEqual([]);
    } finally {
      input.dispose();
    }
  });

  it('allows a source read at the configured limit', async () => {
    const source = new ProbeSource();
    const format = new ProbeFormat(8);
    const input = new Input({
      formats: [format],
      source,
    });
    setReadLimit(input, 8);

    try {
      await expect(input.getFormat()).resolves.toBe(format);
      expect(source.readLengths).toEqual([8]);
    } finally {
      input.dispose();
    }
  });

  it('limits cumulative reads from an unknown-size source before requesting another full chunk', async () => {
    const source = new ProbeSource(null, 64);
    const input = new Input({
      formats: [new ProbeFormat(0, true)],
      source,
    });
    setReadLimit(input, 8);

    try {
      await expect(input.getFormat()).rejects.toThrow('memory limit');
      expect(source.readLengths).toEqual([8, 1]);
    } finally {
      input.dispose();
    }
  });

  it('allows an unknown-size source whose total size equals the configured limit', async () => {
    const source = new ProbeSource(null, 8);
    const format = new ProbeFormat(0, true);
    const input = new Input({
      formats: [format],
      source,
    });
    setReadLimit(input, 8);

    try {
      await expect(input.getFormat()).resolves.toBe(format);
      expect(source.readLengths).toEqual([8, 1]);
    } finally {
      input.dispose();
    }
  });

  it('rejects aggregate Vorbis headers before reading a packet that cannot fit beside comments and description', async () => {
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(makeOversizedVorbisHeaders()),
    });
    setInputMemoryLimits(input, 200);

    try {
      await expect(input.getAudioTracks()).rejects.toThrow('memory limit');
    } finally {
      input.dispose();
    }
  });

  it('limits Ogg logical bitstreams when a finite memory budget is configured', async () => {
    const pages = Array.from(
      { length: 257 },
      (_, index) => makeOggPage(new Uint8Array([0]), index, 0x02),
    );
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(concatBytes(...pages)),
    });
    setInputMemoryLimits(input, 512);

    try {
      await expect(input.getAudioTracks()).rejects.toThrow(
        'Ogg logical bitstream count exceeds the configured safety limit.',
      );
    } finally {
      input.dispose();
    }
  });

  it('preserves the default Ogg logical bitstream behavior without a finite memory budget', async () => {
    const pages = Array.from(
      { length: 257 },
      (_, index) => makeOggPage(new Uint8Array([0]), index, 0x02),
    );
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(concatBytes(...pages)),
    });

    try {
      await expect(input.getAudioTracks()).resolves.toEqual([]);
    } finally {
      input.dispose();
    }
  });

  it('rejects cumulative FLAC metadata expansion before parsing the next retained block', async () => {
    const malformedComment = new Uint8Array(8);
    malformedComment[4] = 1; // One comment is declared, but its length and contents are absent.
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(
        makeFlacFile([
          makeFlacStreamInfoBlock(),
          makeEmptyVorbisCommentBlock(),
          makeFlacMetadataBlock(4, malformedComment, true),
        ]),
      ),
    });
    setInputMemoryLimits(input, 200);

    try {
      await expect(input.getMetadataTags()).rejects.toThrow(
        'FLAC metadata exceeds the configured memory limit.',
      );
    } finally {
      input.dispose();
    }
  });

  it('rejects cumulative leading ID3 metadata before parsing the next tag', async () => {
    const tag = makeId3v2Tag(8);
    const leadingTags = new Uint8Array(tag.byteLength * 3);
    leadingTags.set(tag);
    leadingTags.set(tag, tag.byteLength);
    leadingTags.set(tag, tag.byteLength * 2);
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(
        makeFlacFile(
          [makeFlacMetadataBlock(0, new Uint8Array(34), true)],
          leadingTags,
        ),
      ),
    });
    setInputMemoryLimits(input, 200);

    try {
      await expect(input.getMetadataTags()).rejects.toThrow(
        'FLAC metadata exceeds the configured memory limit.',
      );
    } finally {
      input.dispose();
    }
  });

  it('rejects cumulative FLAC pictures before parsing the next retained image', async () => {
    const malformedPicture = new Uint8Array(32);
    malformedPicture.set([0xff, 0xff, 0xff, 0xff], 4);
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(
        makeFlacFile([
          makeFlacStreamInfoBlock(),
          makeEmptyFlacPictureBlock(),
          makeFlacMetadataBlock(6, malformedPicture, true),
        ]),
      ),
    });
    setInputMemoryLimits(input, 200);

    try {
      await expect(input.getMetadataTags()).rejects.toThrow(
        'FLAC metadata exceeds the configured memory limit.',
      );
    } finally {
      input.dispose();
    }
  });

  it('rejects an excessive number of FLAC metadata blocks', async () => {
    const paddingBlocks = Array.from(
      { length: 4096 },
      (_, index) => makeFlacMetadataBlock(1, new Uint8Array(), index === 4095),
    );
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(
        makeFlacFile([makeFlacStreamInfoBlock(), ...paddingBlocks]),
      ),
    });
    setInputMemoryLimits(input, 200);

    try {
      await expect(input.getMetadataTags()).rejects.toThrow(
        'FLAC metadata block count exceeds the configured safety limit.',
      );
    } finally {
      input.dispose();
    }
  });

  it('preserves the default unbounded FLAC metadata block behavior', async () => {
    const paddingBlocks = Array.from(
      { length: 4096 },
      (_, index) => makeFlacMetadataBlock(1, new Uint8Array(), index === 4095),
    );
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(
        makeFlacFile([makeFlacStreamInfoBlock(), ...paddingBlocks]),
      ),
    });

    try {
      await expect(input.getMetadataTags()).resolves.toEqual({});
    } finally {
      input.dispose();
    }
  });

  it('allows bounded FLAC metadata within the configured limit', async () => {
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(
        makeFlacFile([
          makeFlacStreamInfoBlock(),
          makeEmptyVorbisCommentBlock(true),
        ]),
      ),
    });
    setInputMemoryLimits(input, 200);

    try {
      await expect(input.getMetadataTags()).resolves.toEqual({});
    } finally {
      input.dispose();
    }
  });
});
