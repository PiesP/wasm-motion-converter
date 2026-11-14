#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { execFileSync } from 'node:child_process';
/** Freeze local, development-oracle traces without retaining compressed payloads. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from 'mediabunny';

import {
  ENCODED_PACKET_BUDGET_BYTES,
  MEDIA_BUNNY_BUFFER_BUDGET_BYTES,
  MP4_MAX_LOGICAL_SAMPLES,
  MP4_METADATA_BUDGET_BYTES,
} from '../../src/utils/constants.ts';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function description(
  value: ArrayBufferLike | ArrayBufferView<ArrayBufferLike> | undefined
): string | null {
  if (!value) return null;
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  return Buffer.from(bytes).toString('hex');
}

export async function freezeOracle(path: string): Promise<unknown> {
  const bytes = readFileSync(path);
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
  Object.assign(input, {
    _maxContiguousReadBytes: MEDIA_BUNNY_BUFFER_BUDGET_BYTES,
    _maxEncodedPacketBytes: ENCODED_PACKET_BUDGET_BYTES - 1024,
    _maxBufferedPacketBytes: MEDIA_BUNNY_BUFFER_BUDGET_BYTES,
    _maxIsobmffMetadataBytes: MP4_METADATA_BUDGET_BYTES,
    _maxIsobmffSamples: MP4_MAX_LOGICAL_SAMPLES,
    _skipMatroskaDescriptiveMetadata: true,
  });
  try {
    const tracks = await input.getVideoTracks();
    const track = tracks[0];
    if (!track) throw new Error('No video track');
    const config = await track.getDecoderConfig();
    if (!config) throw new Error('No decoder configuration');
    const sink = new EncodedPacketSink(track);
    const packets = [];
    for await (const packet of sink.packets()) {
      if (packets.length >= 100_000) throw new Error('Fixture packet limit exceeded');
      packets.push({
        sequence: packets.length,
        timestampUs: packet.microsecondTimestamp,
        durationUs: packet.microsecondDuration,
        type: packet.type,
        size: packet.byteLength,
        sha256: digest(packet.data),
      });
    }
    const duration = await track.computeDuration();
    const seek = [];
    for (const seconds of [
      0,
      0.125,
      0.6,
      Math.max(0, duration / 2),
      Math.max(0, duration - 0.01),
    ]) {
      const packet = await sink.getKeyPacket(seconds, { verifyKeyPackets: true });
      seek.push({
        seconds,
        packet: packet && {
          timestampUs: packet.microsecondTimestamp,
          durationUs: packet.microsecondDuration,
          type: packet.type,
          size: packet.byteLength,
          sha256: digest(packet.data),
        },
      });
    }
    return {
      id: basename(path),
      input: { size: bytes.length, sha256: digest(bytes) },
      videoTracks: tracks.length,
      config: { ...config, description: description(config.description) },
      rotation: await track.getRotation(),
      duration,
      stats: await track.computePacketStats(50),
      packets,
      seek,
      decodedFrameHashes: execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          path,
          '-map',
          '0:v:0',
          '-pix_fmt',
          'rgba',
          '-f',
          'framehash',
          '-hash',
          'sha256',
          '-',
        ],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
      ),
      independent: JSON.parse(
        execFileSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_streams',
            '-show_packets',
            '-show_data_hash',
            'sha256',
            '-of',
            'json',
            path,
          ],
          { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
        )
      ),
    };
  } finally {
    input.dispose();
  }
}

if (import.meta.main) {
  const [output, ...paths] = process.argv.slice(2);
  if (!output || !paths.length) throw new Error('Usage: freeze-demux-oracle.ts OUTPUT INPUT...');
  const fixtures = [];
  for (const path of paths) {
    try {
      fixtures.push({ status: 'success', ...((await freezeOracle(resolve(path))) as object) });
    } catch (error) {
      fixtures.push({ id: basename(path), status: 'oracle-rejected', error: String(error) });
    }
  }
  const patch = readFileSync('patches/mediabunny@1.65.2.patch');
  writeFileSync(
    output,
    JSON.stringify(
      {
        schema: 1,
        source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        oracle: { package: 'mediabunny', version: '1.65.2', patchSha256: digest(patch) },
        node: process.version,
        fixtures,
      },
      null,
      2
    ) + '\n'
  );
}
