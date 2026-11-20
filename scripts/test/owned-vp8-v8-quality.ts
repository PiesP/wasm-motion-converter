// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Frozen V8 source-frame map and bounded whole-animation quality diagnostic. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readMetadata, readStableFile } from './owned-vp8-animations.ts';

const V8_SOURCE = 'c6a21a3a7619ca7fbcbc1b4d012d7098d18f599f0200f735d31cae15a4772dd1';
const V8_PRIOR_SOURCE = 'be35f5fa89a60189475fe2ef7fd446e9fa18cef4';
const V8_PRIOR_WASM = '4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22';
const V8_CANDIDATE_SOURCE = 'ffa113f5b189954c852c6e87ae6b19f380bd3f65';
const V8_CANDIDATE_WASM = 'bd170496ba1f2574bd095effdc55b7cd102b203dcc347a472141fcfbd9284b0e';
const V8_PRODUCT_REPORT = '9dfd23ca45b6f8540c78eef9444c006a74bbe4e6b8a48ddf3c3ef8ac331a2fa3';
const V8_ANIMATION_REPORT = 'f54471e8f92e4baf2e7314e118a7827aeb76ca782fb9a2c050a94756181ccf60';
const FFMPEG_SHA = 'e8a8d46f5225f3062cec7c07fb145d58ae73c603cb740dcd5bad34bfb54e455a';
const FFPROBE_SHA = 'cefc5f81c0b18429cdbf8fa5a89e1e9c759235e10f93f9b329ff1b2fdff26f46';
const SOURCE_REL = 'validation/windows/owned-vp8-inputs/v8.webm';
const SOURCE_BYTES = 3_145_371;
const SOURCE_FRAMES = 192;
const OBSERVED_FRAMES = 77;
const WIDTH = 1920;
const HEIGHT = 1080;
const RGB_BYTES = WIDTH * HEIGHT * 3;
const RGBA_BYTES = WIDTH * HEIGHT * 4;
const RAW_BUDGET = 2 * 1024 * 1024 * 1024;
const EXPECTED_RAW_BYTES = RGB_BYTES * OBSERVED_FRAMES * 3;
// Covers 174 bounded SSIM receipts, three decoder receipts, one failed partial
// RGBA frame, the map/probe receipts, JSONL rows, and final reports.
const NON_RGB_ARTIFACT_ALLOWANCE = 128 * 1024 * 1024;
const CAPTURE_INDICES = [0, 19, 38, 57, 76] as const;
const DIGEST = /^[0-9a-f]{64}$/;
const SOURCE_PTS_METADATA_MAX = 2 * 1024 * 1024;
const REPORT_MAX = 256 * 1024;
const STDERR_MAX = 64 * 1024;
const STDOUT_PREFIX_MAX = 64 * 1024;
const FFPROBE_TIMEOUT_MS = 30_000;
const SSIM_TIMEOUT_MS = 60_000;
const SOURCE_DECODE_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_DECODE_TIMEOUT_MS = 5 * 60_000;
type Build = 'prior' | 'candidate';
type ObservedRow = {
  index: number;
  frameNum: number;
  startUs: number;
  endUs: number;
  sha256: string;
};
export type MappedFrame = {
  outputIndex: number;
  sourceIndex: number;
  sourcePtsTicks: string;
  sourcePtsUs: number;
  observedFrameNum: number;
  observedStartUs: number;
  observedEndUs: number;
};
type SourceFrame = { index: number; ptsTicks: string; ptsUs: number };

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function digest(value: unknown, label: string): string {
  assert(typeof value === 'string' && DIGEST.test(value), `${label} digest is invalid`);
  return value;
}
function integer(value: unknown, label: string): number {
  assert(Number.isSafeInteger(value), `${label} is not a safe integer`);
  return value as number;
}

/** Reject rounding, ambiguous frame timestamps and source-frame-index shortcuts. */
export function exactSourceFrames(timeBase: string, ticks: readonly string[]): SourceFrame[] {
  const match = /^(\d+)\/(\d+)$/.exec(timeBase);
  assert(match, 'Source time base is not a positive rational');
  const numerator = BigInt(match[1]!);
  const denominator = BigInt(match[2]!);
  assert(numerator > 0n && denominator > 0n, 'Source time base is zero');
  assert.equal(ticks.length, SOURCE_FRAMES, 'Source decoded frame count differs');
  let previous = -1;
  return ticks.map((text, index) => {
    assert(/^-?\d+$/.test(text), `Source PTS ${index} is not an integer`);
    const scaled = BigInt(text) * numerator * 1_000_000n;
    assert.equal(scaled % denominator, 0n, `Source PTS ${index} is not an integral microsecond`);
    const us = scaled / denominator;
    assert(
      us >= 0n && us <= BigInt(Number.MAX_SAFE_INTEGER),
      `Source PTS ${index} is outside safe microseconds`
    );
    const ptsUs = Number(us);
    assert(
      index === 0 ? ptsUs === 0 : ptsUs > previous,
      `Source PTS ${index} is missing, duplicated or out of order`
    );
    assert(ptsUs < 6_400_000, `Source PTS ${index} is outside V8 duration`);
    previous = ptsUs;
    return { index, ptsTicks: text, ptsUs };
  });
}

export function mapObservedStarts(
  source: readonly SourceFrame[],
  observed: readonly ObservedRow[]
): MappedFrame[] {
  assert.equal(source.length, SOURCE_FRAMES, 'Source frame count differs');
  assert.equal(observed.length, OBSERVED_FRAMES, 'Observed frame count differs');
  const byPts = new Map<number, SourceFrame>();
  for (const frame of source) {
    assert(!byPts.has(frame.ptsUs), 'Source has duplicate PTS');
    byPts.set(frame.ptsUs, frame);
  }
  let priorIndex = -1;
  let priorFrameNum = -1;
  return observed.map((row, outputIndex) => {
    assert.equal(row.index, outputIndex, 'Observed output ordinal differs');
    const frameNum = integer(row.frameNum, 'Observed frame number');
    const startUs = integer(row.startUs, 'Observed start');
    const endUs = integer(row.endUs, 'Observed end');
    assert(
      startUs >= 0 && endUs > startUs && Math.round(endUs / 1000) <= 6400,
      'Observed presentation interval differs'
    );
    assert(frameNum > priorFrameNum, 'Observed frame numbers are not increasing');
    const match = byPts.get(startUs);
    assert(
      match && match.index > priorIndex,
      `Observed start ${startUs} has no unique ordered source PTS`
    );
    priorIndex = match.index;
    priorFrameNum = frameNum;
    return {
      outputIndex,
      sourceIndex: match.index,
      sourcePtsTicks: match.ptsTicks,
      sourcePtsUs: match.ptsUs,
      observedFrameNum: frameNum,
      observedStartUs: startUs,
      observedEndUs: endUs,
    };
  });
}

