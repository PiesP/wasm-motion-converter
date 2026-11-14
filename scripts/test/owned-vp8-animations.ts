// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Post-conversion, source-bound verification of saved owned-software animations. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseAnimatedWebp } from '../../validation/windows/helpers/owned-vp8-product.ts';

const MAX_OUTPUT_BYTES = 96 * 1024 * 1024;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_FRAMES = 400;
const MAX_PIXELS = 10_066_329;
const MAX_AXIS = 16_383;
const DECODERS = ['vp8', 'libvpx'] as const;
type Decoder = (typeof DECODERS)[number];

type Saved = { file: string; bytes: number; sha256: string };
type SourceRecord = {
  build?: string;
  fixture?: string;
  quality?: string;
  condition?: string;
  inputSha256?: string;
  saved: Saved;
  parsed?: { canvas?: unknown; totalDurationMs?: unknown; icc?: unknown; frames?: unknown[] };
};
type DeclaredRecord = { origin: string; record: SourceRecord };
type Frame = { payload: Buffer; timestampMs: number; holdMs: number; vp8Sha256: string };
type PixelFrame = { index: number; sha256: string; centerRgb: [number, number, number] };

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function savedRecord(value: unknown): value is SourceRecord {
  if (!plainObject(value) || !plainObject(value.saved)) return false;
  const saved = value.saved;
  return (
    typeof saved.file === 'string' &&
    Number.isSafeInteger(saved.bytes) &&
    typeof saved.sha256 === 'string'
  );
}

/** Only the report's declared output sites are eligible; no directory media scan. */
export function declaredOutputs(report: Record<string, unknown>): DeclaredRecord[] {
  assert(Array.isArray(report.samples) && Array.isArray(report.functional), 'Missing output lists');
  const found: DeclaredRecord[] = [];
  const add = (origin: string, value: unknown) => {
    if (plainObject(value) && 'saved' in value)
      assert(savedRecord(value), `Invalid saved identity at ${origin}`);
    if (savedRecord(value)) found.push({ origin, record: value });
  };
  report.samples.forEach((value: unknown, index: number) => {
    assert(savedRecord(value), `Missing saved identity in samples[${index}]`);
    add(`samples[${index}]`, value);
  });
  report.functional.forEach((value: unknown, index: number) => {
    add(`functional[${index}]`, value);
    if (!plainObject(value)) return;
    add(`functional[${index}].valid`, value.valid);
    if (plainObject(value.activeStop))
      add(`functional[${index}].activeStop.recovery`, value.activeStop.recovery);
  });
  assert(found.length > 0, 'Report declares no saved outputs');
  const byFile = new Map<string, DeclaredRecord>();
  for (const entry of found) {
    const prior = byFile.get(entry.record.saved.file);
    if (prior) {
      assert.deepEqual(prior.record.saved, entry.record.saved, 'Repeated saved identity differs');
      continue;
    }
    byFile.set(entry.record.saved.file, entry);
  }
  return [...byFile.values()];
}

/** Structural parsing is shared; this pass extracts only bounded opaque VP8 payloads. */
export function extractVp8Frames(bytes: Buffer) {
  const parsed = parseAnimatedWebp(bytes);
  const { width, height } = parsed.canvas;
  assert(width > 0 && height > 0 && width <= MAX_AXIS && height <= MAX_AXIS);
  assert(width * height <= MAX_PIXELS, 'Animated canvas exceeds pixel bound');
  assert(parsed.frames.length <= MAX_FRAMES, 'Animated frame count exceeds bound');
  const frames: Frame[] = [];
  let at = 12;
  let timestampMs = 0;
  while (at < bytes.length) {
    const tag = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const start = at + 8;
    const end = start + size;
    // parseAnimatedWebp already checked these bounds, padding, child and VP8 geometry.
    if (tag === 'ANMF') {
      const declared = parsed.frames[frames.length];
      assert(declared, 'Unexpected ANMF');
      assert(
        declared.x === 0 &&
          declared.y === 0 &&
          declared.width === width &&
          declared.height === height &&
          declared.flags === 0,
        'Owned software frame is not opaque full canvas'
      );
      const child = start + 16;
      assert.equal(bytes.toString('ascii', child, child + 4), 'VP8 ');
      const childSize = bytes.readUInt32LE(child + 4);
      const payload = bytes.subarray(child + 8, child + 8 + childSize);
      assert((payload[0]! & 1) === 0, 'VP8 payload is not a keyframe');
      assert.equal(sha256(payload), declared.vp8Sha256, 'VP8 payload digest differs');
      frames.push({
        payload,
        timestampMs,
        holdMs: declared.durationMs,
        vp8Sha256: declared.vp8Sha256,
      });
      timestampMs += declared.durationMs;
    }
    at = end + (size & 1);
  }
  assert.equal(frames.length, parsed.frames.length, 'Extracted frame count differs');
  assert.equal(timestampMs, parsed.totalDurationMs, 'Extracted timeline differs');
  return { parsed, frames };
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    assert(bytesWritten > 0, 'IVF write made no progress');
    offset += bytesWritten;
  }
}

