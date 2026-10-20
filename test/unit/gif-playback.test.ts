// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { deflateSync } from 'node:zlib';

import { GIFEncoder } from 'gifenc';
import { describe, expect, it } from 'vite-plus/test';

import {
  analyzeGifPlaybackCycles,
  analyzeGifPlaybackFrames,
  assertGifPlayback,
  inspectPlaybackPng,
  parseGifDelaysCs,
} from '../../validation/windows/gif-playback.ts';

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
      palette: [
        [255, 0, 0],
        [0, 0, 255],
      ],
      delay,
      repeat: 0,
    });
  }
  encoder.finish();
  return encoder.bytes();
}

function sampledCycles() {
  const frames: Array<{ sequence: number; timestampMs: number; marker: 'red' | 'lime' | 'blue' }> =
    [];
  frames.push({ sequence: 0, timestampMs: -16, marker: 'blue' });
  for (let cycle = 0; cycle < 4; cycle++) {
    const start = cycle * 120;
    frames.push({ sequence: frames.length, timestampMs: start, marker: 'red' });
    if (cycle === 3) break;
    for (const [timestampMs, marker] of [
      [start + 16, 'red'],
      [start + 32, 'red'],
      [start + 50, 'lime'],
      [start + 66, 'lime'],
      [start + 82, 'lime'],
      [start + 100, 'blue'],
      [start + 116, 'blue'],
    ] as const)
      frames.push({ sequence: frames.length, timestampMs, marker });
  }
  return frames;
}

function sampledScopedCycles(durationsMs: number[], blueCycle = -1, sparseCycle = -1) {
  const frames: Array<{ sequence: number; timestampMs: number; marker: 'red' | 'lime' | 'blue' }> =
    [];
  let startMs = 0;
  const add = (timestampMs: number, marker: 'red' | 'lime' | 'blue') => {
    frames.push({ sequence: frames.length, timestampMs, marker });
  };
  add(-16, 'lime');
  for (const [cycle, durationMs] of durationsMs.entries()) {
    const nextRedMs = startMs + durationMs;
    const limeMs = startMs + durationMs / 2;
    add(startMs, 'red');
    add(limeMs - 32, 'red');
    add(limeMs, 'lime');
    if (cycle !== sparseCycle) add(nextRedMs - 32, 'lime');
    if (cycle === blueCycle) add(nextRedMs - 16, 'blue');
    startMs = nextRedMs;
  }
  add(startMs, 'red');
  return frames;
}

function sampledMissingLime(sparseRedToBlue = false) {
  const frames = sampledScopedCycles([128, 128, 128, 128]);
  for (const frame of frames) {
    if (frame.timestampMs === 448 || frame.timestampMs === 480) frame.marker = 'blue';
  }
  if (sparseRedToBlue) {
    frames.splice(
      frames.findIndex((frame) => frame.timestampMs === 416),
      1
    );
    frames.forEach((frame, sequence) => {
      frame.sequence = sequence;
    });
  }
  return frames;
}