/** FFprobe's decoded-frame order and exact integer ticks, without a cadence model. */
export function parseSourceProbe(value: unknown): SourceFrame[] {
  assert(
    object(value) &&
      Array.isArray(value.streams) &&
      value.streams.length === 1 &&
      Array.isArray(value.frames),
    'V8 FFprobe stream or frames differ'
  );
  const stream: unknown = value.streams[0];
  assert(
    object(stream) &&
      stream.codec_name === 'vp9' &&
      stream.width === WIDTH &&
      stream.height === HEIGHT &&
      stream.pix_fmt === 'yuv420p' &&
      stream.color_space === 'bt709' &&
      stream.color_transfer === 'bt709' &&
      stream.color_primaries === 'bt709' &&
      stream.start_pts === 0 &&
      stream.time_base === '1/1000',
    'V8 source stream differs'
  );
  const ticks = value.frames.map((frame: unknown, index: number) => {
    assert(
      object(frame) &&
        frame.width === WIDTH &&
        frame.height === HEIGHT &&
        frame.pts === frame.best_effort_timestamp &&
        (typeof frame.pts === 'number'
          ? Number.isSafeInteger(frame.pts)
          : typeof frame.pts === 'string' && /^-?\d+$/.test(frame.pts)),
      `V8 decoded frame ${index} PTS differs`
    );
    return String(frame.pts);
  });
  return exactSourceFrames(stream.time_base, ticks);
}

/** RGB mean square error; infinity is represented by exact=true and db=null. */
export function rgbPsnr(reference: Uint8Array, decoded: Uint8Array) {
  assert.equal(reference.length, decoded.length, 'RGB extents differ');
  assert(reference.length > 0 && reference.length % 3 === 0, 'RGB extent differs');
  let sum = 0;
  for (let index = 0; index < reference.length; index++) {
    const delta = reference[index]! - decoded[index]!;
    sum += delta * delta;
  }
  const mse = sum / reference.length;
  return { mse, exact: mse === 0, db: mse === 0 ? null : 10 * Math.log10(65_025 / mse) };
}

export function qualityDelta(
  prior: { exact: boolean; db: number | null },
  candidate: { exact: boolean; db: number | null },
  priorSsim: number,
  candidateSsim: number
) {
  const psnrRelation = prior.exact
    ? candidate.exact
      ? 'both-exact'
      : 'prior-exact'
    : candidate.exact
      ? 'candidate-exact'
      : 'finite';
  const psnrDeltaDb = psnrRelation === 'finite' ? candidate.db! - prior.db! : null;
  const ssimDelta = candidateSsim - priorSsim;
  return {
    psnrRelation,
    psnrDeltaDb,
    psnrPass: candidate.exact || (!prior.exact && psnrDeltaDb !== null && psnrDeltaDb >= -1),
    ssimDelta,
    ssimPass: candidateSsim >= priorSsim - 0.01,
  };
}

function observedRows(product: Record<string, unknown>): ObservedRow[] {
  assert(
    Array.isArray(product.captures) && product.captures.length === 2,
    'Frozen V8 captures are missing'
  );
  const [left, right] = product.captures as unknown[];
  assert(
    object(left) && object(right) && left.build === 'prior' && right.build === 'candidate',
    'Frozen V8 capture order differs'
  );
  assert(
    Array.isArray(left.streamedHashes) &&
      Array.isArray(right.streamedHashes) &&
      left.streamedHashes.length === OBSERVED_FRAMES &&
      right.streamedHashes.length === OBSERVED_FRAMES,
    'Frozen V8 streamed input rows are missing'
  );
  const rightRows: unknown[] = right.streamedHashes;
  return left.streamedHashes.map((entry: unknown, index: number) => {
    const other: unknown = rightRows[index];
    assert(object(entry) && object(other), 'Frozen V8 input row is malformed');
    assert.deepEqual(entry, other, `Frozen V8 input row ${index} differs by build`);
    assert.equal(entry.index, index);
    digest(entry.sha256, 'Frozen V8 input RGB');
    return {
      index,
      frameNum: integer(entry.frameNum, 'Observed frameNum'),
      startUs: integer(entry.startUs, 'Observed startUs'),
      endUs: integer(entry.endUs, 'Observed endUs'),
      sha256: entry.sha256 as string,
    };
  });
}

function readOutputMetadata(value: unknown, build: Build) {
  assert(
    object(value) &&
      value.build === build &&
      object(value.saved) &&
      object(value.ivf) &&
      object(value.decoders) &&
      object(value.decoders.vp8),
    `${build} verified output is missing`
  );
  const saved = value.saved;
  const ivf = value.ivf;
  assert.equal(saved.file, `owned-vp8-product-v8-low-inputs-${build}.webp`);
  assert.equal(ivf.file, `${saved.file}.ivf`);
  assert(
    Array.isArray(value.decoders.vp8.frames) &&
      value.decoders.vp8.frames.length === OBSERVED_FRAMES,
    `${build} decoded verification frames are missing`
  );
  assert(
    Array.isArray(value.frameTimeline) && value.frameTimeline.length === OBSERVED_FRAMES,
    `${build} independently verified frame timeline is missing`
  );
  return {
    saved: {
      file: saved.file as string,
      bytes: integer(saved.bytes, 'Saved WebP bytes'),
      sha256: digest(saved.sha256, 'Saved WebP'),
    },
    ivf: {
      file: ivf.file as string,
      bytes: integer(ivf.bytes, 'Verified IVF bytes'),
      sha256: digest(ivf.sha256, 'Verified IVF'),
    },
    rgbaHashes: value.decoders.vp8.frames.map((frame: unknown, index: number) => {
      assert(object(frame) && frame.index === index, `${build} verified RGBA ordinal differs`);
      return digest(frame.sha256, `${build} verified RGBA`);
    }) as string[],
    vp8Bytes: value.frameTimeline.map((frame: unknown, index: number) => {
      assert(
        object(frame) &&
          integer(frame.vp8Bytes, `${build} VP8 size`) > 0 &&
          integer(frame.timestampMs, `${build} timestamp`) >= 0 &&
          integer(frame.holdMs, `${build} hold`) > 0,
        `${build} verified frame ${index} differs`
      );
      return frame.vp8Bytes as number;
    }) as number[],
  };
}

