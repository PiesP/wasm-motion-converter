// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CAPTURE_MS = 2_000;
const MAX_CAPTURE_FRAMES = 256;
const MAX_SAMPLE_GAP_MS = 35;
const MAX_CYCLE_ERROR_MS = 35;
const MAX_MEDIAN_CYCLE_ERROR_MS = 20;
const MIN_COMPLETE_CYCLES = 3;
const COLORS = ['red', 'lime', 'blue'];

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function need(bytes, offset, length, what) {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    throw new RangeError(`Truncated ${what}`);
  }
}

function skipGifSubblocks(bytes, offset) {
  for (;;) {
    need(bytes, offset, 1, 'GIF sub-block size');
    const size = bytes[offset++];
    if (size === 0) return offset;
    need(bytes, offset, size, 'GIF sub-block');
    offset += size;
  }
}

/** Read every image record's raw Graphic Control Extension delay, including continuations. */
export function parseGifDelaysCs(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  need(bytes, 0, 13, 'GIF header');
  const signature = Buffer.from(bytes.subarray(0, 6)).toString('ascii');
  if (signature !== 'GIF89a' && signature !== 'GIF87a') throw new Error('Invalid GIF signature');
  let offset = 13;
  if (bytes[10] & 0x80) offset += 3 * (1 << ((bytes[10] & 7) + 1));
  need(bytes, 0, offset, 'GIF global palette');
  const delaysCs = [];
  let pendingDelayCs = null;
  let trailer = false;
  while (offset < bytes.byteLength) {
    const marker = bytes[offset++];
    if (marker === 0x3b) {
      trailer = true;
      break;
    }
    if (marker === 0x21) {
      need(bytes, offset, 1, 'GIF extension label');
      const label = bytes[offset++];
      if (label === 0xf9) {
        need(bytes, offset, 6, 'GIF Graphic Control Extension');
        if (pendingDelayCs !== null || bytes[offset] !== 4 || bytes[offset + 5] !== 0) {
          throw new Error('Invalid GIF Graphic Control Extension');
        }
        pendingDelayCs = bytes[offset + 2] | (bytes[offset + 3] << 8);
        offset += 6;
      } else {
        offset = skipGifSubblocks(bytes, offset);
      }
      continue;
    }
    if (marker !== 0x2c) throw new Error(`Unexpected GIF record 0x${marker.toString(16)}`);
    need(bytes, offset, 9, 'GIF image descriptor');
    const packed = bytes[offset + 8];
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

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function paeth(a, b, c) {
  const prediction = a + b - c;
  const da = Math.abs(prediction - a);
  const db = Math.abs(prediction - b);
  const dc = Math.abs(prediction - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}

/** Decode only PNG screenshot bytes; the page's GIF remains an ordinary animated img. */
function centerPngRgb(bytes) {
  if (!Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE)) throw new Error('Invalid PNG signature');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let colorType = 0;
  let palette = null;
  const idat = [];
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
      colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0 || width < 1 || height < 1 || width * height > 1_048_576) {
        throw new Error('Unsupported PNG screenshot geometry');
      }
      channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] ?? 0;
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
  const reds = [];
  const greens = [];
  const blues = [];
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++];
    const row = Buffer.allocUnsafe(stride);
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? row[index - channels] : 0;
      const above = previous[index];
      const upperLeft = index >= channels ? previous[index - channels] : 0;
      const predictor = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, upperLeft)][filter];
      if (predictor === undefined) throw new Error(`Unsupported PNG filter ${filter}`);
      row[index] = (raw[cursor++] + predictor) & 255;
    }
    if (Math.abs(y - cy) <= 4) {
      for (let x = Math.max(0, cx - 4); x <= Math.min(width - 1, cx + 4); x++) {
        const pixel = x * channels;
        if (colorType === 3) {
          const entry = row[pixel] * 3;
          if (!palette || entry + 2 >= palette.byteLength) throw new Error('Invalid PNG palette index');
          reds.push(palette[entry]);
          greens.push(palette[entry + 1]);
          blues.push(palette[entry + 2]);
        } else if (colorType === 0 || colorType === 4) {
          reds.push(row[pixel]);
          greens.push(row[pixel]);
          blues.push(row[pixel]);
        } else {
          reds.push(row[pixel]);
          greens.push(row[pixel + 1]);
          blues.push(row[pixel + 2]);
        }
      }
    }
    previous = row;
  }
  return { width, height, rgb: [median(reds), median(greens), median(blues)] };
}

