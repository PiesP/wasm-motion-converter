// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createMediaBunnyInput } from '@utils/mediabunny-utils';
import { EncodedPacketSink } from 'mediabunny';
import { expect, it } from 'vite-plus/test';

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