async function readBoundEvidence(run: string, verificationPath: string) {
  const productPath = join(run, 'output/owned-vp8-product-v8-low-inputs.json');
  const product = await readMetadata(productPath);
  assert.equal(product.sha256, V8_PRODUCT_REPORT, 'Frozen product report differs');
  assert(
    object(product.value) &&
      product.value.status === 'passed' &&
      product.value.scenario === 'owned-vp8-product-v8-low-inputs',
    'Frozen product status differs'
  );
  assert.deepEqual(product.value.selectedInputIndices, CAPTURE_INDICES);
  assert.deepEqual(product.value.settings, {
    quality: 'low',
    qualityPercent: 60,
    cadenceFps: 12,
    scale: 1,
    smartFrameSkip: 'off',
  });
  assert.deepEqual(product.value.layout, {
    format: 'RGB',
    channels: 3,
    opaque: true,
    width: WIDTH,
    height: HEIGHT,
    stride: WIDTH * 3,
    bytesPerFrame: RGB_BYTES,
  });
  const source = product.value.fixture;
  assert(
    object(source) &&
      source.path === SOURCE_REL &&
      source.bytes === SOURCE_BYTES &&
      source.sha256 === V8_SOURCE,
    'Frozen V8 input identity differs'
  );
  const prior = product.value.prior;
  const candidate = product.value.candidate;
  assert(
    object(prior) &&
      prior.sourceSha === V8_PRIOR_SOURCE &&
      object(prior.legacyWasm) &&
      prior.legacyWasm.sha256 === V8_PRIOR_WASM,
    'Frozen prior codec differs'
  );
  assert(
    object(candidate) &&
      candidate.sourceSha === V8_CANDIDATE_SOURCE &&
      object(candidate.ownedAsset) &&
      candidate.ownedAsset.sha256 === V8_CANDIDATE_WASM,
    'Frozen candidate codec differs'
  );
  const sourceBytes = await readStableFile(
    join(run, 'payload', SOURCE_REL),
    8 * 1024 * 1024,
    SOURCE_BYTES,
    'Frozen V8 source'
  );
  assert.equal(sha256(sourceBytes), V8_SOURCE, 'Frozen V8 source bytes differ');
  const verification = await readMetadata(verificationPath);
  assert.equal(verification.sha256, V8_ANIMATION_REPORT, 'Frozen independent verification differs');
  assert(
    object(verification.value) &&
      verification.value.status === 'passed' &&
      verification.value.sourceRun === run &&
      verification.value.expectedSource === V8_CANDIDATE_SOURCE &&
      verification.value.sourceReport === 'owned-vp8-product-v8-low-inputs.json' &&
      object(verification.value.metadata) &&
      verification.value.metadata.product === product.sha256,
    'Frozen independent verification binding differs'
  );
  assert(
    Array.isArray(verification.value.outputs) && verification.value.outputs.length === 2,
    'Frozen independently decoded output count differs'
  );
  const outputs = {
    prior: readOutputMetadata(verification.value.outputs[0], 'prior'),
    candidate: readOutputMetadata(verification.value.outputs[1], 'candidate'),
  };
  for (const [index, build] of (['prior', 'candidate'] as const).entries()) {
    const capture: unknown = (product.value.captures as unknown[])[index];
    assert(
      object(capture) &&
        capture.build === build &&
        capture.observedInputs === OBSERVED_FRAMES &&
        capture.emittedAnmfCount === OBSERVED_FRAMES &&
        object(capture.webp) &&
        capture.webp.file === outputs[build].saved.file &&
        capture.webp.bytes === outputs[build].saved.bytes &&
        capture.webp.sha256 === outputs[build].saved.sha256,
      `${build} product output differs from independent verification`
    );
  }
  assert(
    object(verification.value.v8InputCapture) &&
      verification.value.v8InputCapture.status === 'paired-input-hashes-verified',
    'Frozen all-input verification is absent'
  );
  return {
    product: product.value,
    productSha256: product.sha256,
    verificationSha256: verification.sha256,
    sourceBytes,
    rows: observedRows(product.value),
    outputs,
  };
}

