// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

import type { BrowserContext, CDPSession, Page } from '@playwright/test';

declare global {
  interface Window {
    __gifPlaybackObjectUrl?: string;
  }
}

export type GifPlaybackMarker = 'red' | 'lime' | 'blue';

export interface GifPlaybackFrame {
  sequence: number;
  timestampMs: number | null;
  receivedEpochMs: number;
  file: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  rgb: number[];
  marker: GifPlaybackMarker | null;
}

export interface GifPlaybackAnalysis {
  errors: string[];
  runs: Array<{
    marker: GifPlaybackMarker;
    startMs: number;
    lastMs: number;
    firstSequence: number;
    lastSequence: number;
  }>;
  transitions: Array<{
    from: GifPlaybackMarker;
    to: GifPlaybackMarker;
    timestampMs: number;
    gapMs: number;
  }>;
  cycles: Array<{
    startMs: number;
    endMs: number;
    durationMs: number;
    holdsMs: number[];
  }>;
  incompleteLead: GifPlaybackMarker[];
  incompleteTail: GifPlaybackMarker[];
}

export interface GifPlaybackCycleAnalysis {
  scope: 'observed-red-lime-red-cadence';
  errors: string[];
  invalidFrameSequences: number[];
  runs: Array<{
    marker: GifPlaybackMarker | null;
    startMs: number;
    lastMs: number;
    firstSequence: number;
    lastSequence: number;
  }>;
  cycles: Array<{
    status: 'qualified' | 'unknown';
    reasons: string[];
    markers: Array<GifPlaybackMarker | null>;
    startSequence: number;
    endSequence: number;
    startMs: number;
    endMs: number;
    durationMs: number;
    bracketsMs: {
      startReturnToRed: number | null;
      redToLime: number | null;
      redToBlue: number | null;
      returnToRed: number | null;
    };
    blue: { observed: boolean; holdMs: null; holdKnown: false };
  }>;
  qualifiedCycleCount: number;
  maxConsecutiveQualifiedCycles: number;
  incompleteLead: { status: 'unknown'; markers: Array<GifPlaybackMarker | null> } | null;
  incompleteTail: { status: 'unknown'; markers: Array<GifPlaybackMarker | null> } | null;
  blueVisibility: {
    observedFrames: number;
    observedInCapture: boolean;
    observedQualifiedCycles: number;
    holdMs: null;
    everyCycleVisible: 'unknown';
  };
}

export interface GifPlaybackObservation {
  schemaVersion: 2;
  label: string;
  sourceSha256: string;
  sourceBytes: number;
  browserIdentity: { version: string | null; userAgent: string | null };
  method: 'headed-normal-img-cdp-png-screencast';
  capturePolicy: {
    captureMs: 2000;
    maxFrames: 256;
    everyNthFrame: 1;
    maxSampleGapMs: 35;
    maxCycleErrorMs: 35;
    maxMedianCycleErrorMs: 20;
    minCompleteCycles: 3;
    samplingPulseCssPx: 16;
    samplingPulseMs: 48;
  };
  rawGceDelaysCs: number[];
  frameRecords: GifPlaybackFrame[];
  visibility: Array<{
    wallEpochMs: number;
    visibilityState: string;
    hasFocus: boolean;
    imageSrcAssigned: boolean;
    imageComplete: boolean;
    naturalWidth: number;
    naturalHeight: number;
    imageCenterVisible: boolean;
  }>;
  visibilityEvents: Array<{ visible: boolean; wallEpochMs: number }>;
  overflow: boolean;
  captureEventCount: number;
  errors: string[];
  cleanupErrors: string[];
  /** Strict red/lime/blue diagnostic; collection status does not use its errors. */
  analysis: GifPlaybackAnalysis;
  /** Scoped cadence evidence used by collection status and assertions. */
  cycleAnalysis: GifPlaybackCycleAnalysis;
  status: 'collected' | 'inconclusive';
}

export interface GifPlaybackArtifact {
  kind: 'gif-playback-frame' | 'gif-playback-observation';
  file: string;
  bytes: number;
  sha256: string;
}
type ArtifactSinkEntry = Omit<GifPlaybackArtifact, 'kind'> & { kind: string };

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CAPTURE_MS = 2_000;
const MAX_CAPTURE_FRAMES = 256;
const MAX_SAMPLE_GAP_MS = 35;
const MAX_CYCLE_ERROR_MS = 35;
const MAX_MEDIAN_CYCLE_ERROR_MS = 20;
const MIN_COMPLETE_CYCLES = 3;
const SAMPLING_PULSE_CSS_PX = 16;
const SAMPLING_PULSE_MS = 48;
const COLORS: GifPlaybackMarker[] = ['red', 'lime', 'blue'];

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function need(bytes: Uint8Array, offset: number, length: number, what: string): void {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    throw new RangeError(`Truncated ${what}`);
  }
}