function classify(rgb) {
  const [red, green, blue] = rgb;
  if (red >= 140 && red > green * 1.6 && red > blue * 1.6) return 'red';
  if (green >= 140 && green > red * 1.6 && green > blue * 1.6) return 'lime';
  if (blue >= 140 && blue > red * 1.6 && blue > green * 1.6) return 'blue';
  return null;
}

export function inspectPlaybackPng(bytes) {
  const decoded = centerPngRgb(bytes);
  return { ...decoded, marker: classify(decoded.rgb) };
}

/** Analyze compositor screenshots in CDP event order, without any GIF frame stepping. */
export function analyzeGifPlaybackFrames(frames) {
  const errors = [];
  const runs = [];
  let seenColor = false;
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (!Number.isFinite(frame.timestampMs)) errors.push(`Missing CDP timestamp at frame ${index}`);
    if (index && frame.timestampMs < frames[index - 1].timestampMs) {
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
      last.lastMs = frame.timestampMs;
      last.lastSequence = frame.sequence;
    } else {
      runs.push({
        marker: frame.marker,
        startMs: frame.timestampMs,
        lastMs: frame.timestampMs,
        firstSequence: frame.sequence,
        lastSequence: frame.sequence,
      });
    }
  }
  const transitions = [];
  for (let index = 1; index < runs.length; index++) {
    const previous = runs[index - 1];
    const current = runs[index];
    const expected = COLORS[(COLORS.indexOf(previous.marker) + 1) % COLORS.length];
    const gapMs = current.startMs - previous.lastMs;
    transitions.push({ from: previous.marker, to: current.marker, timestampMs: current.startMs, gapMs });
    if (current.marker !== expected) errors.push(`Missing ${expected} transition before ${current.marker}`);
    if (!Number.isFinite(gapMs) || gapMs > MAX_SAMPLE_GAP_MS || gapMs < 0) {
      errors.push(`Transition sample gap ${gapMs}ms exceeds ${MAX_SAMPLE_GAP_MS}ms`);
    }
  }
  const firstRed = runs.findIndex((run) => run.marker === 'red');
  const cycles = [];
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
        startMs: starts[0],
        endMs: starts[3],
        durationMs: starts[3] - starts[0],
        holdsMs: [starts[1] - starts[0], starts[2] - starts[1], starts[3] - starts[2]],
      });
    }
  }
  const completeEnd = firstRed >= 0 ? firstRed + cycles.length * 3 : -1;
  return {
    errors,
    runs,
    transitions,
    cycles,
    incompleteLead: firstRed < 0 ? runs.map((run) => run.marker) : runs.slice(0, firstRed).map((run) => run.marker),
    incompleteTail: runs.slice(Math.max(0, completeEnd + 1)).map((run) => run.marker),
  };
}

async function pageVisibility(page) {
  return page.evaluate(() => {
    const img = document.querySelector('#playback-gif');
    const box = img?.getBoundingClientRect();
    return {
      wallEpochMs: Date.now(),
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      imageSrcAssigned: img?.hasAttribute('src') ?? false,
      imageComplete: img?.complete ?? false,
      naturalWidth: img?.naturalWidth ?? 0,
      naturalHeight: img?.naturalHeight ?? 0,
      imageCenterVisible: !!box && box.width >= 100 && box.height >= 100 &&
        box.left <= innerWidth / 2 && box.right >= innerWidth / 2 &&
        box.top <= innerHeight / 2 && box.bottom >= innerHeight / 2,
    };
  });
}