/** Retain the actual child outcome and raw bounded pipes before interpreting it. */
export async function runBoundedSyncChild(
  output: string,
  label: string,
  file: string,
  args: string[],
  timeoutMs: number,
  maxBufferBytes: number
): Promise<Buffer> {
  assert(/^[a-z0-9-]+$/.test(label), 'Invalid child receipt label');
  assert(
    Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      Number.isSafeInteger(maxBufferBytes) &&
      maxBufferBytes > 0,
    'Invalid child bounds'
  );
  await writeReport(output, `${label}.request.json`, {
    file,
    args,
    timeoutMs,
    maxBufferBytes,
    killSignal: 'SIGKILL',
  });
  const result = spawnSync(file, args, {
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: maxBufferBytes,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0);
  await writeFile(join(output, `${label}.stdout`), stdout, { flag: 'wx', mode: 0o600 });
  await writeFile(join(output, `${label}.stderr`), stderr, { flag: 'wx', mode: 0o600 });
  const error = result.error as NodeJS.ErrnoException | undefined;
  await writeReport(output, `${label}.status.json`, {
    pid: result.pid ?? null,
    code: result.status,
    signal: result.signal,
    timedOut: error?.code === 'ETIMEDOUT',
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null,
    stdoutBytes: stdout.length,
    stderrBytes: stderr.length,
  });
  if (result.status !== 0 || result.signal !== null || error)
    throw new Error(
      `${label} failed: code=${result.status} signal=${result.signal} error=${error?.code ?? 'none'}`
    );
  return stdout;
}

async function probeSource(output: string, ffprobe: string, source: string) {
  const command = [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_streams',
    '-show_frames',
    '-show_entries',
    'stream=index,codec_name,width,height,pix_fmt,color_space,color_transfer,color_primaries,time_base,start_pts:frame=pts,best_effort_timestamp,width,height',
    '-of',
    'json',
    source,
  ];
  const stdout = await runBoundedSyncChild(
    output,
    'ffprobe-source',
    ffprobe,
    command,
    FFPROBE_TIMEOUT_MS,
    SOURCE_PTS_METADATA_MAX
  );
  return {
    command: [ffprobe, ...command],
    stdoutSha256: sha256(stdout),
    frames: parseSourceProbe(JSON.parse(stdout.toString('utf8')) as unknown),
  };
}

async function pinnedTool(path: string, expected: string, label: string) {
  const bytes = await readStableFile(path, 16 * 1024 * 1024, undefined, label);
  assert.equal(sha256(bytes), expected, `${label} executable differs`);
}

async function writeReport(output: string, name: string, value: unknown) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  assert(bytes.length <= REPORT_MAX, 'V8 quality report is too large');
  await writeFile(join(output, name), bytes, { flag: 'wx', mode: 0o600 });
  return sha256(bytes);
}

async function existingRowArtifacts(output: string) {
  const names = new Set(await readdir(output));
  const rows = [];
  for (const name of [
    'source-quality-rows.jsonl',
    'source-to-canvas-rows.jsonl',
    'actual-rgb-codec-rows.jsonl',
  ]) {
    if (!names.has(name)) continue;
    const bytes = await readStableFile(join(output, name), REPORT_MAX, undefined, name);
    let terminatedLines = 0;
    let lastNewline = -1;
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] !== 10) continue;
      terminatedLines++;
      lastNewline = index;
    }
    let completeJsonRows = 0;
    if (lastNewline >= 0) {
      const lines = bytes
        .subarray(0, lastNewline + 1)
        .toString('utf8')
        .split('\n');
      for (const line of lines.slice(0, -1)) {
        try {
          if (object(JSON.parse(line) as unknown)) completeJsonRows++;
        } catch {
          /* Retain the receipt even if one terminated line is incomplete. */
        }
      }
    }
    rows.push({
      file: name,
      bytes: bytes.length,
      sha256: sha256(bytes),
      completeJsonRows,
      terminatedLines,
      trailingBytes: bytes.length - lastNewline - 1,
    });
  }
  return rows;
}

async function sourceMap(args: ReturnType<typeof parseArgs>) {
  const evidence = await readBoundEvidence(args.run, args.verification);
  await pinnedTool(args.ffprobe!, FFPROBE_SHA, 'FFprobe');
  const source = join(args.run, 'payload', SOURCE_REL);
  const probe = await probeSource(args.output, args.ffprobe!, source);
  const mapping = mapObservedStarts(probe.frames, evidence.rows);
  assert.equal(mapping[0]?.sourceIndex, 0);
  assert.equal(mapping.at(-1)?.sourcePtsUs, 6_367_000);
  return writeReport(args.output, 'source-map.json', {
    schemaVersion: 1,
    status: 'SOURCE_TIMESTAMP_ALIGNMENT_ONLY',
    scope:
      'Exact observed startUs to decoded VP9 PTS; no source-reference quality or acceptance claim',
    source: {
      path: SOURCE_REL,
      bytes: SOURCE_BYTES,
      sha256: V8_SOURCE,
      decodedFrames: SOURCE_FRAMES,
      width: WIDTH,
      height: HEIGHT,
      durationUs: 6_400_000,
    },
    productReportSha256: evidence.productSha256,
    verificationSha256: evidence.verificationSha256,
    ffprobe: { sha256: FFPROBE_SHA, command: probe.command, stdoutSha256: probe.stdoutSha256 },
    sourceFrames: probe.frames,
    mapping,
  });
}

function rgbaToRgb(rgba: Buffer): Buffer {
  assert.equal(rgba.length, RGBA_BYTES, 'Decoded RGBA extent differs');
  const rgb = Buffer.allocUnsafe(RGB_BYTES);
  for (let pixel = 0, rgbAt = 0; pixel < RGBA_BYTES; pixel += 4, rgbAt += 3) {
    assert.equal(rgba[pixel + 3], 255, 'Decoded frame is not opaque');
    rgb[rgbAt] = rgba[pixel]!;
    rgb[rgbAt + 1] = rgba[pixel + 1]!;
    rgb[rgbAt + 2] = rgba[pixel + 2]!;
  }
  return rgb;
}