function byte(bytes: Uint8Array, index: number): number {
  const value = bytes[index];
  if (value === undefined) throw new RangeError('Truncated image data');
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function skipGifSubblocks(bytes: Uint8Array, startOffset: number): number {
  let offset = startOffset;
  for (;;) {
    need(bytes, offset, 1, 'GIF sub-block size');
    const size = byte(bytes, offset++);
    if (size === 0) return offset;
    need(bytes, offset, size, 'GIF sub-block');
    offset += size;
  }
}

/** Read every image record's raw Graphic Control Extension delay, including continuations. */
export function parseGifDelaysCs(input: Uint8Array): number[] {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  need(bytes, 0, 13, 'GIF header');
  const signature = Buffer.from(bytes.subarray(0, 6)).toString('ascii');
  if (signature !== 'GIF89a' && signature !== 'GIF87a') throw new Error('Invalid GIF signature');
  let offset = 13;
  if (byte(bytes, 10) & 0x80) offset += 3 * (1 << ((byte(bytes, 10) & 7) + 1));
  need(bytes, 0, offset, 'GIF global palette');
  const delaysCs: number[] = [];
  let pendingDelayCs: number | null = null;
  let trailer = false;
  while (offset < bytes.byteLength) {
    const marker = byte(bytes, offset++);
    if (marker === 0x3b) {
      trailer = true;
      break;
    }
    if (marker === 0x21) {
      need(bytes, offset, 1, 'GIF extension label');
      const label = byte(bytes, offset++);
      if (label === 0xf9) {
        need(bytes, offset, 6, 'GIF Graphic Control Extension');
        if (pendingDelayCs !== null || byte(bytes, offset) !== 4 || byte(bytes, offset + 5) !== 0) {
          throw new Error('Invalid GIF Graphic Control Extension');
        }
        pendingDelayCs = byte(bytes, offset + 2) | (byte(bytes, offset + 3) << 8);
        offset += 6;
      } else {
        offset = skipGifSubblocks(bytes, offset);
      }
      continue;
    }
    if (marker !== 0x2c) throw new Error(`Unexpected GIF record 0x${marker.toString(16)}`);
    need(bytes, offset, 9, 'GIF image descriptor');
    const packed = byte(bytes, offset + 8);
    offset += 9;
    if (packed & 0x80) offset += 3 * (1 << ((packed & 7) + 1));
    need(bytes, offset, 1, 'GIF image palette or LZW size');
    offset++; // LZW minimum code size
    offset = skipGifSubblocks(bytes, offset);
    if (pendingDelayCs === null) throw new Error('GIF image has no Graphic Control Extension');
    delaysCs.push(pendingDelayCs);
    pendingDelayCs = null;
  }
  if (!trailer || offset !== bytes.byteLength || pendingDelayCs !== null || delaysCs.length === 0) {
    throw new Error('Incomplete GIF image records');
  }
  return delaysCs;
}

function median(numbers: number[]): number {
  const sorted = [...numbers].sort((a, b) => a - b);
  if (sorted.length === 0) throw new Error('Cannot take the median of an empty sample');
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? byteNumber(sorted, middle)
    : (byteNumber(sorted, middle - 1) + byteNumber(sorted, middle)) / 2;
}

function byteNumber(numbers: number[], index: number): number {
  const value = numbers[index];
  if (value === undefined) throw new RangeError('Missing sample');
  return value;
}

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new RangeError('Missing indexed observation');
  return item;
}

