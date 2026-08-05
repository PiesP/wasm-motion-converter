#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

interface VideoFixture {
  fileName: string;
  input: string;
  videoFilter?: string;
  encoderArgs?: string[];
  extraEncoderArgs?: string[];
  outputArgs?: string[];
}

const fixtures: VideoFixture[] = [
  {
    fileName: 'test-video-ci-h264.mp4',
    input: 'testsrc=size=160x90:rate=10:duration=1',
  },
  {
    fileName: 'test-video-ci-high-motion-120fps.mp4',
    input:
      'color=c=black:size=320x180:rate=120:duration=0.25[still];' +
      'nullsrc=size=320x180:rate=120:duration=2.75,' +
      "geq=lum='if(mod(N,2),255,0)':cb=128:cr=128[fast];" +
      '[still][fast]concat=n=2:v=1:a=0,fps=120',
    extraEncoderArgs: ['-preset', 'ultrafast', '-crf', '18'],
  },
];

if (process.env.PREPARE_RESOURCE_FIXTURES === 'true') {
  fixtures.push({
    fileName: 'test-video-resource-hostile-par.webm',
    input: 'testsrc=size=520x520:rate=1:duration=1',
    videoFilter: 'setsar=100/1:max=100',
    encoderArgs: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8'],
    outputArgs: [],
  });
}

for (const fixture of fixtures) {
  const outputPath = resolve('public', fixture.fileName);
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
      fixture.input,
      '-an',
      ...(fixture.videoFilter ? ['-vf', fixture.videoFilter] : []),
      ...(fixture.encoderArgs ?? ['-c:v', 'libx264', '-profile:v', 'baseline']),
      ...(fixture.extraEncoderArgs ?? []),
      '-pix_fmt',
      'yuv420p',
      ...(fixture.outputArgs ?? ['-movflags', '+faststart']),
      '-y',
      outputPath,
    ],
    { encoding: 'utf8' }
  );

  if (result.error) {
    const error = result.error as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      throw new Error('ffmpeg is required to generate the E2E codec fixtures.');
    }
    throw error;
  }
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed to generate ${fixture.fileName}:\n${result.stderr.trim()}`);
  }

  const size = statSync(outputPath).size;
  if (size === 0) {
    throw new Error(`Generated an empty E2E codec fixture: ${outputPath}`);
  }

  console.log(`[e2e-fixture] Generated ${outputPath} (${size} bytes)`);
}