/** Decode sequentially; each RGB write settles before the next frame advances. */
async function decodeFrames(
  output: string,
  label: string,
  ffmpeg: string,
  args: string[],
  expectedFrames: number,
  timeoutMs: number,
  onFrame: (frame: Buffer, index: number) => Promise<void>
) {
  await writeReport(output, `${label}.request.json`, {
    file: ffmpeg,
    args,
    expectedFrames,
    timeoutMs,
    killSignal: 'SIGKILL',
    stdoutRetention: `first ${STDOUT_PREFIX_MAX} raw bytes and digest of all bytes observed by reader`,
    stderrRetention: `first ${STDERR_MAX} raw bytes`,
  });
  const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdoutPrefix = Buffer.alloc(STDOUT_PREFIX_MAX);
  const stderrPrefix = Buffer.alloc(STDERR_MAX);
  const stdoutHash = createHash('sha256');
  let stdoutBytes = 0;
  let stdoutPrefixBytes = 0;
  let stdoutReachedEof = false;
  let stderrBytes = 0;
  let stderrPrefixBytes = 0;
  let spawnError: NodeJS.ErrnoException | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  child.stderr.on('data', (part: Buffer) => {
    stderrBytes += part.length;
    const retained = Math.min(part.length, STDERR_MAX - stderrPrefixBytes);
    part.copy(stderrPrefix, stderrPrefixBytes, 0, retained);
    stderrPrefixBytes += retained;
    if (stderrBytes > STDERR_MAX) child.kill('SIGKILL');
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once('error', (error: NodeJS.ErrnoException) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => done({ code, signal }));
  });
  let frame = Buffer.allocUnsafe(RGBA_BYTES);
  let filled = 0;
  let count = 0;
  let failed = false;
  let failure: unknown;
  let outcome: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  try {
    for await (const chunk of child.stdout) {
      const bytes = chunk as Buffer;
      stdoutHash.update(bytes);
      stdoutBytes += bytes.length;
      const retained = Math.min(bytes.length, STDOUT_PREFIX_MAX - stdoutPrefixBytes);
      bytes.copy(stdoutPrefix, stdoutPrefixBytes, 0, retained);
      stdoutPrefixBytes += retained;
      let offset = 0;
      while (offset < bytes.length) {
        assert(count < expectedFrames, 'FFmpeg emitted an extra frame');
        const extent = Math.min(RGBA_BYTES - filled, bytes.length - offset);
        bytes.copy(frame, filled, offset, offset + extent);
        filled += extent;
        offset += extent;
        if (filled === RGBA_BYTES) {
          await onFrame(frame, count);
          count++;
          filled = 0;
          if (count < expectedFrames) frame = Buffer.allocUnsafe(RGBA_BYTES);
        }
      }
    }
    stdoutReachedEof = true;
    outcome = await closed;
    assert(!timedOut, `${label} deadline expired`);
    assert(stderrBytes <= STDERR_MAX, `${label} stderr exceeded bound`);
    assert(
      !spawnError && outcome.code === 0 && outcome.signal === null,
      `${label} failed: code=${outcome.code} signal=${outcome.signal} error=${spawnError?.code ?? 'none'}`
    );
    assert.equal(filled, 0, 'FFmpeg emitted a partial frame');
    assert.equal(count, expectedFrames, 'FFmpeg frame count differs');
  } catch (error) {
    failed = true;
    failure = error;
    child.kill('SIGKILL');
    outcome = await closed;
  } finally {
    clearTimeout(timer);
    await writeFile(
      join(output, `${label}.stdout-prefix`),
      stdoutPrefix.subarray(0, stdoutPrefixBytes),
      { flag: 'wx', mode: 0o600 }
    );
    await writeFile(
      join(output, `${label}.stderr-prefix`),
      stderrPrefix.subarray(0, stderrPrefixBytes),
      { flag: 'wx', mode: 0o600 }
    );
    if (failed && filled > 0)
      await writeFile(join(output, `${label}.partial-rgba`), frame.subarray(0, filled), {
        flag: 'wx',
        mode: 0o600,
      });
    await writeReport(output, `${label}.status.json`, {
      pid: child.pid ?? null,
      code: outcome?.code ?? null,
      signal: outcome?.signal ?? null,
      timedOut,
      spawnErrorCode: spawnError?.code ?? null,
      stdoutBytesObserved: stdoutBytes,
      stdoutSha256Observed: stdoutHash.digest('hex'),
      stdoutPrefixBytes,
      stdoutReachedEof,
      stderrBytes,
      stderrPrefixBytes,
      stderrTruncated: stderrBytes > STDERR_MAX,
      framesCompleted: count,
      currentFrameFilledBytes: failed ? filled : 0,
      failure: failed ? (failure instanceof Error ? failure.message : String(failure)) : null,
    });
  }
  if (failed) throw failure;
}

function rgbName(build: Build | 'source', index: number) {
  return `${build}-${String(index).padStart(3, '0')}.rgb`;
}

async function writeRgb(output: string, name: string, rgb: Buffer) {
  await writeFile(join(output, name), rgb, { flag: 'wx', mode: 0o600 });
}

async function ssim(
  output: string,
  label: string,
  ffmpeg: string,
  reference: string,
  decoded: string
): Promise<number> {
  const input = [
    '-f',
    'rawvideo',
    '-pixel_format',
    'rgb24',
    '-video_size',
    `${WIDTH}x${HEIGHT}`,
    '-framerate',
    '1',
  ];
  const command = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-threads',
    '1',
    ...input,
    '-i',
    reference,
    ...input,
    '-i',
    decoded,
    '-filter_complex',
    '[0:v]format=gbrp[a];[1:v]format=gbrp[b];[a][b]ssim=stats_file=-',
    '-frames:v',
    '1',
    '-f',
    'null',
    '-',
  ];
  const stdout = await runBoundedSyncChild(output, label, ffmpeg, command, SSIM_TIMEOUT_MS, 8192);
  const matches = [...stdout.toString('utf8').matchAll(/\bAll:([^\s]+)/g)];
  assert.equal(matches.length, 1, 'FFmpeg RGB SSIM row count differs');
  const value = Number(matches[0]![1]);
  assert(Number.isFinite(value) && value >= -1 && value <= 1, 'FFmpeg RGB SSIM differs');
  return value;
}

async function readSourceMap(
  path: string,
  expectedSha: string,
  evidence: Awaited<ReturnType<typeof readBoundEvidence>>
) {
  const bytes = await readStableFile(path, REPORT_MAX, undefined, 'Frozen source map');
  assert.equal(sha256(bytes), expectedSha, 'Frozen source-map digest differs');
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  assert(
    object(value) &&
      value.status === 'SOURCE_TIMESTAMP_ALIGNMENT_ONLY' &&
      value.productReportSha256 === evidence.productSha256 &&
      value.verificationSha256 === evidence.verificationSha256 &&
      object(value.source) &&
      value.source.sha256 === V8_SOURCE &&
      value.source.decodedFrames === SOURCE_FRAMES &&
      Array.isArray(value.sourceFrames) &&
      Array.isArray(value.mapping),
    'Frozen source-map identity differs'
  );
  const frames = value.sourceFrames as unknown[];
  const ticks = frames.map((frame, index) => {
    assert(
      object(frame) && typeof frame.ptsTicks === 'string' && frame.index === index,
      'Frozen source-frame ticks differ'
    );
    return frame.ptsTicks;
  });
  assert(
    object(value.ffprobe) &&
      value.ffprobe.sha256 === FFPROBE_SHA &&
      typeof value.ffprobe.stdoutSha256 === 'string' &&
      DIGEST.test(value.ffprobe.stdoutSha256),
    'Frozen source-map probe differs'
  );
  const parsed = exactSourceFrames('1/1000', ticks);
  assert.deepEqual(frames, parsed, 'Frozen source-frame timestamps differ');
  const mapping = mapObservedStarts(parsed, evidence.rows);
  assert.deepEqual(value.mapping, mapping, 'Frozen source mapping differs');
  return { sha256: expectedSha, mapping };
}

