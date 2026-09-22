#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

interface VideoFixture {
  fileName: string;
  input: string;
  videoFilter?: string;
  encoderArgs?: string[];
  extraEncoderArgs?: string[];
  outputArgs?: string[];
  displayRotation?: number;
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
  {
    fileName: 'test-video-contract-cfr.mp4',
    input:
      'color=c=black:size=96x64:rate=4:duration=1,' +
      "drawbox=c=red:t=fill:enable='eq(n,0)'," +
      "drawbox=c=lime:t=fill:enable='eq(n,1)'," +
      "drawbox=c=blue:t=fill:enable='eq(n,2)'," +
      "drawbox=c=yellow:t=fill:enable='eq(n,3)'",
    extraEncoderArgs: ['-g', '1'],
  },
  {
    fileName: 'test-video-contract-vfr-par.mp4',
    input:
      'color=c=black:size=96x64:rate=100:duration=1,' +
      "drawbox=c=red:t=fill:enable='lt(t,0.12)'," +
      "drawbox=c=lime:t=fill:enable='between(t,0.12,0.399)'," +
      "drawbox=c=blue:t=fill:enable='between(t,0.4,0.749)'," +
      "drawbox=c=yellow:t=fill:enable='gte(t,0.75)'," +
      "select='eq(n,0)+eq(n,12)+eq(n,40)+eq(n,75)',setsar=2/1",
    extraEncoderArgs: ['-g', '1', '-fps_mode', 'vfr', '-enc_time_base', '1/100'],
  },
  {
    fileName: 'test-video-contract-rotate-90.mp4',
    input:
      'color=c=black:size=80x48:rate=4:duration=1,' +
      "drawbox=c=red:t=fill:enable='eq(n,0)'," +
      "drawbox=c=lime:t=fill:enable='eq(n,1)'," +
      "drawbox=c=blue:t=fill:enable='eq(n,2)'," +
      "drawbox=c=yellow:t=fill:enable='eq(n,3)'," +
      'drawbox=x=0:y=0:w=12:h=12:c=white:t=fill,' +
      'drawbox=x=68:y=0:w=12:h=12:c=black:t=fill,' +
      'drawbox=x=0:y=36:w=12:h=12:c=cyan:t=fill,' +
      'drawbox=x=68:y=36:w=12:h=12:c=magenta:t=fill',
    extraEncoderArgs: ['-g', '1'],
    displayRotation: 90,
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
  const encodedPath =
    fixture.displayRotation === undefined ? outputPath : `${outputPath}.unrotated.mp4`;

  try {
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
        encodedPath,
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

    if (fixture.displayRotation !== undefined) {
      const rotationResult = spawnSync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-display_rotation',
          String(fixture.displayRotation),
          '-i',
          encodedPath,
          '-map',
          '0:v:0',
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          '-y',
          outputPath,
        ],
        { encoding: 'utf8' }
      );
      if (rotationResult.status !== 0) {
        throw new Error(
          `ffmpeg failed to add display rotation to ${fixture.fileName}:\n${rotationResult.stderr.trim()}`
        );
      }
    }

    const size = statSync(outputPath).size;
    if (size === 0) {
      throw new Error(`Generated an empty E2E codec fixture: ${outputPath}`);
    }

    console.log(`[e2e-fixture] Generated ${outputPath} (${size} bytes)`);
  } finally {
    if (encodedPath !== outputPath) rmSync(encodedPath, { force: true });
  }
}
