// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Explicit-only source for the distinct large admitted VP8 product scenario. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { NEAR_CAP_COMMAND, prepareNearCapFile } from './generate-owned-vp8-near-cap.ts';

export const LARGE_ADMITTED_INPUT = 'dist-validation/owned-vp8-large-admitted.webm';
const ORIGINAL_FILTER =
  "color=c=red:size=4096x2457:rate=2:duration=1,drawbox=c=blue:t=fill:enable='gte(n,1)'";
const LARGE_ADMITTED_FILTER =
  "color=c=red:size=4032x2457:rate=2:duration=1,drawbox=c=blue:t=fill:enable='gte(n,1)'";
assert.equal(NEAR_CAP_COMMAND.filter((part) => part === ORIGINAL_FILTER).length, 1);
export const LARGE_ADMITTED_COMMAND = NEAR_CAP_COMMAND.map((part) =>
  part === ORIGINAL_FILTER ? LARGE_ADMITTED_FILTER : part
);

export function verifyLargeAdmittedManifest(value: unknown): asserts value is {
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
  assert.equal(manifest.generator, 'scripts/test/generate-owned-vp8-large-admitted.ts');
  assert.deepEqual(manifest.input, {
    path: LARGE_ADMITTED_INPUT,
    sha256: 'd3aae8949721b4f278e0c12f5abe3b4b98edbfd37d2f7143e7d1e7fbf35abe10',
    bytes: 7762,
    codec: 'vp9',
    width: 4032,
    height: 2457,
    pixels: 9_906_624,
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

export function verifyLargeAdmittedBytes(
  bytes: Uint8Array,
  manifest: { input: { bytes: number; sha256: string } }
): void {
  assert.equal(bytes.byteLength, manifest.input.bytes, 'Large admitted source size differs');
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    manifest.input.sha256,
    'Large admitted source digest differs'
  );
}

function validateGeneratedVideo(
  path: string,
  manifest: {
    input: {
      bytes: number;
      sha256: string;
      width: number;
      height: number;
      frames: number;
      durationMs: number;
    };
  }
): void {
  verifyLargeAdmittedBytes(readFileSync(path), manifest);
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
  assert.equal(probe.status, 0, `Large admitted FFprobe failed: ${probe.stderr}`);
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

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const manifest = JSON.parse(
    readFileSync(resolve('validation/windows/owned-vp8-large-admitted.json'), 'utf8')
  ) as unknown;
  verifyLargeAdmittedManifest(manifest);
  const outcome = prepareNearCapFile(
    resolve(LARGE_ADMITTED_INPUT),
    (attemptPath) => {
      const result = spawnSync('ffmpeg', [...LARGE_ADMITTED_COMMAND, '-n', attemptPath], {
        encoding: 'utf8',
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `Large admitted FFmpeg failed: ${result.stderr}`);
      chmodSync(attemptPath, 0o600);
    },
    (filePath) => validateGeneratedVideo(filePath, manifest)
  );
  process.stdout.write(`Large admitted source ${outcome}: ${manifest.input.sha256}\n`);
}
