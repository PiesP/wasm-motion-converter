// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { EncodedPacketSink } from 'mediabunny';
import { expect, it } from 'vite-plus/test';

import { createMediaBunnyInput } from '../../helpers/mediabunny-oracle';

// Generated with FFmpeg from an owned 16x16 black source at 4 fps for 4 seconds:
// libx264 -preset ultrafast -crf 51 -g 4 -keyint_min 4 -sc_threshold 0 -bf 0
// -movflags frag_keyframe+empty_moov+default_base_moof -frag_duration 250000.
// The trailing top-level mfra box was removed so the parser must search fragments
// and their position cache rather than relying on the final random-access index.
// SHA-256 of the decoded fixture: 425aab8905d9f8533ec0734a60ef6e85dbf7d7b607020e5a3fabaa55072e07f8.
it('keeps key-packet lookup valid after reading no-index fragments without key packets', async () => {
  const encoded = readFileSync(
    resolve('test/fixtures/mediabunny-fragmented-no-index.base64'),
    'utf8'
  );
  const bytes = Buffer.from(encoded, 'base64');
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    '425aab8905d9f8533ec0734a60ef6e85dbf7d7b607020e5a3fabaa55072e07f8'
  );
  const input = createMediaBunnyInput(Uint8Array.from(bytes).buffer);
  try {
    const track = await input.getPrimaryVideoTrack();
    expect(track).not.toBeNull();
    const sink = new EncodedPacketSink(track!);
    const cold = await sink.getKeyPacket(0.6, { verifyKeyPackets: true });
    expect(cold?.timestamp).toBe(0);
    expect(cold?.type).toBe('key');

    let packetCount = 0;
    for await (const packet of sink.packets()) {
      expect(packet.timestamp).toBeGreaterThanOrEqual(0);
      packetCount++;
    }
    expect(packetCount).toBe(16);

    const warmStart = await sink.getKeyPacket(0.6, { verifyKeyPackets: true });
    const warmLate = await sink.getKeyPacket(2.6, { verifyKeyPackets: true });
    expect(warmStart?.timestamp).toBe(cold?.timestamp);
    expect(warmStart?.type).toBe('key');
    expect(warmLate?.timestamp).toBe(2);
    expect(warmLate?.type).toBe('key');
  } finally {
    input.dispose();
  }
});

// Generated from an owned 16x16 black source at 4 fps for four seconds:
// ffmpeg -f lavfi -i color=c=black:s=16x16:r=4:d=4 -c:v libvpx -b:v 100k
//   -g 4 -keyint_min 4 -cluster_time_limit 250 -live 1 -an -f webm
// The live WebM has no Cues and eight clusters, including clusters without a key frame.
// SHA-256 of the decoded fixture: 2bd09d4830f8d9c96ae540cba9ab596a55aea4da88d74bbc9aeb95ddae29c607.
it('finds key packets across cue-less WebM clusters and bounds retained lookup entries', async () => {
  const encoded = readFileSync(
    resolve('test/fixtures/mediabunny-clustered-no-cues.base64'),
    'utf8'
  );
  const bytes = Buffer.from(encoded, 'base64');
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    '2bd09d4830f8d9c96ae540cba9ab596a55aea4da88d74bbc9aeb95ddae29c607'
  );
  const media = Uint8Array.from(bytes).buffer;
  const input = createMediaBunnyInput(media);
  try {
    const track = await input.getPrimaryVideoTrack();
    expect(track).not.toBeNull();
    const sink = new EncodedPacketSink(track!);
    expect((await sink.getKeyPacket(0.6, { verifyKeyPackets: true }))?.timestamp).toBe(0);
    expect((await sink.getKeyPacket(2.6, { verifyKeyPackets: true }))?.timestamp).toBe(2);

    let packetCount = 0;
    for await (const packet of sink.packets()) {
      expect(packet.timestamp).toBeGreaterThanOrEqual(0);
      packetCount++;
    }
    expect(packetCount).toBe(16);
    expect((await sink.getKeyPacket(0.6, { verifyKeyPackets: true }))?.timestamp).toBe(0);
    expect((await sink.getKeyPacket(2.6, { verifyKeyPackets: true }))?.timestamp).toBe(2);
  } finally {
    input.dispose();
  }

  const bounded = createMediaBunnyInput(media) as ReturnType<typeof createMediaBunnyInput> & {
    _maxBufferedPacketBytes: number;
  };
  bounded._maxBufferedPacketBytes = 900;
  try {
    const track = await bounded.getPrimaryVideoTrack();
    expect(track).not.toBeNull();
    const sink = new EncodedPacketSink(track!);
    await expect(async () => {
      for await (const packet of sink.packets()) {
        expect(packet.timestamp).toBeGreaterThanOrEqual(0);
      }
    }).rejects.toThrow('Matroska lookup cache exceeds the configured memory limit.');
  } finally {
    bounded.dispose();
  }
});

