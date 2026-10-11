// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { GIFEncoder } from 'gifenc';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  analyzeGifPlaybackFrames,
  assertGifPlayback,
  inspectPlaybackPng,
  parseGifDelaysCs,
} from '../../validation/windows/gif-playback.mjs';

function solidPng(rgb: [number, number, number]): Buffer {
  const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.byteLength);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(9, 0);
  ihdr.writeUInt32BE(9, 4);
  ihdr[8] = 8; // 8-bit RGB
  ihdr[9] = 2;
  const row = Buffer.from([0, ...Array.from({ length: 9 }, () => rgb).flat()]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 9 }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function gifWithDelays(delaysMs: number[]): Uint8Array {
  const encoder = GIFEncoder({ auto: true });
  for (const [index, delay] of delaysMs.entries()) {
    encoder.writeFrame(Uint8Array.of(index % 2), 1, 1, {
      palette: [[255, 0, 0], [0, 0, 255]],
      delay,
      repeat: 0,
    });
  }
  encoder.finish();
  return encoder.bytes();
}

function sampledCycles() {
  const frames: Array<{ sequence: number; timestampMs: number; marker: 'red' | 'lime' | 'blue' }> = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    const start = cycle * 120;
    frames.push({ sequence: frames.length, timestampMs: start, marker: 'red' });
    if (cycle === 3) break;
    for (const [timestampMs, marker] of [
      [start + 16, 'red'], [start + 32, 'red'],
      [start + 50, 'lime'], [start + 66, 'lime'], [start + 82, 'lime'],
      [start + 100, 'blue'], [start + 116, 'blue'],
    ] as const) frames.push({ sequence: frames.length, timestampMs, marker });
  }
  return frames;
}

function observation(delaysCs: number[]) {
  const frameRecords = sampledCycles().map((frame) => ({
    ...frame,
    receivedEpochMs: 0,
    file: 'frame.png',
    bytes: 1,
    sha256: '0',
    width: 1,
    height: 1,
    rgb: [255, 0, 0],
  }));
  return {
    schemaVersion: 1 as const,
    label: 'unit-test',
    sourceSha256: '0',
    sourceBytes: 1,
    browserIdentity: { version: '154.0.0.0', userAgent: 'Edg/154.0.0.0' },
    method: 'headed-normal-img-cdp-png-screencast' as const,
    capturePolicy: {
      captureMs: 2000 as const,
      maxFrames: 256 as const,
      everyNthFrame: 1 as const,
      maxSampleGapMs: 35 as const,
      maxCycleErrorMs: 35 as const,
      maxMedianCycleErrorMs: 20 as const,
      minCompleteCycles: 3 as const,
    },
    rawGceDelaysCs: delaysCs,
    frameRecords,
    visibility: [{
      wallEpochMs: 0,
      visibilityState: 'visible',
      hasFocus: true,
      imageSrcAssigned: true,
      imageComplete: true,
      naturalWidth: 1,
      naturalHeight: 1,
      imageCenterVisible: true,
    }],
    visibilityEvents: [{ visible: true, wallEpochMs: 0 }],
    overflow: false,
    captureEventCount: frameRecords.length,
    errors: [],
    cleanupErrors: [],
    analysis: analyzeGifPlaybackFrames(frameRecords),
    status: 'collected' as const,
  };
}

describe('ordinary-image GIF playback evidence', () => {
  it('classifies the center of captured PNG bytes without decoding the GIF', () => {
    expect(inspectPlaybackPng(solidPng([255, 0, 0])).marker).toBe('red');
    expect(inspectPlaybackPng(solidPng([0, 255, 0])).marker).toBe('lime');
    expect(inspectPlaybackPng(solidPng([0, 0, 255])).marker).toBe('blue');
    expect(inspectPlaybackPng(solidPng([255, 255, 255])).marker).toBeNull();
  });

  it('reads every raw GCE delay, including a long-hold continuation', () => {
    expect(parseGifDelaysCs(gifWithDelays([50, 50, 20, 1990, 20]))).toEqual([5, 5, 2, 199, 2]);
  });

  it('reports a one-centisecond record rather than normalizing it in the parser', () => {
    const delays = parseGifDelaysCs(gifWithDelays([50, 50, 10]));
    expect(delays).toEqual([5, 5, 1]);
    expect(() => assertGifPlayback(observation(delays))).toThrow('unsafe or missing raw GCE delay');
  });

  it('rejects truncated image data instead of silently dropping the last record', () => {
    const bytes = gifWithDelays([50, 20]);
    expect(() => parseGifDelaysCs(bytes.subarray(0, bytes.byteLength - 3))).toThrow();
  });

  it('finds three complete rendered red/lime/blue/red cycles', () => {
    const result = analyzeGifPlaybackFrames(sampledCycles());
    expect(result.errors).toEqual([]);
    expect(result.cycles.map((cycle) => cycle.durationMs)).toEqual([120, 120, 120]);
    expect(result.cycles.map((cycle) => cycle.holdsMs)).toEqual([
      [50, 50, 20], [50, 50, 20], [50, 50, 20],
    ]);
    expect(assertGifPlayback(observation([5, 5, 2])).analysis.cycles).toHaveLength(3);
  });

  it('retains only documented incomplete lead and tail observations', () => {
    const frames = [
      { sequence: 0, timestampMs: -20, marker: 'blue' as const },
      ...sampledCycles().map((frame) => ({ ...frame, sequence: frame.sequence + 1 })),
      { sequence: 997, timestampMs: 376, marker: 'red' as const },
      { sequence: 998, timestampMs: 392, marker: 'red' as const },
      { sequence: 999, timestampMs: 410, marker: 'lime' as const },
    ];
    const result = analyzeGifPlaybackFrames(frames);
    expect(result.errors).toEqual([]);
    expect(result.incompleteLead).toEqual(['blue']);
    expect(result.incompleteTail).toEqual(['lime']);
    expect(result.cycles).toHaveLength(3);
  });

  it('fails on a missing color or a transition whose sample bracket exceeds 35ms', () => {
    const missing = analyzeGifPlaybackFrames([
      { sequence: 0, timestampMs: 0, marker: 'red' },
      { sequence: 1, timestampMs: 50, marker: 'lime' },
      { sequence: 2, timestampMs: 120, marker: 'red' },
    ]);
    expect(missing.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('Missing blue transition'),
      expect.stringContaining('Transition sample gap'),
    ]));
    expect(() => assertGifPlayback({ ...observation([5, 5, 2]), analysis: missing })).toThrow();
  });

  it('fails when one cycle or the median cycle exceeds its predeclared error budget', () => {
    const bad = observation([5, 5, 2]);
    bad.analysis.cycles[0]!.durationMs = 156;
    expect(() => assertGifPlayback(bad)).toThrow('35ms timestamp-error budget');
    for (const cycle of bad.analysis.cycles) cycle.durationMs = 142;
    expect(() => assertGifPlayback(bad)).toThrow('20ms budget');
  });
});