/** Exact millisecond timestamps preserve ANMF holds without synthesized frames. */
export async function writeIvf(path: string, width: number, height: number, frames: Frame[]) {
  const handle = await open(path, 'wx');
  try {
    const header = Buffer.alloc(32);
    header.write('DKIF', 0, 'ascii');
    header.writeUInt16LE(0, 4);
    header.writeUInt16LE(32, 6);
    header.write('VP80', 8, 'ascii');
    header.writeUInt16LE(width, 12);
    header.writeUInt16LE(height, 14);
    header.writeUInt32LE(1000, 16);
    header.writeUInt32LE(1, 20);
    header.writeUInt32LE(frames.length, 24);
    await writeAll(handle, header);
    for (const frame of frames) {
      const entry = Buffer.alloc(12);
      entry.writeUInt32LE(frame.payload.length, 0);
      entry.writeBigUInt64LE(BigInt(frame.timestampMs), 4);
      await writeAll(handle, entry);
      await writeAll(handle, frame.payload);
    }
  } finally {
    await handle.close();
  }
}

/** A single reusable frame buffer keeps raw decoder output memory bounded. */
export class RgbaFrameCollector {
  private readonly current: Buffer;
  private readonly expectedFrames: number;
  private filled = 0;
  readonly frames: PixelFrame[] = [];

  constructor(width: number, height: number, expectedFrames: number) {
    assert(width > 0 && height > 0 && width <= MAX_AXIS && height <= MAX_AXIS);
    assert(width * height <= MAX_PIXELS);
    assert(expectedFrames > 0 && expectedFrames <= MAX_FRAMES);
    this.expectedFrames = expectedFrames;
    this.current = Buffer.allocUnsafe(width * height * 4);
    this.centerOffset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
  }

  private readonly centerOffset: number;

  accept(chunk: Buffer): void {
    let at = 0;
    while (at < chunk.length) {
      assert(this.frames.length < this.expectedFrames, 'Decoder emitted extra RGBA bytes');
      const count = Math.min(chunk.length - at, this.current.length - this.filled);
      chunk.copy(this.current, this.filled, at, at + count);
      this.filled += count;
      at += count;
      if (this.filled === this.current.length) {
        const center = this.current.subarray(this.centerOffset, this.centerOffset + 3);
        this.frames.push({
          index: this.frames.length,
          sha256: sha256(this.current),
          centerRgb: [center[0]!, center[1]!, center[2]!],
        });
        this.filled = 0;
      }
    }
  }

  finish(): PixelFrame[] {
    assert.equal(this.filled, 0, 'Decoder ended with a partial RGBA frame');
    assert.equal(this.frames.length, this.expectedFrames, 'Decoder frame count differs from ANMF');
    return this.frames;
  }
}

function color([r, g, b]: readonly number[]): string {
  if (r! > 120 && g! < 110 && b! < 110) return 'red';
  if (g! > 100 && r! < 120 && b! < 120) return 'lime';
  if (b! > 110 && r! < 120 && g! < 120) return 'blue';
  if (r! > 110 && g! > 100 && b! < 120) return 'yellow';
  return 'unknown';
}

function assertClusterOrder(frames: PixelFrame[]): void {
  const sequence = frames.map((frame) => color(frame.centerRgb));
  const groups = sequence.filter((name, index) => index === 0 || name !== sequence[index - 1]);
  assert.deepEqual(groups, ['red', 'lime', 'blue', 'yellow'], 'Cluster scene order differs');
}

function command(decoder: Decoder, ivfPath: string) {
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-threads',
    '1',
    '-f',
    'ivf',
    '-c:v',
    decoder,
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
}