it('rejects a cached WebM cluster again after its summary reservation fails', async () => {
  const encoded = readFileSync(
    resolve('test/fixtures/mediabunny-clustered-no-cues.base64'),
    'utf8'
  );
  const media = Uint8Array.from(Buffer.from(encoded, 'base64')).buffer;
  type SegmentProbe = {
    clusterSeekStartPos: number;
    lastReadCluster: unknown | null;
    clusterSummaries: Map<number, unknown>;
  };
  const input = createMediaBunnyInput(media) as ReturnType<typeof createMediaBunnyInput> & {
    _maxBufferedPacketBytes: number;
    _getDemuxer(): Promise<{
      segments: SegmentProbe[];
      readCluster(position: number, segment: SegmentProbe): Promise<unknown>;
    }>;
  };

  try {
    expect(await input.getPrimaryVideoTrack()).not.toBeNull();
    const demuxer = await input._getDemuxer();
    const segment = demuxer.segments[0];
    expect(segment).toBeDefined();
    const startPos = segment!.clusterSeekStartPos;
    expect(startPos).toBeGreaterThan(0);

    // One 96-byte position entry fits, but the cluster summary cannot fit.
    input._maxBufferedPacketBytes = 128;
    await expect(demuxer.readCluster(startPos, segment!)).rejects.toThrow(
      'Matroska lookup cache exceeds the configured memory limit.'
    );
    expect(segment!.clusterSummaries.has(startPos)).toBe(false);
    await expect(demuxer.readCluster(startPos, segment!)).rejects.toThrow(
      'Matroska lookup cache exceeds the configured memory limit.'
    );
    expect(segment!.lastReadCluster).toBeNull();
  } finally {
    input.dispose();
  }
});

// MediaBunny 1.66.2 rounds Matroska DefaultDuration to the container tick grid.
// Keep the 1.65.2 trace immutable for the owned demux contract and check only
// this observed comparator difference against the same independent fixtures.
const roundedDefaultDurationPackets: Record<string, number[]> = {
  'vp8.webm': [1, 3, 5, 7, 9, 11],
  'vp9.webm': [1, 3, 5, 7, 9, 11],
  'av1.webm': [11],
  'avc.mkv': [11],
  'hevc.mkv': [8],
  'vp9-10bit.webm': [11],
  'vp9-fullrange.webm': [11],
};

for (const [id, roundedIndices] of Object.entries(roundedDefaultDurationPackets)) {
  it(`keeps the 1.66.2 Matroska comparator delta limited to rounded durations: ${id}`, async () => {
    const frozen = JSON.parse(
      readFileSync(resolve('test/fixtures/owned-demux/oracle.json'), 'utf8')
    ) as {
      fixtures: Array<{
        id: string;
        packets: Array<{
          timestampUs: number;
          durationUs: number;
          type: string;
          size: number;
          sha256: string;
        }>;
      }>;
    };
    const previous = frozen.fixtures.find((fixture) => fixture.id === id);
    expect(previous).toBeDefined();
    const bytes = Buffer.from(
      readFileSync(resolve('test/fixtures/owned-demux', id + '.base64'), 'utf8'),
      'base64'
    );
    const input = createMediaBunnyInput(Uint8Array.from(bytes).buffer);
    try {
      const track = await input.getPrimaryVideoTrack();
      expect(track).not.toBeNull();
      const sink = new EncodedPacketSink(track!);
      let index = 0;
      for await (const packet of sink.packets()) {
        const expected = previous!.packets[index];
        expect(expected).toBeDefined();
        expect({
          timestampUs: packet.microsecondTimestamp,
          durationUs: packet.microsecondDuration,
          type: packet.type,
          size: packet.byteLength,
          sha256: createHash('sha256').update(packet.data).digest('hex'),
        }).toEqual({
          timestampUs: expected!.timestampUs,
          durationUs: roundedIndices.includes(index) ? 167_000 : expected!.durationUs,
          type: expected!.type,
          size: expected!.size,
          sha256: expected!.sha256,
        });
        index++;
      }
      expect(index).toBe(previous!.packets.length);
    } finally {
      input.dispose();
    }
  });
}