async function diagnostic(args: ReturnType<typeof parseArgs>) {
  const evidence = await readBoundEvidence(args.run, args.verification);
  const frozen = await readSourceMap(args.sourceMap!, args.sourceMapSha256!, evidence);
  await pinnedTool(args.ffmpeg!, FFMPEG_SHA, 'FFmpeg');
  assert.equal(EXPECTED_RAW_BYTES, 1_437_004_800);
  assert(
    EXPECTED_RAW_BYTES + NON_RGB_ARTIFACT_ALLOWANCE <= RAW_BUDGET,
    'Private raw and bounded receipt budget exceeded'
  );
  for (const build of ['prior', 'candidate'] as const) {
    const verified = evidence.outputs[build].ivf;
    const bytes = await readStableFile(
      join(dirname(args.verification), verified.file),
      4 * 1024 * 1024,
      verified.bytes,
      `${build} verified IVF`
    );
    assert.equal(sha256(bytes), verified.sha256, `${build} verified IVF digest differs`);
  }
  const sourceByIndex = new Map(
    frozen.mapping.map((frame) => [frame.sourceIndex, frame.outputIndex])
  );
  const sourceRgbHashes: string[] = [];
  const sourceCommand = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-threads',
    '1',
    '-noautorotate',
    '-i',
    join(args.run, 'payload', SOURCE_REL),
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-fps_mode',
    'passthrough',
    '-pix_fmt',
    'rgba',
    '-f',
    'rawvideo',
    'pipe:1',
  ];
  await decodeFrames(
    args.output,
    'decode-source',
    args.ffmpeg!,
    sourceCommand,
    SOURCE_FRAMES,
    SOURCE_DECODE_TIMEOUT_MS,
    async (rgba, sourceIndex) => {
      const outputIndex = sourceByIndex.get(sourceIndex);
      if (outputIndex === undefined) return;
      const rgb = rgbaToRgb(rgba);
      await writeRgb(args.output, rgbName('source', outputIndex), rgb);
      sourceRgbHashes[outputIndex] = sha256(rgb);
    }
  );
  assert.equal(sourceRgbHashes.length, OBSERVED_FRAMES);
  assert(
    sourceRgbHashes.every((hash) => DIGEST.test(hash)),
    'Selected source RGB is incomplete'
  );
  const outputRgbHashes: Record<Build, string[]> = { prior: [], candidate: [] };
  const outputCommands: Record<Build, string[]> = { prior: [], candidate: [] };
  for (const build of ['prior', 'candidate'] as const) {
    const ivfPath = join(dirname(args.verification), evidence.outputs[build].ivf.file);
    const command = [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '1',
      '-f',
      'ivf',
      '-c:v',
      'vp8',
      '-i',
      ivfPath,
      '-an',
      '-sn',
      '-dn',
      '-fps_mode',
      'passthrough',
      '-pix_fmt',
      'rgba',
      '-f',
      'rawvideo',
      'pipe:1',
    ];
    outputCommands[build] = [args.ffmpeg!, ...command];
    await decodeFrames(
      args.output,
      `decode-${build}`,
      args.ffmpeg!,
      command,
      OBSERVED_FRAMES,
      OUTPUT_DECODE_TIMEOUT_MS,
      async (rgba, index) => {
        assert.equal(
          sha256(rgba),
          evidence.outputs[build].rgbaHashes[index],
          `${build} decoded RGBA ${index} differs from independent verifier`
        );
        const rgb = rgbaToRgb(rgba);
        await writeRgb(args.output, rgbName(build, index), rgb);
        outputRgbHashes[build][index] = sha256(rgb);
      }
    );
    assert.equal(outputRgbHashes[build].length, OBSERVED_FRAMES);
  }
  const sourceRowsPath = join(args.output, 'source-quality-rows.jsonl');
  const codecRowsPath = join(args.output, 'actual-rgb-codec-rows.jsonl');
  const canvasRowsPath = join(args.output, 'source-to-canvas-rows.jsonl');
  for (const path of [sourceRowsPath, codecRowsPath, canvasRowsPath])
    await writeFile(path, '', { flag: 'wx', mode: 0o600 });
  const rows = [];
  const controls = [];
  const canvasControls = [];
  for (const mapped of frozen.mapping) {
    const index = mapped.outputIndex;
    const referencePath = join(args.output, rgbName('source', index));
    const reference = await readStableFile(
      referencePath,
      RGB_BYTES,
      RGB_BYTES,
      'Selected source RGB'
    );
    assert.equal(sha256(reference), sourceRgbHashes[index]);
    const scores: Record<
      Build,
      { psnr: ReturnType<typeof rgbPsnr>; ssim: number; outputRgbSha256: string; vp8Bytes: number }
    > = {
      prior: undefined!,
      candidate: undefined!,
    };
    for (const build of ['prior', 'candidate'] as const) {
      const outputPath = join(args.output, rgbName(build, index));
      const rgb = await readStableFile(outputPath, RGB_BYTES, RGB_BYTES, `${build} RGB`);
      assert.equal(sha256(rgb), outputRgbHashes[build][index]);
      scores[build] = {
        psnr: rgbPsnr(reference, rgb),
        ssim: await ssim(
          args.output,
          `ssim-source-${build}-${String(index).padStart(3, '0')}`,
          args.ffmpeg!,
          referencePath,
          outputPath
        ),
        outputRgbSha256: outputRgbHashes[build][index]!,
        vp8Bytes: evidence.outputs[build].vp8Bytes[index]!,
      };
    }
    const sourceRow = {
      ...mapped,
      referenceRgbSha256: sourceRgbHashes[index],
      prior: scores.prior,
      candidate: scores.candidate,
      delta: qualityDelta(
        scores.prior.psnr,
        scores.candidate.psnr,
        scores.prior.ssim,
        scores.candidate.ssim
      ),
    };
    await appendFile(sourceRowsPath, `${JSON.stringify(sourceRow)}\n`);
    rows.push(sourceRow);
    if (!CAPTURE_INDICES.includes(index as (typeof CAPTURE_INDICES)[number])) continue;
    const inputScores: Record<
      Build,
      { inputRgbSha256: string; psnr: ReturnType<typeof rgbPsnr>; ssim: number; vp8Bytes: number }
    > = {
      prior: undefined!,
      candidate: undefined!,
    };
    const canvasScores: Record<
      Build,
      { inputRgbSha256: string; psnr: ReturnType<typeof rgbPsnr>; ssim: number }
    > = {
      prior: undefined!,
      candidate: undefined!,
    };
    for (const [captureIndex, build] of (['prior', 'candidate'] as const).entries()) {
      const capture: unknown = (evidence.product.captures as unknown[])[captureIndex];
      assert(object(capture) && Array.isArray(capture.pixels), `${build} control capture differs`);
      const selected: unknown =
        capture.pixels[CAPTURE_INDICES.indexOf(index as (typeof CAPTURE_INDICES)[number])];
      const file = `owned-vp8-v8-low-input-${build}-${String(index).padStart(2, '0')}.rgb`;
      assert(
        object(selected) &&
          selected.index === index &&
          selected.file === file &&
          selected.bytes === RGB_BYTES &&
          selected.sha256 === evidence.rows[index]!.sha256,
        `${build} actual RGB control identity differs`
      );
      const inputPath = join(args.run, 'output', file);
      const input = await readStableFile(inputPath, RGB_BYTES, RGB_BYTES, `${build} actual RGB`);
      assert.equal(
        sha256(input),
        evidence.rows[index]!.sha256,
        `${build} actual RGB control digest differs`
      );
      const outputPath = join(args.output, rgbName(build, index));
      const rgb = await readStableFile(outputPath, RGB_BYTES, RGB_BYTES, `${build} decoded RGB`);
      assert.equal(sha256(rgb), outputRgbHashes[build][index]);
      canvasScores[build] = {
        inputRgbSha256: sha256(input),
        psnr: rgbPsnr(reference, input),
        ssim: await ssim(
          args.output,
          `ssim-canvas-${build}-${String(index).padStart(3, '0')}`,
          args.ffmpeg!,
          referencePath,
          inputPath
        ),
      };
      inputScores[build] = {
        inputRgbSha256: sha256(input),
        psnr: rgbPsnr(input, rgb),
        ssim: await ssim(
          args.output,
          `ssim-codec-${build}-${String(index).padStart(3, '0')}`,
          args.ffmpeg!,
          inputPath,
          outputPath
        ),
        vp8Bytes: evidence.outputs[build].vp8Bytes[index]!,
      };
    }
    const canvasRow = {
      outputIndex: index,
      sourceIndex: mapped.sourceIndex,
      referenceRgbSha256: sourceRgbHashes[index],
      prior: canvasScores.prior,
      candidate: canvasScores.candidate,
    };
    await appendFile(canvasRowsPath, `${JSON.stringify(canvasRow)}\n`);
    canvasControls.push(canvasRow);
    const delta = qualityDelta(
      inputScores.prior.psnr,
      inputScores.candidate.psnr,
      inputScores.prior.ssim,
      inputScores.candidate.ssim
    );
    const sizeLimitBytes = Math.max(
      inputScores.prior.vp8Bytes * 1.25,
      inputScores.prior.vp8Bytes + 128
    );
    const codecRow = {
      outputIndex: index,
      sourceIndex: mapped.sourceIndex,
      prior: inputScores.prior,
      candidate: inputScores.candidate,
      delta,
      sizeLimitBytes,
      sizePass: inputScores.candidate.vp8Bytes <= sizeLimitBytes,
    };
    await appendFile(codecRowsPath, `${JSON.stringify(codecRow)}\n`);
    controls.push(codecRow);
  }
  assert.equal(rows.length, OBSERVED_FRAMES);
  assert.equal(controls.length, CAPTURE_INDICES.length);
  assert.equal(canvasControls.length, CAPTURE_INDICES.length);
  const totalSizeLimitBytes = Math.max(
    evidence.outputs.prior.saved.bytes * 1.25,
    evidence.outputs.prior.saved.bytes + 128
  );
  const all77 = rows.map((row) => row.delta);
  const five = controls.map((row) => row.delta);
  const minima = (scores: typeof all77) => ({
    minFinitePsnrDeltaDb: scores.some((score) => score.psnrDeltaDb !== null)
      ? Math.min(
          ...scores.flatMap((score) => (score.psnrDeltaDb === null ? [] : [score.psnrDeltaDb]))
        )
      : null,
    nonFinitePsnrIndices: scores.flatMap((score, index) =>
      score.psnrDeltaDb === null ? [index] : []
    ),
    ssimDelta: Math.min(...scores.map((score) => score.ssimDelta)),
    psnrFailIndices: scores.flatMap((score, index) => (score.psnrPass ? [] : [index])),
    ssimFailIndices: scores.flatMap((score, index) => (score.ssimPass ? [] : [index])),
  });
  const controlMinima = minima(five);
  controlMinima.nonFinitePsnrIndices = controlMinima.nonFinitePsnrIndices.map(
    (index) => CAPTURE_INDICES[index]!
  );
  controlMinima.psnrFailIndices = controlMinima.psnrFailIndices.map(
    (index) => CAPTURE_INDICES[index]!
  );
  controlMinima.ssimFailIndices = controlMinima.ssimFailIndices.map(
    (index) => CAPTURE_INDICES[index]!
  );
  return writeReport(args.output, 'diagnostic.json', {
    schemaVersion: 1,
    status: 'EXPOSED_V8_DIAGNOSTIC_ONLY',
    scope:
      'Original-source fidelity for all 77 mapped frames and separate five actual RGB controls; no fresh acceptance or adoption decision',
    sourceSha256: V8_SOURCE,
    sourceMapSha256: frozen.sha256,
    productReportSha256: evidence.productSha256,
    verificationSha256: evidence.verificationSha256,
    ffmpeg: {
      sha256: FFMPEG_SHA,
      sourceCommand: [args.ffmpeg!, ...sourceCommand],
      outputCommands,
      ssim: 'RGB24 files, gbrp, one frame, unscaled, stats_file=-',
    },
    privateRawRgb: {
      fileCount: 3 * OBSERVED_FRAMES,
      bytes: EXPECTED_RAW_BYTES,
      nonRgbArtifactAllowanceBytes: NON_RGB_ARTIFACT_ALLOWANCE,
      budgetBytes: RAW_BUDGET,
      sourceFramesDecoded: SOURCE_FRAMES,
      outputFramesDecodedPerBuild: OBSERVED_FRAMES,
    },
    thresholds: {
      psnrDeltaDbMin: -1,
      ssimDeltaMin: -0.01,
      size: 'candidate bytes <= max(1.25 * prior bytes, prior bytes + 128)',
    },
    totalWebp: {
      priorBytes: evidence.outputs.prior.saved.bytes,
      candidateBytes: evidence.outputs.candidate.saved.bytes,
      sizeLimitBytes: totalSizeLimitBytes,
      sizePass: evidence.outputs.candidate.saved.bytes <= totalSizeLimitBytes,
    },
    sourceReference: { rows, minima: minima(all77) },
    sourceToCanvas: {
      rows: canvasControls,
      scope:
        'Direct mapped original RGB to captured post-WASM encoder-input RGB; no quality threshold',
    },
    actualRgbControls: {
      rows: controls,
      minima: controlMinima,
      sizeFailIndices: controls.filter((row) => !row.sizePass).map((row) => row.outputIndex),
    },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  let ownsOutput = false;
  try {
    // Exclusive creation is the ownership token for all later receipts.
    await mkdir(args.output, { mode: 0o700 });
    ownsOutput = true;
    const hash = args.purpose === 'source-map' ? await sourceMap(args) : await diagnostic(args);
    process.stdout.write(`${args.purpose} report sha256 ${hash}\n`);
  } catch (error) {
    if (ownsOutput) {
      // Never write a failure receipt into a directory this invocation found.
      try {
        const rowArtifacts = await existingRowArtifacts(args.output);
        await writeReport(args.output, 'failure.json', {
          status:
            args.purpose === 'source-map' ? 'SOURCE_MAP_FAILED' : 'EXPOSED_V8_DIAGNOSTIC_FAILED',
          purpose: args.purpose,
          error: error instanceof Error ? error.message : String(error),
          ...(rowArtifacts.length > 0 ? { rowArtifacts } : {}),
        });
      } catch {
        /* Preserve the original failure and any prior receipts. */
      }
    }
    throw error;
  }
}

function parseArgs(argv: string[]) {
  const allowed = new Set([
    '--purpose',
    '--run',
    '--verification',
    '--output',
    '--source-map',
    '--source-map-sha256',
    '--ffprobe',
    '--ffmpeg',
  ]);
  const args: Record<string, string> = {};
  for (let at = 0; at < argv.length; at += 2) {
    const name = argv[at];
    assert(
      name && allowed.has(name) && argv[at + 1] && !args[name],
      `Invalid or repeated argument ${name}`
    );
    args[name] = argv[at + 1]!;
  }
  const purpose = args['--purpose'] ?? 'source-map';
  assert(
    purpose === 'source-map' || purpose === 'diagnostic-exposed-v8',
    'Invalid V8 quality purpose'
  );
  for (const name of ['--run', '--verification', '--output'])
    assert(args[name] && isAbsolute(args[name]!), `${name} must be an absolute path`);
  assert(
    args['--ffprobe'] === undefined || isAbsolute(args['--ffprobe']!),
    'ffprobe path must be absolute'
  );
  assert(
    args['--ffmpeg'] === undefined || isAbsolute(args['--ffmpeg']!),
    'ffmpeg path must be absolute'
  );
  if (purpose === 'source-map') {
    assert(
      args['--ffprobe'] &&
        !args['--ffmpeg'] &&
        !args['--source-map'] &&
        !args['--source-map-sha256'],
      'Source-map arguments differ'
    );
  } else {
    assert(
      args['--ffmpeg'] &&
        args['--source-map'] &&
        isAbsolute(args['--source-map']) &&
        args['--source-map-sha256'] &&
        DIGEST.test(args['--source-map-sha256']) &&
        !args['--ffprobe'],
      'Diagnostic score arguments differ'
    );
  }
  const run = resolve(args['--run']!);
  const verification = resolve(args['--verification']!);
  const output = resolve(args['--output']!);
  const sourceMap = args['--source-map'] ? resolve(args['--source-map']) : undefined;
  const privateRoot = resolve(run, '../..');
  assert(output.startsWith(`${privateRoot}${sep}`), 'Output must be inside private V8 artifacts');
  assert(output !== run && !output.startsWith(`${run}${sep}`), 'Output is inside source run');
  assert(
    output !== dirname(verification) && !output.startsWith(`${dirname(verification)}${sep}`),
    'Output is inside verification evidence'
  );
  assert(
    output !== resolve(import.meta.dirname, '../..') &&
      !output.startsWith(`${resolve(import.meta.dirname, '../..')}${sep}`),
    'Output is inside repository'
  );
  assert(
    sourceMap === undefined ||
      (output !== dirname(sourceMap) && !output.startsWith(`${dirname(sourceMap)}${sep}`)),
    'Output overlaps frozen map'
  );
  return {
    purpose,
    run,
    verification,
    output,
    sourceMap,
    sourceMapSha256: args['--source-map-sha256'],
    ffprobe: args['--ffprobe'],
    ffmpeg: args['--ffmpeg'],
  };
}