async function decode(
  decoder: Decoder,
  ivfPath: string,
  logPath: string,
  width: number,
  height: number,
  count: number
) {
  const args = command(decoder, ivfPath);
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise<number>((done, reject) => {
    child.once('error', reject);
    child.once('close', (code) => done(code ?? -1));
  });
  const stderr = pipeline(child.stderr!, createWriteStream(logPath, { flags: 'wx' }));
  const collector = new RgbaFrameCollector(width, height, count);
  try {
    for await (const part of child.stdout!) collector.accept(Buffer.from(part));
    const code = await exit;
    await stderr;
    assert.equal(code, 0, `${decoder} decoder failed; inspect ${logPath}`);
    return {
      command: ['ffmpeg', ...args],
      frames: collector.finish(),
      rgbaBytes: width * height * 4 * count,
      log: basename(logPath),
    };
  } catch (error) {
    child.kill();
    await Promise.allSettled([exit, stderr]);
    throw error;
  }
}

function parseArgs(argv: string[]) {
  const options: Record<string, string> = {};
  for (let at = 0; at < argv.length; at += 2) {
    const name = argv[at];
    assert(
      name && ['--run', '--expected-source', '--output', '--report'].includes(name),
      `Unknown argument ${name}`
    );
    assert(argv[at + 1] && !options[name], `Missing or repeated ${name}`);
    options[name] = argv[at + 1]!;
  }
  for (const name of ['--run', '--expected-source', '--output'])
    assert(options[name], `Missing ${name}`);
  assert(
    isAbsolute(options['--run']!) && isAbsolute(options['--output']!),
    'Run and output must be absolute paths'
  );
  assert(
    /^[0-9a-f]{40}$/.test(options['--expected-source']!),
    'Expected source must be a full SHA'
  );
  const run = resolve(options['--run']!);
  const output = resolve(options['--output']!);
  const repository = resolve(import.meta.dirname, '../..');
  assert(
    output !== repository && !output.startsWith(`${repository}${sep}`),
    'Output must be outside repository'
  );
  assert(output !== run && !output.startsWith(`${run}${sep}`), 'Output must be outside source run');
  return {
    run,
    source: options['--expected-source']!,
    output,
    report: options['--report'],
  };
}

async function readMetadata(path: string) {
  const bytes = await readFile(path);
  return { sha256: sha256(bytes), value: JSON.parse(bytes.toString('utf8')) as unknown };
}

function assertReportName(name: string): void {
  assert(
    /^owned-vp8-product(?:-v8-(?:low|medium|high))?(?:-ba)?\.json$/.test(name),
    'Invalid report name'
  );
}

