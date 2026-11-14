#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Owned synthetic compatibility inputs; output must stay outside public assets. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const output = resolve(process.argv[2] || '');
if (!process.argv[2] || output.startsWith(resolve('public')))
  throw new Error('Use an external fixture directory');
if (process.argv[3] && process.argv[3] !== '--variants')
  throw new Error('Usage: generate-owned-demux-fixtures.ts OUTPUT [--variants]');
mkdirSync(output, { recursive: true });
const cases = [
  ['avc-baseline.mp4', ['-c:v', 'libx264', '-profile:v', 'baseline', '-bf', '0']],
  [
    'avc-bframes.mp4',
    [
      '-c:v',
      'libx264',
      '-profile:v',
      'main',
      '-bf',
      '2',
      '-x264-params',
      'b-adapt=0:scenecut=0:keyint=6:min-keyint=6',
    ],
  ],
  ['avc-high.mov', ['-c:v', 'libx264', '-profile:v', 'high', '-bf', '2']],
  [
    'avc-fragmented.mp4',
    [
      '-c:v',
      'libx264',
      '-bf',
      '2',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration',
      '250000',
    ],
  ],
  [
    'hevc-hvc1.mp4',
    [
      '-c:v',
      'libx265',
      '-x265-params',
      'pools=1:frame-threads=1:log-level=error',
      '-tag:v',
      'hvc1',
    ],
  ],
  [
    'hevc-hev1.mp4',
    [
      '-c:v',
      'libx265',
      '-x265-params',
      'pools=1:frame-threads=1:log-level=error',
      '-tag:v',
      'hev1',
    ],
  ],
  ['vp9.mp4', ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8']],
  ['av1.mp4', ['-c:v', 'libaom-av1', '-cpu-used', '8']],
  [
    'vp8.webm',
    [
      '-c:v',
      'libvpx',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-live',
      '1',
      '-cluster_time_limit',
      '250',
    ],
  ],
  [
    'vp9.webm',
    [
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-live',
      '1',
      '-cluster_time_limit',
      '250',
    ],
  ],
  ['av1.webm', ['-c:v', 'libaom-av1', '-cpu-used', '8', '-live', '1']],
  ['avc.mkv', ['-c:v', 'libx264', '-bf', '2']],
  ['hevc.mkv', ['-c:v', 'libx265', '-x265-params', 'pools=1:frame-threads=1:log-level=error']],
  ['avc.ts', ['-c:v', 'libx264', '-bf', '2', '-f', 'mpegts']],
  [
    'hevc.ts',
    ['-c:v', 'libx265', '-x265-params', 'pools=1:frame-threads=1:log-level=error', '-f', 'mpegts'],
  ],
  [
    'vp9-10bit.webm',
    [
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-color_primaries',
      'bt2020',
      '-color_trc',
      'bt2020-10',
      '-colorspace',
      'bt2020nc',
    ],
  ],
  [
    'vp9-fullrange.webm',
    ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-color_range', 'pc'],
  ],
  [
    'avc-color-sar.mp4',
    [
      '-c:v',
      'libx264',
      '-x264-params',
      'colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=on',
      '-vf',
      'setsar=2/1',
      '-color_range',
      'pc',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt709',
    ],
  ],
  [
    'hevc-color-sar.mp4',
    [
      '-c:v',
      'libx265',
      '-x265-params',
      'pools=1:frame-threads=1:log-level=error:colorprim=bt709:transfer=bt709:colormatrix=bt709:range=full',
      '-vf',
      'setsar=2/1',
      '-color_range',
      'pc',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt709',
    ],
  ],
  ['avc3-inband.mp4', ['-c:v', 'libx264', '-tag:v', 'avc3', '-bsf:v', 'dump_extra']],
  ['avc-edit-prefix.mp4', ['-c:v', 'libx264', '-output_ts_offset', '0.5']],
] as const;
const manifest = [];
const selected =
  process.argv[3] === '--variants'
    ? cases.filter(([id]) =>
        [
          'vp9-10bit.webm',
          'vp9-fullrange.webm',
          'avc-color-sar.mp4',
          'hevc-color-sar.mp4',
          'avc3-inband.mp4',
          'avc-edit-prefix.mp4',
        ].includes(id)
      )
    : cases;
for (const [id, args] of selected) {
  const path = join(output, id);
  const command =
    id === 'av1.webm'
      ? [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          join(output, 'av1.mp4'),
          '-c',
          'copy',
          path,
        ]
      : [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=96x64:rate=6:duration=2',
          '-an',
          '-pix_fmt',
          id === 'vp9-10bit.webm' ? 'yuv420p10le' : 'yuv420p',
          '-threads',
          '1',
          ...args,
          path,
        ];
  const result = spawnSync('ffmpeg', command, { encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw new Error(`${id}: ${result.stderr}`);
  const bytes = readFileSync(path);
  manifest.push({
    id,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    command,
  });
}
writeFileSync(
  join(output, 'manifest.json'),
  JSON.stringify({ schema: 1, fixtures: manifest }, null, 2) + '\n'
);