function observation(delaysCs: number[], frames = sampledCycles()) {
  const frameRecords = frames.map((frame) => ({
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
    schemaVersion: 2 as const,
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
      samplingPulseCssPx: 16 as const,
      samplingPulseMs: 48 as const,
    },
    rawGceDelaysCs: delaysCs,
    frameRecords,
    visibility: [
      {
        wallEpochMs: 0,
        visibilityState: 'visible',
        hasFocus: true,
        imageSrcAssigned: true,
        imageComplete: true,
        naturalWidth: 1,
        naturalHeight: 1,
        imageCenterVisible: true,
      },
    ],
    visibilityEvents: [{ visible: true, wallEpochMs: 0 }],
    overflow: false,
    captureEventCount: frameRecords.length,
    errors: [],
    cleanupErrors: [],
    analysis: analyzeGifPlaybackFrames(frameRecords),
    cycleAnalysis: analyzeGifPlaybackCycles(frameRecords),
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
      [50, 50, 20],
      [50, 50, 20],
      [50, 50, 20],
    ]);
    expect(assertGifPlayback(observation([5, 5, 2])).analysis.cycles).toHaveLength(3);
  });

  it('qualifies 32ms-bracketed red/lime returns while full RGB diagnosis stays inconclusive', () => {
    const frames = sampledScopedCycles([128, 128, 128], 1);
    const evidence = observation([5, 5, 2], frames);
    expect(evidence.analysis.errors).toContain('Missing blue transition before red');
    expect(evidence.cycleAnalysis.cycles.map((cycle) => cycle.status)).toEqual([
      'qualified',
      'qualified',
      'qualified',
    ]);
    expect(evidence.cycleAnalysis.cycles.map((cycle) => cycle.bracketsMs)).toEqual([
      { startReturnToRed: 16, redToLime: 32, redToBlue: null, returnToRed: 32 },
      { startReturnToRed: 32, redToLime: 32, redToBlue: null, returnToRed: 16 },
      { startReturnToRed: 16, redToLime: 32, redToBlue: null, returnToRed: 32 },
    ]);
    expect(evidence.cycleAnalysis.blueVisibility).toEqual({
      observedFrames: 1,
      observedInCapture: true,
      observedQualifiedCycles: 1,
      holdMs: null,
      everyCycleVisible: 'unknown',
    });
    expect(evidence.cycleAnalysis.cycles[1]!.blue).toEqual({
      observed: true,
      holdMs: null,
      holdKnown: false,
    });
    expect(assertGifPlayback(evidence)).toBe(evidence);
  });

  it('retains sparse cycles as unknown and rejects fewer than three consecutive qualified cycles', () => {
    const frames = sampledScopedCycles([128, 128, 128], -1, 2);
    const evidence = observation([5, 5, 2], frames);
    expect(evidence.cycleAnalysis.cycles.map((cycle) => cycle.status)).toEqual([
      'qualified',
      'qualified',
      'unknown',
    ]);
    expect(evidence.cycleAnalysis.cycles[2]!.reasons).toContain('Return-to-red bracket is sparse');
    expect(evidence.cycleAnalysis.qualifiedCycleCount).toBe(2);
    expect(evidence.cycleAnalysis.maxConsecutiveQualifiedCycles).toBe(2);
    expect(() => assertGifPlayback(evidence)).toThrow('Only 2 consecutive qualified cycles');
    expect(() =>
      assertGifPlayback(observation([5, 5, 2], sampledScopedCycles([128, 128])))
    ).toThrow('Only 2 consecutive qualified cycles');
  });

  it('excludes an explicit sparse cycle when three later qualified cycles agree', () => {
    const evidence = observation(
      [5, 5, 2],
      sampledScopedCycles([128, 128, 128, 128, 128, 128], -1, 1)
    );
    expect(evidence.cycleAnalysis.cycles.map((cycle) => cycle.status)).toEqual([
      'qualified',
      'unknown',
      'unknown',
      'qualified',
      'qualified',
      'qualified',
    ]);
    expect(evidence.cycleAnalysis.maxConsecutiveQualifiedCycles).toBe(3);
    expect(evidence.cycleAnalysis.cycles[2]!.reasons).toContain(
      'Start red return bracket is sparse'
    );
    expect(assertGifPlayback(evidence)).toBe(evidence);
  });

  it('does not qualify the first observed red without a preceding return bracket', () => {
    const frames = sampledScopedCycles([128, 128, 128])
      .slice(1)
      .map((frame, sequence) => ({ ...frame, sequence }));
    const evidence = observation([5, 5, 2], frames);
    expect(evidence.cycleAnalysis.cycles.map((cycle) => cycle.status)).toEqual([
      'unknown',
      'qualified',
      'qualified',
    ]);
    expect(evidence.cycleAnalysis.cycles[0]!.bracketsMs.startReturnToRed).toBeNull();
    expect(evidence.cycleAnalysis.cycles[0]!.reasons).toContain(
      'Start red return was not observed'
    );
    expect(evidence.cycleAnalysis.incompleteTail).toEqual({ status: 'unknown', markers: ['red'] });
    expect(() => assertGifPlayback(evidence)).toThrow('Only 2 consecutive qualified cycles');
  });

  it('keeps an unbracketed startup red-to-blue sample unknown despite a narrow gap', () => {
    // Retained installed-Edge timestamps: the first red-to-blue gap is 33.685ms.
    const frames: ReturnType<typeof sampledScopedCycles> = [
      { sequence: 0, timestampMs: 1792469213193.316, marker: 'red' },
      { sequence: 1, timestampMs: 1792469213227.001, marker: 'blue' },
      { sequence: 2, timestampMs: 1792469213256.745, marker: 'red' },
      { sequence: 3, timestampMs: 1792469213287.3782, marker: 'red' },
      { sequence: 4, timestampMs: 1792469213319.35, marker: 'lime' },
      { sequence: 5, timestampMs: 1792469213347.2842, marker: 'lime' },
      { sequence: 6, timestampMs: 1792469213380.99, marker: 'red' },
      { sequence: 7, timestampMs: 1792469213410.0781, marker: 'red' },
      { sequence: 8, timestampMs: 1792469213443.517, marker: 'lime' },
      { sequence: 9, timestampMs: 1792469213476.794, marker: 'red' },
      { sequence: 10, timestampMs: 1792469213506.113, marker: 'red' },
      { sequence: 11, timestampMs: 1792469213535.341, marker: 'red' },
      { sequence: 12, timestampMs: 1792469213568.324, marker: 'lime' },
      { sequence: 13, timestampMs: 1792469213599.7542, marker: 'red' },
      { sequence: 14, timestampMs: 1792469213629.711, marker: 'red' },
      { sequence: 15, timestampMs: 1792469213662.3909, marker: 'lime' },
      { sequence: 16, timestampMs: 1792469213691.088, marker: 'lime' },
      { sequence: 17, timestampMs: 1792469213725.208, marker: 'red' },
    ];
    const evidence = observation([5, 5, 2], frames);
    expect(evidence.cycleAnalysis.cycles[0]!.bracketsMs.startReturnToRed).toBeNull();
    expect(evidence.cycleAnalysis.cycles[0]!.bracketsMs.redToBlue).toBeCloseTo(33.685, 3);
    expect(evidence.cycleAnalysis.cycles[0]!.status).toBe('unknown');
    expect(evidence.cycleAnalysis.maxConsecutiveQualifiedCycles).toBe(4);
    expect(evidence.cycleAnalysis.errors).toEqual([]);
    expect(assertGifPlayback(evidence)).toBe(evidence);
  });

  it('keeps a narrow red-to-blue sample unknown when its starting return is sparse', () => {
    const frames = sampledScopedCycles([128, 128, 128, 128]);
    frames[0]!.timestampMs = -64;
    for (const frame of frames) {
      if (frame.timestampMs === 64 || frame.timestampMs === 96) frame.marker = 'blue';
    }
    const evidence = observation([5, 5, 2], frames);
    expect(evidence.cycleAnalysis.cycles[0]!.bracketsMs.startReturnToRed).toBe(64);
    expect(evidence.cycleAnalysis.cycles[0]!.bracketsMs.redToBlue).toBe(32);
    expect(evidence.cycleAnalysis.cycles[0]!.status).toBe('unknown');
    expect(evidence.cycleAnalysis.maxConsecutiveQualifiedCycles).toBe(3);
    expect(evidence.cycleAnalysis.errors).toEqual([]);
    expect(assertGifPlayback(evidence)).toBe(evidence);
  });

  it('keeps an unclassified sample as an unknown cycle without inventing a color-order violation', () => {
    const frames: Array<{
      sequence: number;
      timestampMs: number;
      marker: 'red' | 'lime' | 'blue' | null;
    }> = [
      { sequence: 0, timestampMs: 0, marker: 'red' },
      { sequence: 1, timestampMs: 32, marker: 'red' },
      { sequence: 2, timestampMs: 64, marker: 'lime' },
      { sequence: 3, timestampMs: 96, marker: null },
      { sequence: 4, timestampMs: 128, marker: 'red' },
    ];
    const result = analyzeGifPlaybackCycles(frames);
    expect(result.errors).toEqual([]);
    expect(result.cycles[0]!.status).toBe('unknown');
    expect(result.cycles[0]!.reasons).toContain('Unclassified sample in cycle');
  });

  it('rejects a consistently wrong 200ms cycle despite narrow transition brackets', () => {
    const evidence = observation([5, 5, 2], sampledScopedCycles([200, 200, 200]));
    expect(evidence.cycleAnalysis.maxConsecutiveQualifiedCycles).toBe(3);
    expect(() => assertGifPlayback(evidence)).toThrow('35ms timestamp-error budget');
  });

  it('rejects one contradictory qualified cycle even when other cycles make the median pass', () => {
    const evidence = observation([5, 5, 2], sampledScopedCycles([128, 128, 200, 128, 128]));
    expect(evidence.cycleAnalysis.maxConsecutiveQualifiedCycles).toBe(5);
    expect(evidence.cycleAnalysis.cycles.map((cycle) => cycle.durationMs)).toEqual([
      128, 128, 200, 128, 128,
    ]);
    expect(() => assertGifPlayback(evidence)).toThrow('35ms timestamp-error budget');
  });

  it('rejects a tightly bracketed red-to-blue omission of the mandatory lime scene', () => {
    const evidence = observation([5, 5, 2], sampledMissingLime());
    expect(evidence.cycleAnalysis.maxConsecutiveQualifiedCycles).toBe(3);
    expect(evidence.cycleAnalysis.cycles[3]!.markers).toEqual(['red', 'blue', 'red']);
    expect(evidence.cycleAnalysis.cycles[3]!.bracketsMs.redToBlue).toBe(32);
    expect(evidence.cycleAnalysis.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('Mandatory lime scene omitted')])
    );
    expect(() => assertGifPlayback(evidence)).toThrow('Mandatory lime scene omitted');
  });

  it('still rejects the same narrow omission after a fully bracketed return', () => {
    const frames = sampledMissingLime();
    frames.find((frame) => frame.timestampMs === 448)!.timestampMs = 449.685;
    const evidence = observation([5, 5, 2], frames);
    expect(evidence.cycleAnalysis.cycles[3]!.bracketsMs.startReturnToRed).toBe(32);
    expect(evidence.cycleAnalysis.cycles[3]!.bracketsMs.redToBlue).toBeCloseTo(33.685, 3);
    expect(evidence.cycleAnalysis.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('Mandatory lime scene omitted')])
    );
    expect(() => assertGifPlayback(evidence)).toThrow('Mandatory lime scene omitted');
  });

  it('keeps a sparsely sampled red-to-blue omission explicitly unknown', () => {
    const evidence = observation([5, 5, 2], sampledMissingLime(true));
    expect(evidence.cycleAnalysis.cycles[3]!.markers).toEqual(['red', 'blue', 'red']);
    expect(evidence.cycleAnalysis.cycles[3]!.bracketsMs.redToBlue).toBe(64);
    expect(evidence.cycleAnalysis.cycles[3]!.status).toBe('unknown');
    expect(evidence.cycleAnalysis.errors).toEqual([]);
    expect(assertGifPlayback(evidence)).toBe(evidence);
  });

  it('rejects timestamp, sequence, and observed color order violations', () => {
    const frames = sampledScopedCycles([128, 128, 128]);
    frames[1]!.timestampMs = -20;
    frames[2]!.sequence = 0;
    const invalid = observation([5, 5, 2], frames);
    expect(invalid.cycleAnalysis.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('timestamp is out of order'),
        expect.stringContaining('sequence is out of order'),
      ])
    );
    expect(() => assertGifPlayback(invalid)).toThrow();

    const reordered = sampledScopedCycles([128, 128, 128]);
    reordered.splice(3, 0, { sequence: 0, timestampMs: 48, marker: 'blue' });
    reordered.forEach((frame, index) => {
      frame.sequence = index;
    });
    const wrongOrder = observation([5, 5, 2], reordered);
    expect(wrongOrder.cycleAnalysis.cycles[0]!.status).toBe('unknown');
    expect(wrongOrder.cycleAnalysis.errors).toContain(
      'Observed colors are out of order between red frames 1 and 6'
    );
    expect(() => assertGifPlayback(wrongOrder)).toThrow();
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
    expect(missing.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Missing blue transition'),
        expect.stringContaining('Transition sample gap'),
      ])
    );
    const sparse = observation([5, 5, 2]);
    sparse.cycleAnalysis = analyzeGifPlaybackCycles([
      { sequence: 0, timestampMs: 0, marker: 'red' },
      { sequence: 1, timestampMs: 50, marker: 'lime' },
      { sequence: 2, timestampMs: 120, marker: 'red' },
    ]);
    expect(sparse.cycleAnalysis.cycles[0]!.status).toBe('unknown');
    expect(() => assertGifPlayback(sparse)).toThrow();
  });

  it('fails when one cycle or the median cycle exceeds its predeclared error budget', () => {
    const bad = observation([5, 5, 2]);
    bad.cycleAnalysis.cycles[0]!.durationMs = 156;
    expect(() => assertGifPlayback(bad)).toThrow('35ms timestamp-error budget');
    for (const cycle of bad.cycleAnalysis.cycles) cycle.durationMs = 142;
    expect(() => assertGifPlayback(bad)).toThrow('20ms budget');
  });
});
