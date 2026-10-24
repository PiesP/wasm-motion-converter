#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

interface VideoFixture {
  fileName: string;
  input: string;
  outputDirectory?: string;
  videoFilter?: string;
  encoderArgs?: string[];
  extraEncoderArgs?: string[];
  outputArgs?: string[];
  displayRotation?: number;
  requiresReorderedFrames?: boolean;
  finalSampleDurationMs?: number;
  attachedTextBytes?: number;
}

/** Adjust only the final singleton sample in the small, ordinary MP4 fixture. */
function setFinalSampleDuration(path: string, durationMs: number): void {
  const bytes = readFileSync(path);
  const boxes = new Map<string, number>();
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts']);
  const visit = (start: number, end: number, depth: number): void => {
    if (depth > 8) throw new Error('Fixture MP4 nesting exceeds the bounded parser');
    for (let offset = start; offset + 8 <= end;) {
      const size = bytes.readUInt32BE(offset);
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (size < 8 || size > end - offset) throw new Error('Invalid fixture MP4 box');
      boxes.set(type, offset);
      if (containers.has(type)) visit(offset + 8, offset + size, depth + 1);
      offset += size;
    }
  };
  visit(0, bytes.length, 0);
  const box = (type: string): number => {
    const offset = boxes.get(type);
    if (offset === undefined || bytes[offset + 8] !== 0) {
      throw new Error(`Fixture requires a version-zero ${type} box`);
    }
    return offset;
  };
  const stts = box('stts');
  const entries = bytes.readUInt32BE(stts + 12);
  if (entries < 1 || entries > 16) throw new Error('Unexpected fixture time table');
  const lastEntry = stts + 16 + (entries - 1) * 8;
  if (bytes.readUInt32BE(lastEntry) !== 1) throw new Error('Final fixture sample is not singleton');
  const mdhd = box('mdhd');
  const timescale = bytes.readUInt32BE(mdhd + 20);
  bytes.writeUInt32BE(Math.round((durationMs * timescale) / 1000), lastEntry + 4);
  let duration = 0;
  for (let entry = stts + 16; entry <= lastEntry; entry += 8) {
    duration += bytes.readUInt32BE(entry) * bytes.readUInt32BE(entry + 4);
  }
  bytes.writeUInt32BE(duration, mdhd + 24);
  const mvhd = box('mvhd');
  const movieDuration = Math.round((duration * bytes.readUInt32BE(mvhd + 20)) / timescale);
  bytes.writeUInt32BE(movieDuration, mvhd + 24);
  bytes.writeUInt32BE(movieDuration, box('tkhd') + 28);
  const elst = box('elst');
  if (bytes.readUInt32BE(elst + 12) !== 1 || bytes.readInt32BE(elst + 20) !== 0) {
    throw new Error('Fixture has an unexpected edit list');
  }
  bytes.writeUInt32BE(movieDuration, elst + 16);
  writeFileSync(path, bytes);
}

const CFR_MARKERS =
  'color=c=black:size=96x64:rate=4:duration=1,' +
  "drawbox=c=red:t=fill:enable='eq(n,0)'," +
  "drawbox=c=lime:t=fill:enable='eq(n,1)'," +
  "drawbox=c=blue:t=fill:enable='eq(n,2)'," +
  "drawbox=c=yellow:t=fill:enable='eq(n,3)'";

const PERF_MARKER_COLORS = ['red', 'lime', 'blue', 'yellow'] as const;
const PERF_MARKER_DRAWS = Array.from({ length: 12 }, (_, block) => {
  const color = PERF_MARKER_COLORS[block % PERF_MARKER_COLORS.length]!;
  const firstFrame = block * 12;
  const lastFrame = firstFrame + 11;
  return `drawbox=c=${color}:t=fill:enable='between(n,${firstFrame},${lastFrame})'`;
}).join(',');