/** Collect a bounded, normal-img, installed-Chromium compositor screencast. */
export async function collectGifPlayback({ context, gifBytes, outputRoot, artifacts, label }) {
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error('GIF playback label must be a safe slug');
  if (!(gifBytes instanceof Uint8Array) || gifBytes.byteLength < 1 || gifBytes.byteLength > 16 * 1024 * 1024) {
    throw new RangeError('GIF playback input must be a bounded Uint8Array');
  }
  await mkdir(outputRoot, { recursive: true });
  const output = {
    schemaVersion: 1,
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
    status: 'inconclusive',
  };
  const captures = [];
  const pendingAcks = new Set();
  let page;
  let session;
  let screencastStarted = false;
  let visibilityTimer;
  let visibilityPending = false;
  let visibilityPromise;
  let visibilityEventOverflow = false;
  let acceptingFrames = true;
  let onFrame;
  let onVisibility;
  try {
    try {
      output.rawGceDelaysCs = parseGifDelaysCs(gifBytes);
    } catch (error) {
      output.errors.push(`GIF parser: ${error.message}`);
    }
    page = await context.newPage();
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      html,body { margin:0; width:100%; height:100%; background:#fff; }
      body { display:grid; place-items:center; }
      #playback-gif { width:240px; height:240px; object-fit:fill; image-rendering:pixelated; }
      #sampling-pulse { position:fixed; top:0; left:0; width:2px; height:2px;
        animation:pulse 32ms steps(2,end) infinite; }
      @keyframes pulse { from { background:#000; } to { background:#fff; } }
    </style></head><body><img id="playback-gif" tabindex="0" alt="GIF playback sample"><div id="sampling-pulse"></div></body></html>`);
    await page.bringToFront();
    await page.focus('#playback-gif');
    output.browserIdentity.userAgent = await page.evaluate(() => navigator.userAgent);
    output.visibility.push(await pageVisibility(page));
    session = await context.newCDPSession(page);
    await session.send('Page.enable');
    onFrame = (event) => {
      const ack = session.send('Page.screencastFrameAck', { sessionId: event.sessionId });
      pendingAcks.add(ack);
      ack.catch((error) => output.errors.push(`Screencast ack: ${error.message}`))
        .finally(() => pendingAcks.delete(ack));
      output.captureEventCount++;
      if (!acceptingFrames) return;
      if (captures.length >= MAX_CAPTURE_FRAMES) {
        output.overflow = true;
        return;
      }
      captures.push({
        sequence: captures.length,
        timestampMs: typeof event.metadata?.timestamp === 'number' ? event.metadata.timestamp * 1000 : null,
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
      format: 'png', everyNthFrame: 1, maxWidth: 640, maxHeight: 480,
    });
    screencastStarted = true;
    const base64 = Buffer.from(gifBytes).toString('base64');
    await page.evaluate((data) => {
      const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }));
      globalThis.__gifPlaybackObjectUrl = objectUrl;
      document.querySelector('#playback-gif').src = objectUrl;
    }, base64);
    await page.waitForFunction(() => {
      const img = document.querySelector('#playback-gif');
      return img?.complete && img.naturalWidth > 0;
    }, null, { timeout: 5_000 });
    output.visibility.push(await pageVisibility(page));
    visibilityTimer = setInterval(() => {
      if (visibilityPending || output.visibility.length >= 24) return;
      visibilityPending = true;
      visibilityPromise = pageVisibility(page).then(
        (value) => output.visibility.push(value),
        (error) => output.errors.push(`Visibility sample: ${error.message}`)
      ).finally(() => { visibilityPending = false; });
    }, 100);
    await new Promise((resolve) => setTimeout(resolve, CAPTURE_MS));
    clearInterval(visibilityTimer);
    visibilityTimer = undefined;
    output.visibility.push(await pageVisibility(page));
  } catch (error) {
    output.errors.push(`Playback collection: ${error.message}`);
  } finally {
    if (visibilityTimer) clearInterval(visibilityTimer);
    if (visibilityPromise) await visibilityPromise;
    acceptingFrames = false;
    if (screencastStarted) {
      try { await session.send('Page.stopScreencast'); }
      catch (error) { output.cleanupErrors.push(`stopScreencast: ${error.message}`); }
    }
    await Promise.allSettled([...pendingAcks]);
    if (session) {
      if (onFrame) session.off('Page.screencastFrame', onFrame);
      if (onVisibility) session.off('Page.screencastVisibilityChanged', onVisibility);
      try { await session.detach(); }
      catch (error) { output.cleanupErrors.push(`CDP detach: ${error.message}`); }
    }
    if (page) {
      try {
        await page.evaluate(() => {
          const img = document.querySelector('#playback-gif');
          if (img) img.removeAttribute('src');
          if (globalThis.__gifPlaybackObjectUrl) URL.revokeObjectURL(globalThis.__gifPlaybackObjectUrl);
          delete globalThis.__gifPlaybackObjectUrl;
        });
      } catch (error) { output.cleanupErrors.push(`Blob revoke: ${error.message}`); }
      try { await page.close(); }
      catch (error) { output.cleanupErrors.push(`player page close: ${error.message}`); }
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
      artifacts.push({ kind: 'gif-playback-frame', file, bytes: bytes.byteLength, sha256: record.sha256 });
    } catch (error) {
      output.errors.push(`PNG frame ${capture.sequence}: ${error.message}`);
    }
  }
  output.analysis = analyzeGifPlaybackFrames(output.frameRecords);
  if (output.overflow) output.errors.push(`Screencast exceeded ${MAX_CAPTURE_FRAMES} frames`);
  output.status = output.errors.length || output.cleanupErrors.length || output.analysis.errors.length
    ? 'inconclusive' : 'collected';
  const summaryFile = `${label}-observation.json`;
  const summaryBytes = Buffer.from(`${JSON.stringify(output, null, 2)}\n`);
  await writeFile(join(outputRoot, summaryFile), summaryBytes);
  artifacts.push({ kind: 'gif-playback-observation', file: summaryFile, bytes: summaryBytes.byteLength, sha256: digest(summaryBytes) });
  return output;
}

/** Apply the predeclared cadence threshold after evidence has been retained. */
export function assertGifPlayback(observation, { expectedCycleMs = 120 } = {}) {
  const errors = [...observation.errors, ...observation.cleanupErrors, ...(observation.analysis?.errors ?? [])];
  if (observation.status !== 'collected') errors.push('Playback collection was inconclusive');
  if (!observation.browserIdentity.version || !/\bEdg\/\d/.test(observation.browserIdentity.userAgent ?? '')) {
    errors.push('Installed Edge browser identity was not observed');
  }
  if (!observation.rawGceDelaysCs.length || observation.rawGceDelaysCs.some((delay) => delay < 2 || delay > 200)) {
    errors.push('GIF contains an unsafe or missing raw GCE delay');
  }
  if (!observation.frameRecords.length) errors.push('No compositor PNG frames were captured');
  if (!observation.visibility.length || observation.visibility.some((sample) =>
    sample.visibilityState !== 'visible' || !sample.hasFocus || !sample.imageCenterVisible && sample.imageComplete
  )) errors.push('Player was hidden, unfocused, or off center');
  if (!observation.visibility.some((sample) => sample.imageSrcAssigned && sample.imageComplete && sample.naturalWidth > 0) ||
      observation.visibility.some((sample) => sample.imageSrcAssigned && (!sample.imageComplete || sample.naturalWidth < 1))) {
    errors.push('Player image did not load');
  }
  if (observation.visibilityEvents.some((event) => event.visible === false)) errors.push('CDP reported a hidden player');
  const cycles = observation.analysis?.cycles ?? [];
  if (cycles.length < MIN_COMPLETE_CYCLES) errors.push(`Only ${cycles.length} complete cycles observed`);
  const cycleErrors = cycles.map((cycle) => Math.abs(cycle.durationMs - expectedCycleMs));
  if (cycleErrors.some((error) => error > MAX_CYCLE_ERROR_MS)) errors.push('A complete cycle exceeded the 35ms timestamp-error budget');
  if (cycleErrors.length && median(cycleErrors) > MAX_MEDIAN_CYCLE_ERROR_MS) {
    errors.push('Median cycle error exceeded the 20ms budget');
  }
  if (observation.overflow) errors.push('Screencast frame cap was exceeded');
  if (errors.length) {
    const error = new Error(`GIF ordinary-image playback inconclusive: ${errors.join(' | ')}`);
    error.observation = observation;
    throw error;
  }
  return observation;
}
