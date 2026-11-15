// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Explicit-only source for the product near-cap functional scenario. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const NEAR_CAP_INPUT = 'validation/windows/owned-vp8-near-cap-inputs/near-cap.webm';
// Matroska otherwise writes a varying segment UID; bitexact output makes the
// frozen input digest reproducible for the pinned generated-source contract.
export const NEAR_CAP_COMMAND = [
  '-nostdin',
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  "color=c=red:size=4096x2457:rate=2:duration=1,drawbox=c=blue:t=fill:enable='gte(n,1)'",
  '-an',
  '-c:v',
  'libvpx-vp9',
  '-deadline',
  'realtime',
  '-cpu-used',
  '8',
  '-threads',
  '1',
  '-g',
  '1',
  '-b:v',
  '0',
  '-crf',
  '32',
  '-pix_fmt',
  'yuv420p',
  '-fflags',
  '+bitexact',
] as const;

export function verifyNearCapManifest(value: unknown): asserts value is {
  input: {
    path: string;
    sha256: string;
    bytes: number;
    width: number;
    height: number;
    pixels: number;
    frames: number;
    fps: number;
    durationMs: number;
  };
  settings: {
    format: string;
    quality: string;
    qualityPercent: number;
    targetCadenceFps: number;
    scale: number;
    smartFrameSkip: string;
  };
} {
  assert(value && typeof value === 'object');
  const manifest = value as Record<string, unknown>;
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.generator, 'scripts/test/generate-owned-vp8-near-cap.ts');
  assert.deepEqual(manifest.input, {
    path: NEAR_CAP_INPUT,
    sha256: '7cdc718657b916d30243b53c80db6c72460b15bb37881cca2b4efc34fd6a896e',
    bytes: 8885,
    codec: 'vp9',
    width: 4096,
    height: 2457,
    pixels: 10_063_872,
    frames: 2,
    fps: 2,
    durationMs: 1_000,
  });
  assert.deepEqual(manifest.settings, {
    format: 'webp',
    quality: 'low',
    qualityPercent: 60,
    targetCadenceFps: 12,
    scale: 1,
    smartFrameSkip: 'off',
  });
}

export function verifyNearCapBytes(
  bytes: Uint8Array,
  manifest: { input: { bytes: number; sha256: string } }
): void {
  assert.equal(bytes.byteLength, manifest.input.bytes, 'Near-cap source size differs');
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    manifest.input.sha256,
    'Near-cap source digest differs'
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const manifest = JSON.parse(
    readFileSync(resolve('validation/windows/owned-vp8-near-cap.json'), 'utf8')
  ) as unknown;
  verifyNearCapManifest(manifest);
  const path = resolve(NEAR_CAP_INPUT);
  mkdirSync(dirname(path), { recursive: true });
  const result = spawnSync('ffmpeg', [...NEAR_CAP_COMMAND, '-y', path], { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Near-cap FFmpeg generation failed: ${result.stderr}`);
  verifyNearCapBytes(readFileSync(path), manifest);
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-count_frames',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,width,height,avg_frame_rate,nb_read_frames:format=duration',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8' }
  );
  if (probe.error) throw probe.error;
  assert.equal(probe.status, 0, `Near-cap FFprobe failed: ${probe.stderr}`);
  const metadata = JSON.parse(probe.stdout) as {
    streams?: Array<{
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      nb_read_frames?: string;
    }>;
    format?: { duration?: string };
  };
  assert.deepEqual(metadata.streams?.[0], {
    codec_name: 'vp9',
    width: manifest.input.width,
    height: manifest.input.height,
    avg_frame_rate: '2/1',
    nb_read_frames: String(manifest.input.frames),
  });
  assert.equal(Number(metadata.format?.duration), manifest.input.durationMs / 1_000);
}