export function generateE2eVideo(): void {
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
      input: CFR_MARKERS,
      extraEncoderArgs: ['-g', '1'],
    },
    {
      fileName: 'test-video-contract-motion-120fps.mp4',
      input: `color=c=black:size=320x180:rate=120:duration=1.2,${PERF_MARKER_DRAWS}`,
      extraEncoderArgs: ['-preset', 'ultrafast', '-crf', '18', '-g', '1'],
    },
    {
      // Seven nominal 60-fps PTS rounded to milliseconds, with an exact 110-ms endpoint.
      fileName: 'test-video-contract-short-tail.mp4',
      input:
        'color=c=black:size=96x64:rate=1000:duration=0.11,' +
        "drawbox=c=red:t=fill:enable='lt(t,0.05)'," +
        "drawbox=c=lime:t=fill:enable='between(t,0.05,0.099)'," +
        "drawbox=c=blue:t=fill:enable='gte(t,0.1)'," +
        "select='eq(n,0)+eq(n,17)+eq(n,33)+eq(n,50)+eq(n,67)+eq(n,83)+eq(n,100)'",
      extraEncoderArgs: [
        '-g',
        '1',
        '-fps_mode',
        'vfr',
        '-enc_time_base',
        '1/1000',
        '-video_track_timescale',
        '1000',
      ],
      finalSampleDurationMs: 10,
    },
    {
      // The metadata's first 50 packets are 60 fps; the trimmed segment is sparse VFR.
      fileName: 'test-video-contract-integer-vfr.mp4',
      input:
        'color=c=white:size=96x64:rate=60:duration=5.02,' +
        "drawbox=c=red:t=fill:enable='eq(n,60)'," +
        "drawbox=c=lime:t=fill:enable='eq(n,120)'," +
        "drawbox=c=blue:t=fill:enable='eq(n,180)'," +
        "drawbox=c=yellow:t=fill:enable='eq(n,240)'," +
        "select='lt(n,60)+eq(n,60)+eq(n,120)+eq(n,180)+eq(n,240)+eq(n,300)'",
      extraEncoderArgs: ['-g', '1', '-fps_mode', 'vfr', '-enc_time_base', '1/60'],
    },
    {
      fileName: 'test-video-contract-pressure-21fps.mp4',
      input:
        'color=c=black:size=96x64:rate=21:duration=1,' +
        "drawbox=c=red:t=fill:enable='lt(n,7)'," +
        "drawbox=c=lime:t=fill:enable='between(n,7,13)'," +
        "drawbox=c=blue:t=fill:enable='gte(n,14)'",
      extraEncoderArgs: ['-g', '1'],
    },
    {
      fileName: 'test-video-contract-bframes.mp4',
      input: CFR_MARKERS,
      encoderArgs: ['-c:v', 'libx264', '-profile:v', 'main'],
      extraEncoderArgs: ['-bf', '2', '-x264-params', 'b-adapt=0:scenecut=0:keyint=4:min-keyint=4'],
      requiresReorderedFrames: true,
    },
    {
      fileName: 'test-video-contract-vp9.webm',
      input: CFR_MARKERS,
      encoderArgs: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '24', '-g', '1'],
      outputArgs: [],
    },
    {
      fileName: 'test-video-matroska-metadata.mkv',
      input: CFR_MARKERS,
      encoderArgs: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '24', '-g', '1'],
      outputArgs: ['-metadata', 'title=matroska-skip', '-metadata', 'artist=fixture-artist'],
      attachedTextBytes: 128,
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

  if (process.env.PREPARE_TRIM_SUBMISSION_FIXTURE === 'true') {
    fixtures.push({
      fileName: 'trim-submission.mp4',
      outputDirectory: 'validation/windows/inputs',
      input:
        'testsrc2=size=640x360:rate=30:duration=10,' +
        "drawtext=font=Sans:text='%{pts\\:hms}':fontsize=64:fontcolor=white:" +
        'box=1:boxcolor=black@0.8:x=32:y=32',
      extraEncoderArgs: ['-preset', 'ultrafast', '-crf', '22'],
    });
  }

  if (process.env.PREPARE_RESOURCE_FIXTURES === 'true') {
    fixtures.push({
      fileName: 'test-video-resource-hostile-par.webm',
      input: 'testsrc=size=520x520:rate=1:duration=1',
      videoFilter: 'setsar=100/1:max=100',
      encoderArgs: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8'],
      outputArgs: [],
    });
  }

  function assertReorderedFrames(path: string): void {
    const probe = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=has_b_frames:frame=pict_type:packet=pts,dts',
        '-of',
        'json',
        path,
      ],
      { encoding: 'utf8' }
    );
    if (probe.error) throw probe.error;
    if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr.trim()}`);
    const observation = JSON.parse(probe.stdout) as {
      streams?: Array<{ has_b_frames?: number }>;
      packets_and_frames?: Array<{ type?: string; pict_type?: string; pts?: number; dts?: number }>;
    };
    const entries = observation.packets_and_frames ?? [];
    const packets = entries.filter((entry) => entry.type === 'packet');
    const reordered = packets.some((packet, index) => {
      const previous = packets[index - 1];
      return previous?.pts !== undefined && packet.pts !== undefined && packet.pts < previous.pts;
    });
    const decodeOrder = packets.every((packet, index) => {
      const previous = packets[index - 1];
      return (
        Number.isFinite(packet.pts) &&
        Number.isFinite(packet.dts) &&
        (index === 0 || (previous?.dts !== undefined && packet.dts! > previous.dts))
      );
    });
    if (
      !((observation.streams?.[0]?.has_b_frames ?? 0) > 0) ||
      !entries.some((entry) => entry.type === 'frame' && entry.pict_type === 'B') ||
      !reordered ||
      !decodeOrder
    ) {
      throw new Error(`Fixture lacks verified B-frame presentation/decode reordering: ${path}`);
    }
  }
  for (const fixture of fixtures) {
    const outputPath = resolve(fixture.outputDirectory ?? 'public', fixture.fileName);
    mkdirSync(dirname(outputPath), { recursive: true });
    const encodedPath =
      fixture.displayRotation === undefined ? outputPath : `${outputPath}.unrotated.mp4`;
    const attachmentBytes = fixture.attachedTextBytes ?? 0;
    const attachmentPath = attachmentBytes > 0 ? `${outputPath}.attachment.txt` : undefined;

    try {
      if (attachmentPath) {
        writeFileSync(attachmentPath, new Uint8Array(attachmentBytes).fill(0x61));
      }
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
          ...(attachmentPath
            ? ['-attach', attachmentPath, '-metadata:s:t', 'mimetype=text/plain']
            : []),
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

      if (fixture.finalSampleDurationMs !== undefined) {
        setFinalSampleDuration(outputPath, fixture.finalSampleDurationMs);
      }
      const mediaBytes = attachmentPath ? readFileSync(outputPath) : undefined;
      const size = mediaBytes?.byteLength ?? statSync(outputPath).size;
      if (size === 0) {
        throw new Error(`Generated an empty E2E codec fixture: ${outputPath}`);
      }
      if (fixture.requiresReorderedFrames) assertReorderedFrames(outputPath);
      if (mediaBytes) {
        const probe = spawnSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-show_entries',
            'format_tags=title,ARTIST:stream=codec_type:stream_tags=mimetype',
            '-of',
            'json',
            outputPath,
          ],
          { encoding: 'utf8' }
        );
        if (probe.error) throw probe.error;
        if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr.trim()}`);
        const metadata = JSON.parse(probe.stdout) as {
          format?: { tags?: { title?: string; ARTIST?: string } };
          streams?: Array<{ codec_type?: string; tags?: { mimetype?: string } }>;
        };
        if (
          metadata.format?.tags?.title !== 'matroska-skip' ||
          metadata.format?.tags?.ARTIST !== 'fixture-artist' ||
          !metadata.streams?.some(
            (stream) => stream.codec_type === 'attachment' && stream.tags?.mimetype === 'text/plain'
          )
        ) {
          throw new Error('Matroska fixture lacks its tag or attachment');
        }
        const clusterOffset = mediaBytes.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]));
        const tagOffset = mediaBytes.indexOf('fixture-artist');
        const attachmentOffset = mediaBytes.indexOf(Buffer.alloc(attachmentBytes, 0x61));
        if (
          clusterOffset <= 0 ||
          tagOffset <= 0 ||
          attachmentOffset <= 0 ||
          tagOffset >= clusterOffset ||
          attachmentOffset >= clusterOffset
        ) {
          throw new Error('Matroska fixture metadata must precede the first cluster');
        }
      }

      console.log(`[e2e-fixture] Generated ${outputPath} (${size} bytes)`);
    } finally {
      if (encodedPath !== outputPath) rmSync(encodedPath, { force: true });
      if (attachmentPath) rmSync(attachmentPath, { force: true });
    }
  }
}

if (import.meta.main) generateE2eVideo();