function paeth(a: number, b: number, c: number): number {
  const prediction = a + b - c;
  const da = Math.abs(prediction - a);
  const db = Math.abs(prediction - b);
  const dc = Math.abs(prediction - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}

/** Decode only PNG screenshot bytes; the page's GIF remains an ordinary animated img. */
function centerPngRgb(bytes: Buffer): {
  width: number;
  height: number;
  rgb: [number, number, number];
} {
  if (!Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE))
    throw new Error('Invalid PNG signature');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let colorType = 0;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];
  let ended = false;
  while (offset < bytes.byteLength) {
    need(bytes, offset, 12, 'PNG chunk');
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    need(bytes, offset + 8, length + 4, `PNG ${type}`);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      if (length !== 13 || width !== 0) throw new Error('Invalid PNG header');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = byte(data, 9);
      if (
        byte(data, 8) !== 8 ||
        byte(data, 12) !== 0 ||
        width < 1 ||
        height < 1 ||
        width * height > 1_048_576
      ) {
        throw new Error('Unsupported PNG screenshot geometry');
      }
      channels =
        new Map([
          [0, 1],
          [2, 3],
          [3, 1],
          [4, 2],
          [6, 4],
        ]).get(colorType) ?? 0;
      if (!channels) throw new Error(`Unsupported PNG color type ${colorType}`);
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
      break;
    }
    offset += 12 + length;
  }
  if (!ended || !width || !height || !idat.length) throw new Error('Incomplete PNG screenshot');
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.byteLength !== height * (stride + 1)) throw new Error('Invalid PNG scanline length');
  let previous = Buffer.alloc(stride);
  let cursor = 0;
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  for (let y = 0; y < height; y++) {
    const filter = byte(raw, cursor++);
    const row = Buffer.allocUnsafe(stride);
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? byte(row, index - channels) : 0;
      const above = byte(previous, index);
      const upperLeft = index >= channels ? byte(previous, index - channels) : 0;
      const predictor = [
        0,
        left,
        above,
        Math.floor((left + above) / 2),
        paeth(left, above, upperLeft),
      ][filter];
      if (predictor === undefined) throw new Error(`Unsupported PNG filter ${filter}`);
      row[index] = (byte(raw, cursor++) + predictor) & 255;
    }
    if (Math.abs(y - cy) <= 4) {
      for (let x = Math.max(0, cx - 4); x <= Math.min(width - 1, cx + 4); x++) {
        const pixel = x * channels;
        if (colorType === 3) {
          const entry = byte(row, pixel) * 3;
          if (!palette || entry + 2 >= palette.byteLength)
            throw new Error('Invalid PNG palette index');
          reds.push(byte(palette, entry));
          greens.push(byte(palette, entry + 1));
          blues.push(byte(palette, entry + 2));
        } else if (colorType === 0 || colorType === 4) {
          reds.push(byte(row, pixel));
          greens.push(byte(row, pixel));
          blues.push(byte(row, pixel));
        } else {
          reds.push(byte(row, pixel));
          greens.push(byte(row, pixel + 1));
          blues.push(byte(row, pixel + 2));
        }
      }
    }
    previous = row;
  }
  return { width, height, rgb: [median(reds), median(greens), median(blues)] };
}

function classify(rgb: [number, number, number]): GifPlaybackMarker | null {
  const [red, green, blue] = rgb;
  if (red >= 140 && red > green * 1.6 && red > blue * 1.6) return 'red';
  if (green >= 140 && green > red * 1.6 && green > blue * 1.6) return 'lime';
  if (blue >= 140 && blue > red * 1.6 && blue > green * 1.6) return 'blue';
  return null;
}

export function inspectPlaybackPng(bytes: Buffer): {
  width: number;
  height: number;
  rgb: number[];
  marker: GifPlaybackMarker | null;
} {
  const decoded = centerPngRgb(bytes);
  return { ...decoded, marker: classify(decoded.rgb) };
}

/** Analyze compositor screenshots in CDP event order, without any GIF frame stepping. */
type PlaybackFrameSample = Pick<GifPlaybackFrame, 'sequence' | 'timestampMs' | 'marker'>;

export function analyzeGifPlaybackFrames(frames: PlaybackFrameSample[]): GifPlaybackAnalysis {
  const errors: string[] = [];
  const runs: GifPlaybackAnalysis['runs'] = [];
  let seenColor = false;
  for (let index = 0; index < frames.length; index++) {
    const frame = itemAt(frames, index);
    const frameMs = frame.timestampMs ?? Number.NaN;
    if (!Number.isFinite(frame.timestampMs)) errors.push(`Missing CDP timestamp at frame ${index}`);
    if (index && frameMs < (itemAt(frames, index - 1).timestampMs ?? Number.NaN)) {
      errors.push(`CDP timestamp regressed at frame ${index}`);
    }
    if (!frame.marker) {
      if (seenColor) errors.push(`Unclassified rendered frame ${index} after playback began`);
      continue;
    }
    if (!COLORS.includes(frame.marker)) errors.push(`Unexpected color at frame ${index}`);
    seenColor = true;
    const last = runs.at(-1);
    if (last?.marker === frame.marker) {
      last.lastMs = frameMs;
      last.lastSequence = frame.sequence;
    } else {
      runs.push({
        marker: frame.marker,
        startMs: frameMs,
        lastMs: frameMs,
        firstSequence: frame.sequence,
        lastSequence: frame.sequence,
      });
    }
  }
  const transitions: GifPlaybackAnalysis['transitions'] = [];
  for (let index = 1; index < runs.length; index++) {
    const previous = itemAt(runs, index - 1);
    const current = itemAt(runs, index);
    const expected = itemAt(COLORS, (COLORS.indexOf(previous.marker) + 1) % COLORS.length);
    const gapMs = current.startMs - previous.lastMs;
    transitions.push({
      from: previous.marker,
      to: current.marker,
      timestampMs: current.startMs,
      gapMs,
    });
    if (current.marker !== expected)
      errors.push(`Missing ${expected} transition before ${current.marker}`);
    if (!Number.isFinite(gapMs) || gapMs > MAX_SAMPLE_GAP_MS || gapMs < 0) {
      errors.push(`Transition sample gap ${gapMs}ms exceeds ${MAX_SAMPLE_GAP_MS}ms`);
    }
  }
  const firstRed = runs.findIndex((run) => run.marker === 'red');
  const cycles: GifPlaybackAnalysis['cycles'] = [];
  if (firstRed < 0) errors.push('No red frame was rendered');
  else {
    for (let index = firstRed; index + 3 < runs.length; index += 3) {
      const sequence = runs.slice(index, index + 4).map((run) => run.marker);
      if (sequence.join(',') !== 'red,lime,blue,red') {
        errors.push(`Incomplete cycle starting at transition ${index}`);
        continue;
      }
      const starts = runs.slice(index, index + 4).map((run) => run.startMs);
      cycles.push({
        startMs: itemAt(starts, 0),
        endMs: itemAt(starts, 3),
        durationMs: itemAt(starts, 3) - itemAt(starts, 0),
        holdsMs: [
          itemAt(starts, 1) - itemAt(starts, 0),
          itemAt(starts, 2) - itemAt(starts, 1),
          itemAt(starts, 3) - itemAt(starts, 2),
        ],
      });
    }
  }
  const completeEnd = firstRed >= 0 ? firstRed + cycles.length * 3 : -1;
  return {
    errors,
    runs,
    transitions,
    cycles,
    incompleteLead:
      firstRed < 0
        ? runs.map((run) => run.marker)
        : runs.slice(0, firstRed).map((run) => run.marker),
    incompleteTail: runs.slice(Math.max(0, completeEnd + 1)).map((run) => run.marker),
  };
}

