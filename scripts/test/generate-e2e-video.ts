#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const outputPath = resolve('public/test-video-ci-h264.mp4');
mkdirSync(dirname(outputPath), { recursive: true });

const result = spawnSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=160x90:rate=10:duration=1',
    '-an',
    '-c:v',
    'libx264',
    '-profile:v',
    'baseline',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-y',
    outputPath,
  ],
  { encoding: 'utf8' }
);

if (result.error) {
  const error = result.error as NodeJS.ErrnoException;
  if (error.code === 'ENOENT') {
    throw new Error('ffmpeg is required to generate the E2E codec fixture.');
  }
  throw error;
}
if (result.status !== 0) {
  throw new Error(`ffmpeg failed to generate the E2E codec fixture:\n${result.stderr.trim()}`);
}

const size = statSync(outputPath).size;
if (size === 0) {
  throw new Error(`Generated an empty E2E codec fixture: ${outputPath}`);
}

console.log(`[e2e-fixture] Generated ${outputPath} (${size} bytes)`);