async function verifyRun(run: string, expectedSource: string, output: string, reportName?: string) {
  const sourceOutput = join(run, 'output');
  let selectedReport = reportName;
  if (!selectedReport) {
    const names = (await readdir(sourceOutput)).filter((name) =>
      /^owned-vp8-product.*\.json$/.test(name)
    );
    assert.equal(names.length, 1, 'Choose one product report with --report');
    selectedReport = names[0]!;
  }
  assertReportName(selectedReport);
  const [bundle, transport, collection, result, environment, product] = await Promise.all([
    readMetadata(join(run, 'bundle.json')),
    readMetadata(join(run, 'transport.json')),
    readMetadata(join(run, 'collection.json')),
    readMetadata(join(sourceOutput, 'result.json')),
    readMetadata(join(sourceOutput, 'environment.json')),
    readMetadata(join(sourceOutput, selectedReport)),
  ]);
  assert(
    plainObject(product.value) && product.value.status === 'passed',
    'Product report did not pass'
  );
  assert(plainObject(product.value.candidate), 'Candidate identity missing');
  assert.equal(product.value.candidate.sourceSha, expectedSource, 'Candidate source differs');
  assert(
    plainObject(bundle.value) && bundle.value.source_sha === expectedSource,
    'Bundle source differs'
  );
  assert(
    plainObject(result.value) &&
      result.value.source_sha === expectedSource &&
      result.value.status === 'passed',
    'Run result differs'
  );
  assert(
    plainObject(transport.value) &&
      transport.value.collected === true &&
      transport.value.guest_cleanup === true,
    'Transport incomplete'
  );
  assert(Array.isArray(collection.value), 'Collection metadata missing');
  const assertCollected = (file: string, digest: string) => {
    assert(
      (collection.value as unknown[]).some(
        (entry) =>
          plainObject(entry) &&
          entry.file === file &&
          typeof entry.sha256 === 'string' &&
          entry.sha256.toLowerCase() === digest
      ),
      `Transport collection differs for ${file}`
    );
  };
  assertCollected(selectedReport, product.sha256);
  assertCollected('result.json', result.sha256);
  assertCollected('environment.json', environment.sha256);
  assert.equal(
    product.value.scenario,
    selectedReport.slice(0, -5),
    'Product scenario differs from report name'
  );
  assert.equal(bundle.value.scenario, product.value.scenario, 'Bundle scenario differs');
  assert(Array.isArray(bundle.value.files), 'Bundle inventory missing');
  assert(Array.isArray(product.value.inputs), 'Product input identities missing');
  const inputDigests = new Set<string>();
  const inputs: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const value of product.value.inputs) {
    assert(plainObject(value), 'Malformed input identity');
    const path = value.path;
    assert(
      typeof path === 'string' &&
        (/^public\/[A-Za-z0-9._-]+\.(?:mp4|webm)$/.test(path) ||
          path === 'validation/windows/owned-vp8-inputs/v8.webm'),
      'Unexpected input path'
    );
    assert(
      Number.isSafeInteger(value.bytes) &&
        Number(value.bytes) > 0 &&
        Number(value.bytes) <= MAX_INPUT_BYTES,
      'Invalid input size'
    );
    assert(typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256));
    assert(
      bundle.value.files.some(
        (entry: unknown) =>
          plainObject(entry) && entry.file === path && entry.sha256 === value.sha256
      ),
      'Input differs from bundle inventory'
    );
    const pathOnDisk = join(run, 'payload', path);
    const stat = await lstat(pathOnDisk);
    assert(stat.isFile() && stat.size === value.bytes, 'Staged input size differs');
    assert.equal(sha256(await readFile(pathOnDisk)), value.sha256, 'Staged input digest differs');
    inputDigests.add(value.sha256);
    inputs.push({ path, bytes: Number(value.bytes), sha256: value.sha256 });
  }
  const frozenManifest = product.value.frozenInputManifestSha256;
  if (frozenManifest !== undefined) {
    assert(typeof frozenManifest === 'string' && /^[0-9a-f]{64}$/.test(frozenManifest));
    assert(
      bundle.value.files.some(
        (entry: unknown) =>
          plainObject(entry) &&
          entry.file === 'validation/windows/owned-vp8-v8.json' &&
          entry.sha256 === frozenManifest
      ),
      'Frozen V8 manifest differs from bundle inventory'
    );
    const manifestPath = join(run, 'payload/validation/windows/owned-vp8-v8.json');
    assert((await lstat(manifestPath)).isFile(), 'Frozen V8 manifest is linked');
    assert.equal(
      sha256(await readFile(manifestPath)),
      frozenManifest,
      'Frozen V8 manifest differs'
    );
  }
  const records = declaredOutputs(product.value);
  const ffmpegVersion = spawnSync('ffmpeg', ['-version'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
  });
  assert.equal(ffmpegVersion.status, 0, 'ffmpeg -version failed');
  const scriptSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    status: 'running',
    scope:
      'Saved owned-software animation decode; no conversion timing, perceptual quality, or peak-memory claim',
    sourceRun: run,
    expectedSource,
    sourceReport: selectedReport,
    metadata: {
      bundle: bundle.sha256,
      transport: transport.sha256,
      collection: collection.sha256,
      result: result.sha256,
      environment: environment.sha256,
      product: product.sha256,
    },
    candidate: product.value.candidate,
    prior: product.value.prior,
    inputs,
    frozenInputManifestSha256: frozenManifest ?? null,
    ffmpegVersion: ffmpegVersion.stdout,
    scriptSha256,
    outputs: [] as unknown[],
    iccPairs: [] as unknown[],
  };
  const persist = () =>
    writeFile(join(output, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  await persist();
  try {
    const identities = new Map<string, { declared: DeclaredRecord; icc: unknown }>();
    for (const declared of records) {
      const { saved } = declared.record;
      if (declared.record.inputSha256)
        assert(inputDigests.has(declared.record.inputSha256), 'Saved output input differs');
      assert(
        /^[A-Za-z0-9][A-Za-z0-9._-]*\.webp$/.test(saved.file) &&
          basename(saved.file) === saved.file,
        'Saved path is not a flat WebP basename'
      );
      assert(
        saved.bytes > 0 && saved.bytes <= MAX_OUTPUT_BYTES,
        'Declared saved size outside bound'
      );
      assert(/^[0-9a-f]{64}$/.test(saved.sha256), 'Invalid saved digest');
      assertCollected(saved.file, saved.sha256);
      const path = join(sourceOutput, saved.file);
      const stat = await lstat(path);
      assert(stat.isFile() && stat.size === saved.bytes, 'Saved output is linked or size differs');
      const bytes = await readFile(path);
      assert.equal(sha256(bytes), saved.sha256, 'Saved output digest differs');
      const { parsed, frames } = extractVp8Frames(bytes);
      if (declared.record.parsed) {
        assert.deepEqual(declared.record.parsed.canvas, parsed.canvas, 'Reported canvas differs');
        assert.equal(
          declared.record.parsed.totalDurationMs,
          parsed.totalDurationMs,
          'Reported timeline differs'
        );
        assert.equal(
          declared.record.parsed.frames?.length,
          parsed.frames.length,
          'Reported frame count differs'
        );
        if (declared.record.parsed.icc !== undefined)
          assert.deepEqual(declared.record.parsed.icc, parsed.icc, 'Reported ICC differs');
      }
      const ivf = join(output, `${saved.file}.ivf`);
      await writeIvf(ivf, parsed.canvas.width, parsed.canvas.height, frames);
      report.activeOutput = {
        origin: declared.origin,
        saved,
        ivf: basename(ivf),
        canvas: parsed.canvas,
        emittedAnmfCount: frames.length,
      };
      await persist();
      const decoded: Partial<Record<Decoder, Awaited<ReturnType<typeof decode>>>> = {};
      for (const decoder of DECODERS) {
        report.activeDecoder = {
          decoder,
          command: ['ffmpeg', ...command(decoder, ivf)],
          log: `${saved.file}.${decoder}.log`,
        };
        await persist();
        decoded[decoder] = await decode(
          decoder,
          ivf,
          join(output, `${saved.file}.${decoder}.log`),
          parsed.canvas.width,
          parsed.canvas.height,
          frames.length
        );
      }
      assert.deepEqual(
        decoded.vp8!.frames,
        decoded.libvpx!.frames,
        'Independent VP8 decoders disagree'
      );
      if (declared.record.fixture === 'clusters' || saved.file.includes('direct-worker'))
        assertClusterOrder(decoded.vp8!.frames);
      const verified = {
        origin: declared.origin,
        saved,
        build: declared.record.build ?? null,
        fixture: declared.record.fixture ?? null,
        quality: declared.record.quality ?? null,
        condition: declared.record.condition ?? null,
        inputSha256: declared.record.inputSha256 ?? null,
        canvas: parsed.canvas,
        icc: parsed.icc,
        emittedAnmfCount: frames.length,
        totalDurationMs: parsed.totalDurationMs,
        frameTimeline: frames.map(({ timestampMs, holdMs, vp8Sha256 }) => ({
          timestampMs,
          holdMs,
          vp8Sha256,
        })),
        ivf: {
          file: basename(ivf),
          bytes: (await lstat(ivf)).size,
          sha256: sha256(await readFile(ivf)),
        },
        decoders: decoded,
      };
      (report.outputs as unknown[]).push(verified);
      identities.set(saved.file, { declared, icc: parsed.icc });
      delete report.activeDecoder;
      delete report.activeOutput;
      await persist();
    }
    const paired = new Map<string, { prior?: string; candidate?: string }>();
    for (const [file, { declared }] of identities) {
      if (!declared.origin.startsWith('samples[')) continue;
      const { build, fixture, quality, condition } = declared.record;
      if (build !== 'prior' && build !== 'candidate') continue;
      assert(fixture && quality && condition, 'Paired output identity incomplete');
      const key = `${fixture}/${quality}/${condition}`;
      const pair = paired.get(key) ?? {};
      assert(!pair[build], 'Duplicate paired output identity');
      pair[build] = file;
      paired.set(key, pair);
    }
    for (const [key, pair] of paired) {
      assert(pair.prior && pair.candidate, `Missing paired output for ${key}`);
      const priorIcc = identities.get(pair.prior)!.icc;
      const candidateIcc = identities.get(pair.candidate)!.icc;
      const same = JSON.stringify(priorIcc) === JSON.stringify(candidateIcc);
      (report.iccPairs as unknown[]).push({
        key,
        prior: pair.prior,
        candidate: pair.candidate,
        priorIcc,
        candidateIcc,
        same,
      });
      await persist();
      assert(same, `Paired ICC profiles differ for ${key}`);
    }
    report.status = 'passed';
    await persist();
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    await persist();
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const main = async () => {
    const args = parseArgs(process.argv.slice(2));
    await mkdir(args.output);
    try {
      await verifyRun(args.run, args.source, args.output, args.report);
    } catch (error) {
      // Preflight failures can occur before verifyRun has created its report.
      try {
        await writeFile(
          join(args.output, 'verification.json'),
          `${JSON.stringify({ status: 'failed', sourceRun: args.run, expectedSource: args.source, error: String(error) }, null, 2)}\n`,
          { flag: 'wx' }
        );
      } catch {
        // Keep the more detailed report already written by verifyRun.
      }
      throw error;
    }
  };
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