function longestQualifiedSequence(cycles: GifPlaybackCycleAnalysis['cycles']): number {
  let longest = 0;
  let current = 0;
  for (const cycle of cycles) {
    current = cycle.status === 'qualified' ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

/** Judge only observed red-to-lime-to-red cadence; retain sparse intervals as unknown. */
export function analyzeGifPlaybackCycles(frames: PlaybackFrameSample[]): GifPlaybackCycleAnalysis {
  const errors: string[] = [];
  const runs: GifPlaybackCycleAnalysis['runs'] = [];
  const invalidFrameSequences: number[] = [];
  for (const [index, frame] of frames.entries()) {
    const timestampMs = frame.timestampMs;
    if (timestampMs === null || !Number.isFinite(timestampMs)) {
      errors.push(`Missing CDP timestamp at frame ${index}`);
      invalidFrameSequences.push(frame.sequence);
      continue;
    }
    if (
      !Number.isSafeInteger(frame.sequence) ||
      frame.sequence < 0 ||
      (index && frame.sequence <= itemAt(frames, index - 1).sequence)
    ) {
      errors.push(`CDP frame sequence is out of order at frame ${index}`);
    }
    if (index && timestampMs <= (itemAt(frames, index - 1).timestampMs ?? Number.NaN)) {
      errors.push(`CDP timestamp is out of order at frame ${index}`);
    }
    if (frame.marker !== null && !COLORS.includes(frame.marker)) {
      errors.push(`Unexpected color at frame ${index}`);
    }
    const marker = frame.marker !== null && COLORS.includes(frame.marker) ? frame.marker : null;
    const previous = runs.at(-1);
    if (previous?.marker === marker) {
      previous.lastMs = timestampMs;
      previous.lastSequence = frame.sequence;
    } else {
      runs.push({
        marker,
        startMs: timestampMs,
        lastMs: timestampMs,
        firstSequence: frame.sequence,
        lastSequence: frame.sequence,
      });
    }
  }
  const redIndices = runs.flatMap((run, index) => (run.marker === 'red' ? [index] : []));
  if (!redIndices.length) errors.push('No red frame was rendered');
  const cycles: GifPlaybackCycleAnalysis['cycles'] = [];
  for (let index = 0; index + 1 < redIndices.length; index++) {
    const firstIndex = itemAt(redIndices, index);
    const lastIndex = itemAt(redIndices, index + 1);
    const start = itemAt(runs, firstIndex);
    const end = itemAt(runs, lastIndex);
    const middle = runs.slice(firstIndex + 1, lastIndex);
    const markers = [start, ...middle, end].map((run) => run.marker);
    const validOrder =
      (middle.length === 1 && itemAt(middle, 0).marker === 'lime') ||
      (middle.length === 2 &&
        itemAt(middle, 0).marker === 'lime' &&
        itemAt(middle, 1).marker === 'blue');
    const blueObserved = middle.some((run) => run.marker === 'blue');
    const reasons: string[] = [];
    const precedingReturn = runs[firstIndex - 1];
    const startReturnToRedMs =
      precedingReturn && (precedingReturn.marker === 'lime' || precedingReturn.marker === 'blue')
        ? start.startMs - precedingReturn.lastMs
        : null;
    let redToLimeMs: number | null = null;
    let redToBlueMs: number | null = null;
    let returnToRedMs: number | null = null;
    if (startReturnToRedMs === null) {
      reasons.push('Start red return was not observed');
    } else if (startReturnToRedMs < 0) {
      errors.push(`Negative start red bracket at frame ${start.firstSequence}`);
      reasons.push('Start red timestamp is out of order');
    } else if (startReturnToRedMs > MAX_SAMPLE_GAP_MS) {
      reasons.push('Start red return bracket is sparse');
    }
    if (!validOrder) {
      const hasUnclassified = middle.some((run) => run.marker === null);
      const hasLime = middle.some((run) => run.marker === 'lime');
      if (middle.length === 1 && itemAt(middle, 0).marker === 'blue') {
        redToBlueMs = itemAt(middle, 0).startMs - start.lastMs;
        // A bracketed return establishes a complete cycle. This fixed GIF
        // holds lime for 50ms, so a blue sample within 35ms of the last red
        // sample then proves that mandatory scene was omitted.
        if (
          startReturnToRedMs !== null &&
          Number.isFinite(startReturnToRedMs) &&
          startReturnToRedMs >= 0 &&
          startReturnToRedMs <= MAX_SAMPLE_GAP_MS &&
          redToBlueMs >= 0 &&
          redToBlueMs <= MAX_SAMPLE_GAP_MS
        ) {
          errors.push(
            `Mandatory lime scene omitted between red and blue at frame ${itemAt(middle, 0).firstSequence}`
          );
        }
      }
      reasons.push(
        hasUnclassified
          ? 'Unclassified sample in cycle'
          : hasLime
            ? 'Observed colors are out of order'
            : 'Lime transition was not observed'
      );
      if (hasLime && !hasUnclassified) {
        errors.push(
          `Observed colors are out of order between red frames ${start.firstSequence} and ${end.firstSequence}`
        );
      }
    } else {
      redToLimeMs = itemAt(middle, 0).startMs - start.lastMs;
      returnToRedMs = end.startMs - itemAt(middle, middle.length - 1).lastMs;
      if (redToLimeMs < 0 || returnToRedMs < 0) {
        errors.push(
          `Negative transition bracket between red frames ${start.firstSequence} and ${end.firstSequence}`
        );
        reasons.push('Transition timestamps are out of order');
      } else {
        if (redToLimeMs > MAX_SAMPLE_GAP_MS) reasons.push('Red-to-lime bracket is sparse');
        if (returnToRedMs > MAX_SAMPLE_GAP_MS) reasons.push('Return-to-red bracket is sparse');
      }
    }
    cycles.push({
      status: reasons.length ? 'unknown' : 'qualified',
      reasons,
      markers,
      startSequence: start.firstSequence,
      endSequence: end.firstSequence,
      startMs: start.startMs,
      endMs: end.startMs,
      durationMs: end.startMs - start.startMs,
      bracketsMs: {
        startReturnToRed: startReturnToRedMs,
        redToLime: redToLimeMs,
        redToBlue: redToBlueMs,
        returnToRed: returnToRedMs,
      },
      blue: { observed: blueObserved, holdMs: null, holdKnown: false },
    });
  }
  const qualifiedCycles = cycles.filter((cycle) => cycle.status === 'qualified');
  return {
    scope: 'observed-red-lime-red-cadence',
    errors,
    invalidFrameSequences,
    runs,
    cycles,
    qualifiedCycleCount: qualifiedCycles.length,
    maxConsecutiveQualifiedCycles: longestQualifiedSequence(cycles),
    incompleteLead:
      runs.length && (!redIndices.length || itemAt(redIndices, 0) > 0)
        ? {
            status: 'unknown',
            markers: runs
              .slice(0, redIndices.length ? itemAt(redIndices, 0) : runs.length)
              .map((run) => run.marker),
          }
        : null,
    incompleteTail:
      redIndices.length > 0
        ? {
            status: 'unknown',
            markers: runs.slice(itemAt(redIndices, redIndices.length - 1)).map((run) => run.marker),
          }
        : null,
    blueVisibility: {
      observedFrames: frames.filter((frame) => frame.marker === 'blue').length,
      observedInCapture: frames.some((frame) => frame.marker === 'blue'),
      observedQualifiedCycles: qualifiedCycles.filter((cycle) => cycle.blue.observed).length,
      holdMs: null,
      everyCycleVisible: 'unknown',
    },
  };
}

async function pageVisibility(page: Page): Promise<GifPlaybackObservation['visibility'][number]> {
  return page.evaluate(() => {
    const img = document.querySelector<HTMLImageElement>('#playback-gif');
    const box = img?.getBoundingClientRect();
    return {
      wallEpochMs: Date.now(),
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      imageSrcAssigned: img?.hasAttribute('src') ?? false,
      imageComplete: img?.complete ?? false,
      naturalWidth: img?.naturalWidth ?? 0,
      naturalHeight: img?.naturalHeight ?? 0,
      imageCenterVisible:
        !!box &&
        box.width >= 100 &&
        box.height >= 100 &&
        box.left <= innerWidth / 2 &&
        box.right >= innerWidth / 2 &&
        box.top <= innerHeight / 2 &&
        box.bottom >= innerHeight / 2,
    };
  });
}

type PlaybackDraft = Omit<GifPlaybackObservation, 'analysis' | 'cycleAnalysis'> & {
  analysis: GifPlaybackAnalysis | null;
  cycleAnalysis: GifPlaybackCycleAnalysis | null;
};

/** Collect a bounded, normal-img, installed-Chromium compositor screencast. */
export async function collectGifPlayback({
  context,
  gifBytes,
  outputRoot,
  artifacts,
  label,
}: {
  context: BrowserContext;
  gifBytes: Uint8Array;
  outputRoot: string;
  artifacts: ArtifactSinkEntry[];
  label: string;
}): Promise<GifPlaybackObservation> {
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error('GIF playback label must be a safe slug');
  if (
    !(gifBytes instanceof Uint8Array) ||
    gifBytes.byteLength < 1 ||
    gifBytes.byteLength > 16 * 1024 * 1024
  ) {
    throw new RangeError('GIF playback input must be a bounded Uint8Array');
  }
  await mkdir(outputRoot, { recursive: true });
  const output: PlaybackDraft = {
    schemaVersion: 2,
    label,
    sourceSha256: digest(gifBytes),
    sourceBytes: gifBytes.byteLength,
    browserIdentity: {
      version: context.browser()?.version() ?? null,
      userAgent: null,
    },
    method: 'headed-normal-img-cdp-png-screencast',
    capturePolicy: {
      captureMs: CAPTURE_MS,
      maxFrames: MAX_CAPTURE_FRAMES,
      everyNthFrame: 1,
      maxSampleGapMs: MAX_SAMPLE_GAP_MS,
      maxCycleErrorMs: MAX_CYCLE_ERROR_MS,
      maxMedianCycleErrorMs: MAX_MEDIAN_CYCLE_ERROR_MS,
      minCompleteCycles: MIN_COMPLETE_CYCLES,
      samplingPulseCssPx: SAMPLING_PULSE_CSS_PX,
      samplingPulseMs: SAMPLING_PULSE_MS,
    },
    rawGceDelaysCs: [],
    frameRecords: [],
    visibility: [],
    visibilityEvents: [],
    overflow: false,
    captureEventCount: 0,
    errors: [],
    cleanupErrors: [],
    analysis: null,
    cycleAnalysis: null,
    status: 'inconclusive',
  };
  const captures: Array<{
    sequence: number;
    timestampMs: number | null;
    receivedEpochMs: number;
    data: string;
  }> = [];
  const pendingAcks = new Set<Promise<unknown>>();
  let page: Page | undefined;
  let session: CDPSession | undefined;
  let screencastStarted = false;
  let visibilityTimer: ReturnType<typeof setInterval> | undefined;
  let visibilityPending = false;
  let visibilityPromise: Promise<unknown> | undefined;
  let visibilityEventOverflow = false;
  let acceptingFrames = true;
  let onFrame:
    | ((event: { sessionId: number; data: string; metadata?: { timestamp?: number } }) => void)
    | undefined;
  let onVisibility: ((event: { visible: boolean }) => void) | undefined;
  try {
    try {
      output.rawGceDelaysCs = parseGifDelaysCs(gifBytes);
    } catch (error) {
      output.errors.push(`GIF parser: ${errorMessage(error)}`);
    }
    page = await context.newPage();
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      html,body { margin:0; width:100%; height:100%; background:#fff; }
      body { display:grid; place-items:center; }
      #playback-gif { width:240px; height:240px; object-fit:fill; image-rendering:pixelated; }
      #sampling-pulse { position:fixed; top:0; left:0;
        width:${SAMPLING_PULSE_CSS_PX}px; height:${SAMPLING_PULSE_CSS_PX}px;
        animation:pulse ${SAMPLING_PULSE_MS}ms steps(2,end) infinite; }
      @keyframes pulse { from { background:#000; } to { background:#fff; } }
    </style></head><body><img id="playback-gif" tabindex="0" alt="GIF playback sample"><div id="sampling-pulse"></div></body></html>`);
    await page.bringToFront();
    await page.focus('#playback-gif');
    output.browserIdentity.userAgent = await page.evaluate(() => navigator.userAgent);
    output.visibility.push(await pageVisibility(page));
    session = await context.newCDPSession(page);
    await session.send('Page.enable');
    const currentSession = session;
    onFrame = (event) => {
      const ack = currentSession.send('Page.screencastFrameAck', { sessionId: event.sessionId });
      pendingAcks.add(ack);
      ack
        .catch((error: unknown) => output.errors.push(`Screencast ack: ${errorMessage(error)}`))
        .finally(() => pendingAcks.delete(ack));
      output.captureEventCount++;
      if (!acceptingFrames) return;
      if (captures.length >= MAX_CAPTURE_FRAMES) {
        output.overflow = true;
        return;
      }
      captures.push({
        sequence: captures.length,
        timestampMs:
          typeof event.metadata?.timestamp === 'number' ? event.metadata.timestamp * 1000 : null,
        receivedEpochMs: Date.now(),
        data: event.data,
      });
    };
    onVisibility = (event) => {
      if (output.visibilityEvents.length < 24) {
        output.visibilityEvents.push({ visible: event.visible, wallEpochMs: Date.now() });
      } else if (!visibilityEventOverflow) {
        visibilityEventOverflow = true;
        output.errors.push('Screencast visibility event cap exceeded');
      }
    };
    session.on('Page.screencastFrame', onFrame);
    session.on('Page.screencastVisibilityChanged', onVisibility);
    await session.send('Page.startScreencast', {
      format: 'png',
      everyNthFrame: 1,
      maxWidth: 640,
      maxHeight: 480,
    });
    screencastStarted = true;
    const base64 = Buffer.from(gifBytes).toString('base64');
    await page.evaluate((data) => {
      const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }));
      window.__gifPlaybackObjectUrl = objectUrl;
      const image = document.querySelector<HTMLImageElement>('#playback-gif');
      if (!image) throw new Error('GIF playback image is missing');
      image.src = objectUrl;
    }, base64);
    await page.waitForFunction(
      () => {
        const img = document.querySelector<HTMLImageElement>('#playback-gif');
        return img?.complete && img.naturalWidth > 0;
      },
      null,
      { timeout: 5_000 }
    );
    output.visibility.push(await pageVisibility(page));
    const playerPage = page;
    visibilityTimer = setInterval(() => {
      if (visibilityPending || output.visibility.length >= 24) return;
      visibilityPending = true;
      visibilityPromise = pageVisibility(playerPage)
        .then(
          (value) => output.visibility.push(value),
          (error: unknown) => output.errors.push(`Visibility sample: ${errorMessage(error)}`)
        )
        .finally(() => {
          visibilityPending = false;
        });
    }, 100);
    await new Promise<void>((resolve) => setTimeout(resolve, CAPTURE_MS));
    clearInterval(visibilityTimer);
    visibilityTimer = undefined;
    output.visibility.push(await pageVisibility(page));
  } catch (error) {
    output.errors.push(`Playback collection: ${errorMessage(error)}`);
  } finally {
    if (visibilityTimer) clearInterval(visibilityTimer);
    if (visibilityPromise) await visibilityPromise;
    acceptingFrames = false;
    if (screencastStarted && session) {
      try {
        await session.send('Page.stopScreencast');
      } catch (error) {
        output.cleanupErrors.push(`stopScreencast: ${errorMessage(error)}`);
      }
    }
    await Promise.allSettled([...pendingAcks]);
    if (session) {
      if (onFrame) session.off('Page.screencastFrame', onFrame);
      if (onVisibility) session.off('Page.screencastVisibilityChanged', onVisibility);
      try {
        await session.detach();
      } catch (error) {
        output.cleanupErrors.push(`CDP detach: ${errorMessage(error)}`);
      }
    }
    if (page) {
      try {
        await page.evaluate(() => {
          const img = document.querySelector<HTMLImageElement>('#playback-gif');
          if (img) img.removeAttribute('src');
          if (window.__gifPlaybackObjectUrl) URL.revokeObjectURL(window.__gifPlaybackObjectUrl);
          delete window.__gifPlaybackObjectUrl;
        });
      } catch (error) {
        output.cleanupErrors.push(`Blob revoke: ${errorMessage(error)}`);
      }
      try {
        await page.close();
      } catch (error) {
        output.cleanupErrors.push(`player page close: ${errorMessage(error)}`);
      }
    }
  }
  for (const capture of captures) {
    const file = `${label}-frame-${String(capture.sequence).padStart(3, '0')}.png`;
    try {
      const bytes = Buffer.from(capture.data, 'base64');
      const decoded = inspectPlaybackPng(bytes);
      const record = {
        sequence: capture.sequence,
        timestampMs: capture.timestampMs,
        receivedEpochMs: capture.receivedEpochMs,
        file,
        bytes: bytes.byteLength,
        sha256: digest(bytes),
        ...decoded,
      };
      output.frameRecords.push(record);
      await writeFile(join(outputRoot, file), bytes);
      artifacts.push({
        kind: 'gif-playback-frame',
        file,
        bytes: bytes.byteLength,
        sha256: record.sha256,
      });
    } catch (error) {
      output.errors.push(`PNG frame ${capture.sequence}: ${errorMessage(error)}`);
    }
  }
  output.analysis = analyzeGifPlaybackFrames(output.frameRecords);
  output.cycleAnalysis = analyzeGifPlaybackCycles(output.frameRecords);
  if (output.overflow) output.errors.push(`Screencast exceeded ${MAX_CAPTURE_FRAMES} frames`);
  output.status =
    output.errors.length ||
    output.cleanupErrors.length ||
    output.cycleAnalysis.errors.length ||
    output.cycleAnalysis.maxConsecutiveQualifiedCycles < MIN_COMPLETE_CYCLES
      ? 'inconclusive'
      : 'collected';
  const summaryFile = `${label}-observation.json`;
  const summaryBytes = Buffer.from(`${JSON.stringify(output, null, 2)}\n`);
  await writeFile(join(outputRoot, summaryFile), summaryBytes);
  artifacts.push({
    kind: 'gif-playback-observation',
    file: summaryFile,
    bytes: summaryBytes.byteLength,
    sha256: digest(summaryBytes),
  });
  return { ...output, analysis: output.analysis, cycleAnalysis: output.cycleAnalysis };
}

/** Apply the predeclared cadence threshold after evidence has been retained. */
export function assertGifPlayback(
  observation: GifPlaybackObservation,
  { expectedCycleMs = 120 }: { expectedCycleMs?: number } = {}
): GifPlaybackObservation {
  const errors = [
    ...observation.errors,
    ...observation.cleanupErrors,
    ...(observation.cycleAnalysis?.errors ?? []),
  ];
  if (observation.status !== 'collected') errors.push('Playback collection was inconclusive');
  if (!observation.cycleAnalysis) errors.push('Scoped cycle analysis is missing');
  if (!Number.isFinite(expectedCycleMs) || expectedCycleMs <= 0)
    errors.push('Invalid expected cycle duration');
  if (
    !observation.browserIdentity.version ||
    !/\bEdg\/\d/.test(observation.browserIdentity.userAgent ?? '')
  ) {
    errors.push('Installed Edge browser identity was not observed');
  }
  if (
    !observation.rawGceDelaysCs.length ||
    observation.rawGceDelaysCs.some((delay) => delay < 2 || delay > 200)
  ) {
    errors.push('GIF contains an unsafe or missing raw GCE delay');
  }
  if (!observation.frameRecords.length) errors.push('No compositor PNG frames were captured');
  if (
    !observation.visibility.length ||
    observation.visibility.some(
      (sample) =>
        sample.visibilityState !== 'visible' ||
        !sample.hasFocus ||
        (!sample.imageCenterVisible && sample.imageComplete)
    )
  )
    errors.push('Player was hidden, unfocused, or off center');
  if (
    !observation.visibility.some(
      (sample) => sample.imageSrcAssigned && sample.imageComplete && sample.naturalWidth > 0
    ) ||
    observation.visibility.some(
      (sample) => sample.imageSrcAssigned && (!sample.imageComplete || sample.naturalWidth < 1)
    )
  ) {
    errors.push('Player image did not load');
  }
  if (observation.visibilityEvents.some((event) => event.visible === false))
    errors.push('CDP reported a hidden player');
  const cycles = observation.cycleAnalysis?.cycles ?? [];
  const qualifiedCycles = cycles.filter((cycle) => cycle.status === 'qualified');
  const consecutiveQualifiedCycles = longestQualifiedSequence(cycles);
  if (consecutiveQualifiedCycles < MIN_COMPLETE_CYCLES) {
    errors.push(`Only ${consecutiveQualifiedCycles} consecutive qualified cycles observed`);
  }
  const cycleErrors = qualifiedCycles.map((cycle) => Math.abs(cycle.durationMs - expectedCycleMs));
  if (cycleErrors.some((error) => error > MAX_CYCLE_ERROR_MS))
    errors.push('A complete cycle exceeded the 35ms timestamp-error budget');
  if (cycleErrors.length && median(cycleErrors) > MAX_MEDIAN_CYCLE_ERROR_MS) {
    errors.push('Median cycle error exceeded the 20ms budget');
  }
  if (observation.overflow) errors.push('Screencast frame cap was exceeded');
  if (errors.length) {
    const error = new Error(`GIF ordinary-image playback inconclusive: ${errors.join(' | ')}`);
    throw Object.assign(error, { observation });
  }
  return observation;
}
