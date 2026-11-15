/** Source-bound fixed-pixel tuning/acceptance tool. Never a whole-product benchmark. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileVp8, Vp8TestJob } from './owned-vp8-v2-abi.ts';
import {
  CORRECTION_HELDOUT,
  CORRECTION_TUNING,
  generateCorrectionFixture,
} from './owned-vp8-v2-correction-fixtures.ts';
import {
  FIXTURES,
  generateFixture,
  QUALITIES,
  type FixtureSplit,
  type PixelFixture,
} from './owned-vp8-v2-fixtures.ts';
import { V3_HELDOUT, V3_TUNING, generateV3Fixture } from './owned-vp8-v3-fixtures.ts';
import { V4_HELDOUT, generateV4Fixture, type V4SourcePaths } from './owned-vp8-v4-fixtures.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const ORACLE_HASH = '4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22';
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export type FixtureCohort = 'initial-v1' | 'corrected-v2' | 'corrected-v3' | 'corrected-v4';

export function selectFixtureCohort(
  split: FixtureSplit,
  cohort: FixtureCohort,
  regression = false
) {
  if (split === 'held-out' && !regression)
    throw new Error(
      `${cohort} is exposed: use --regression; no fresh successor is currently frozen`
    );
  const entries =
    cohort === 'corrected-v4'
      ? [
          ...FIXTURES.filter((item) => item.split === 'tuning'),
          ...CORRECTION_TUNING,
          ...V3_TUNING,
          ...V4_HELDOUT,
        ]
      : cohort === 'corrected-v3'
        ? [
            ...FIXTURES.filter((item) => item.split === 'tuning'),
            ...CORRECTION_TUNING,
            ...V3_TUNING,
            ...V3_HELDOUT,
          ]
        : cohort === 'corrected-v2'
          ? [
              ...FIXTURES.filter((item) => item.split === 'tuning'),
              ...CORRECTION_TUNING,
              ...CORRECTION_HELDOUT,
            ]
          : FIXTURES;
  return entries.filter((item) => item.split === split);
}

export function rgbPixels(fixture: PixelFixture): Uint8Array {
  const result = new Uint8Array(fixture.width * fixture.height * 3);
  const bgr = fixture.layout === 'BGRA' || fixture.layout === 'BGRX';
  for (let y = 0; y < fixture.height; y++) {
    for (let x = 0; x < fixture.width; x++) {
      const input = y * fixture.stride + x * 4;
      const output = (y * fixture.width + x) * 3;
      result[output] = fixture.pixels[input + (bgr ? 2 : 0)]!;
      result[output + 1] = fixture.pixels[input + 1]!;
      result[output + 2] = fixture.pixels[input + (bgr ? 0 : 2)]!;
    }
  }
  return result;
}

export function psnr(
  source: Uint8Array,
  decoded: Uint8Array
): { mse: number; exact: boolean; db: number | null } {
  assert.equal(source.length, decoded.length);
  assert.ok(source.length > 0);
  let squaredError = 0;
  for (let i = 0; i < source.length; i++) {
    const difference = source[i]! - decoded[i]!;
    squaredError += difference * difference;
  }
  const mse = squaredError / source.length;
  const db = mse === 0 ? null : 10 * Math.log10((255 * 255) / mse);
  assert.ok(db === null || Number.isFinite(db));
  return { mse, exact: mse === 0, db };
}

export function psnrPass(
  baseline: ReturnType<typeof psnr>,
  candidate: ReturnType<typeof psnr>
): boolean {
  if (candidate.exact) return true;
  if (baseline.exact) return false;
  return candidate.db !== null && baseline.db !== null && candidate.db >= baseline.db - 1;
}

function ssim(first: string, second: string, width: number, height: number): number {
  // FFmpeg ssim on RGB planes. Tiny dimensions extend with nearest-neighbor
  // replication solely for the metric; encoded visible geometry never changes.
  const input = ['-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${width}x${height}`];
  const metricSize = `${Math.max(8, width)}:${Math.max(8, height)}`;
  const filter = `[0:v]format=gbrp,scale=${metricSize}:flags=neighbor[a];[1:v]format=gbrp,scale=${metricSize}:flags=neighbor[b];[a][b]ssim=stats_file=-`;
  const output = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      ...input,
      '-i',
      first,
      ...input,
      '-i',
      second,
      '-filter_complex',
      filter,
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' }
  );
  const text = output.match(/\bAll:([^\s]+)/)?.[1];
  const value = text === undefined ? NaN : Number(text);
  if (!Number.isFinite(value) || value < -1 || value > 1)
    throw new Error(`Invalid SSIM output: ${output}`);
  return value;
}

function wrap(frame: Uint8Array): Uint8Array {
  const result = new Uint8Array(20 + frame.length + (frame.length & 1));
  const view = new DataView(result.buffer);
  result.set([82, 73, 70, 70]);
  view.setUint32(4, result.length - 8, true);
  result.set([87, 69, 66, 80, 86, 80, 56, 32], 8);
  view.setUint32(16, frame.length, true);
  result.set(frame, 20);
  return result;
}

function extract(file: Uint8Array): Uint8Array {
  assert.equal(new TextDecoder().decode(file.subarray(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(file.subarray(8, 12)), 'WEBP');
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  for (let offset = 12; offset + 8 <= file.length;) {
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size;
    assert.ok(end <= file.length);
    if (new TextDecoder().decode(file.subarray(offset, offset + 4)) === 'VP8 ')
      return file.slice(offset + 8, end);
    offset = end + (size & 1);
  }
  throw new Error('Pinned oracle did not return VP8');
}

function decode(file: string, width: number, height: number): Uint8Array {
  const bytes = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-c:v',
      'webp',
      '-i',
      file,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { maxBuffer: width * height * 3 + 4096 }
  );
  assert.equal(bytes.length, width * height * 3);
  return bytes;
}

export async function compare(options: {
  output: string;
  split: FixtureSplit;
  sources: V4SourcePaths;
  cohort?: FixtureCohort;
  regression?: boolean;
  candidateRoot?: string;
}): Promise<object> {
  const cohort = options.cohort ?? 'initial-v1';
  const selected = selectFixtureCohort(options.split, cohort, options.regression);
  const output = resolve(options.output);
  const candidateRoot = resolve(options.candidateRoot ?? ROOT);
  for (const forbidden of ['public', 'dist']) {
    const path = join(ROOT, forbidden);
    if (output === path || output.startsWith(path + sep))
      throw new Error('Evidence must remain outside delivered assets');
  }
  mkdirSync(output, { recursive: true });
  const wasmFile = join(candidateRoot, 'crates/owned-vp8/owned-vp8.wasm');
  execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      join(candidateRoot, 'scripts/build/build-owned-vp8-wasm.ts'),
      '--verify-prebuilt',
    ],
    { cwd: candidateRoot }
  );
  const candidateBytes = readFileSync(wasmFile);
  const oracleWasm = readFileSync(join(ROOT, 'node_modules/wasm-webp/dist/esm/webp-wasm.wasm'));
  assert.equal(digest(oracleWasm), ORACLE_HASH, 'Primary shipped comparator changed');
  const oracleUrl = new URL('../../node_modules/wasm-webp/dist/esm/webp-wasm.js', import.meta.url);
  const { default: createOracle } = (await import(oracleUrl.href)) as {
    default(): Promise<{
      encodeRGB(rgb: Uint8Array, w: number, h: number, quality: number): Uint8Array | null;
      encoder_version(): string;
    }>;
  };
  const oracle = await createOracle();
  const compiled = compileVp8(candidateBytes);
  const baselineManifestFile = join(ROOT, 'docs/experiments/501-owned-vp8-v2-fixtures.json');
  const frozen = JSON.parse(readFileSync(baselineManifestFile, 'utf8')) as {
    generatorSha256: string;
    fixtures: Array<{ id: string; sha256: string }>;
  };
  assert.equal(
    frozen.generatorSha256,
    digest(readFileSync(new URL('./owned-vp8-v2-fixtures.ts', import.meta.url)))
  );
  const correctionManifestFile = join(
    ROOT,
    'docs/experiments/501-owned-vp8-v2-correction-fixtures.json'
  );
  const v3ManifestFile = join(ROOT, 'docs/experiments/501-owned-vp8-v3-fixtures.json');
  const v4ManifestFile = join(ROOT, 'docs/experiments/501-owned-vp8-v4-fixtures.json');
  if (cohort !== 'initial-v1') {
    const correction = JSON.parse(readFileSync(correctionManifestFile, 'utf8')) as typeof frozen;
    assert.equal(
      correction.generatorSha256,
      digest(readFileSync(new URL('./owned-vp8-v2-correction-fixtures.ts', import.meta.url)))
    );
    frozen.fixtures.push(...correction.fixtures);
  }
  if (cohort === 'corrected-v3' || cohort === 'corrected-v4') {
    const fresh = JSON.parse(readFileSync(v3ManifestFile, 'utf8')) as typeof frozen & {
      priorManifestSha256: { initialV1: string; correctedV2: string };
    };
    assert.equal(
      fresh.generatorSha256,
      digest(readFileSync(new URL('./owned-vp8-v3-fixtures.ts', import.meta.url)))
    );
    assert.equal(fresh.priorManifestSha256.initialV1, digest(readFileSync(baselineManifestFile)));
    assert.equal(
      fresh.priorManifestSha256.correctedV2,
      digest(readFileSync(correctionManifestFile))
    );
    frozen.fixtures.push(...fresh.fixtures);
  }
  if (cohort === 'corrected-v4') {
    const fresh = JSON.parse(readFileSync(v4ManifestFile, 'utf8')) as typeof frozen & {
      priorManifestSha256: { initialV1: string; correctedV2: string; correctedV3: string };
    };
    assert.equal(
      fresh.generatorSha256,
      digest(readFileSync(new URL('./owned-vp8-v4-fixtures.ts', import.meta.url)))
    );
    assert.equal(fresh.priorManifestSha256.initialV1, digest(readFileSync(baselineManifestFile)));
    assert.equal(
      fresh.priorManifestSha256.correctedV2,
      digest(readFileSync(correctionManifestFile))
    );
    assert.equal(fresh.priorManifestSha256.correctedV3, digest(readFileSync(v3ManifestFile)));
    frozen.fixtures.push(...fresh.fixtures);
  }
  assert.equal(new Set(frozen.fixtures.map((entry) => entry.id)).size, frozen.fixtures.length);
  const identities = {
    cohort,
    purpose: options.regression ? 'EXPOSED_REGRESSION_NOT_FRESH_ACCEPTANCE' : options.split,
    correctionManifestSha256:
      cohort !== 'initial-v1' ? digest(readFileSync(correctionManifestFile)) : null,
    freshManifestSha256:
      cohort === 'corrected-v4'
        ? digest(readFileSync(v4ManifestFile))
        : cohort === 'corrected-v3'
          ? digest(readFileSync(v3ManifestFile))
          : null,
    source: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: candidateRoot,
      encoding: 'utf8',
    }).trim(),
    dirty:
      execFileSync('git', ['status', '--porcelain'], {
        cwd: candidateRoot,
        encoding: 'utf8',
      }).trim() !== '',
    candidateRustInputs: Object.fromEntries(
      [
        'Cargo.toml',
        'Cargo.lock',
        'rust-toolchain.toml',
        ...readdirSync(join(candidateRoot, 'crates/owned-vp8/src'))
          .filter((name) => name.endsWith('.rs'))
          .sort()
          .map((name) => `src/${name}`),
      ].map((name) => [name, digest(readFileSync(join(candidateRoot, 'crates/owned-vp8', name)))])
    ),
    node: process.version,
    ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
    oracleVersion: oracle.encoder_version(),
    oracleWasmSha256: digest(oracleWasm),
    candidateWasmSha256: digest(candidateBytes),
    candidateProvenanceSha256: digest(
      readFileSync(join(candidateRoot, 'crates/owned-vp8/wasm-provenance.json'))
    ),
    harnessSource: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim(),
    harnessDirty:
      execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '',
    boundedPrebuiltVerified: true,
    fixtureManifestSha256: digest(
      readFileSync(join(ROOT, 'docs/experiments/501-owned-vp8-v2-fixtures.json'))
    ),
    harnessSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
    abiDriverSha256: digest(readFileSync(new URL('./owned-vp8-v2-abi.ts', import.meta.url))),
    metrics:
      'PSNR on all RGB bytes; FFmpeg ssim on gbrp, nearest replication to minimum8x8 for tiny metrics only',
    scope:
      options.split === 'tuning'
        ? 'TUNING_ONLY_NOT_ACCEPTANCE'
        : options.regression
          ? 'EXPOSED_REGRESSION_ONLY_NOT_FRESH_ACCEPTANCE'
          : 'FIXED_PIXEL_ACCEPTANCE_ONLY_NOT_PRODUCT_QUALIFICATION',
  };
  if (options.split === 'held-out' && (identities.dirty || identities.harnessDirty)) {
    throw new Error('Held-out acceptance requires committed candidate and harness identities');
  }
  writeFileSync(join(output, 'identities.json'), `${JSON.stringify(identities, null, 2)}\n`, {
    flag: 'wx',
  });
  const results: object[] = [];
  for (const spec of selected) {
    const freshV4 = V4_HELDOUT.some((entry) => entry.id === spec.id);
    const correction =
      CORRECTION_TUNING.some((entry) => entry.id === spec.id) ||
      CORRECTION_HELDOUT.some((entry) => entry.id === spec.id);
    const fresh =
      V3_TUNING.some((entry) => entry.id === spec.id) ||
      V3_HELDOUT.some((entry) => entry.id === spec.id);
    const fixture = freshV4
      ? generateV4Fixture(spec.id, options.sources)
      : fresh
        ? generateV3Fixture(spec.id, options.sources)
        : correction
          ? generateCorrectionFixture(spec.id, options.sources)
          : generateFixture(spec.id, options.sources);
    assert.equal(
      digest(fixture.pixels),
      frozen.fixtures.find((entry) => entry.id === spec.id)?.sha256
    );
    const rgb = rgbPixels(fixture);
    const original = join(output, `${spec.id}-source.rgb`);
    writeFileSync(original, rgb, { flag: 'wx' });
    for (const quality of QUALITIES) {
      const stem = `${spec.id}-q${quality}`;
      const reference = oracle.encodeRGB(rgb, spec.width, spec.height, quality)?.slice();
      assert.ok(reference?.length);
      const referenceFrame = extract(reference);
      const job = new Vp8TestJob(compiled);
      const encoded = await job.encode(fixture.pixels, {
        width: spec.width,
        height: spec.height,
        stride: fixture.stride,
        layout: { RGBA: 0, BGRA: 1, RGBX: 2, BGRX: 3 }[spec.layout],
        quality,
        externalLiveBytes: fixture.pixels.byteLength + rgb.byteLength,
      });
      job.retire();
      const frame = encoded.bytes;
      const first = join(output, `${stem}-baseline.webp`);
      const second = join(output, `${stem}-candidate.webp`);
      writeFileSync(first, reference, { flag: 'wx' });
      writeFileSync(second, wrap(frame), { flag: 'wx' });
      const metrics = [];
      for (const [name, file] of [
        ['baseline', first],
        ['candidate', second],
      ] as const) {
        const decoded = decode(file, spec.width, spec.height);
        const pixels = join(output, `${stem}-${name}.rgb`);
        writeFileSync(pixels, decoded, { flag: 'wx' });
        metrics.push({
          name,
          psnr: psnr(rgb, decoded),
          ssim: ssim(pixels, original, spec.width, spec.height),
          decodedSha256: digest(decoded),
        });
      }
      const baselineMetric = metrics[0]!;
      const candidateMetric = metrics[1]!;
      const record = {
        fixture: spec.id,
        class: spec.class,
        width: spec.width,
        height: spec.height,
        quality,
        baselineBytes: referenceFrame.length,
        candidateBytes: frame.length,
        inputSha256: digest(fixture.pixels),
        baselineSha256: digest(referenceFrame),
        candidateSha256: digest(frame),
        retainedLinearCapacity: encoded.capacity,
        boundedStepCount: encoded.steps,
        nodeEngineeringMaxStepMs: encoded.maxStepMs,
        inputCopiedToWasmBytes: fixture.pixels.length,
        outputCopiedFromWasmBytes: frame.length,
        metrics,
        gates: {
          psnr: psnrPass(baselineMetric.psnr, candidateMetric.psnr),
          ssim: candidateMetric.ssim >= baselineMetric.ssim - 0.01,
          size: frame.length <= Math.max(referenceFrame.length * 1.25, referenceFrame.length + 128),
        },
      };
      writeFileSync(join(output, `${stem}.json`), `${JSON.stringify(record, null, 2)}\n`, {
        flag: 'wx',
      });
      results.push(record);
    }
  }
  const report = { ...identities, results };
  writeFileSync(join(output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
  });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const output = args[args.indexOf('--output') + 1];
  const photo = args.includes('--photo') ? args[args.indexOf('--photo') + 1] : undefined;
  const video = args.includes('--video') ? args[args.indexOf('--video') + 1] : undefined;
  const acceptance = args.includes('--acceptance');
  const regression = args.includes('--regression');
  const tuningPhoto = args.includes('--tuning-photo')
    ? args[args.indexOf('--tuning-photo') + 1]
    : undefined;
  const freshPhoto = args.includes('--fresh-photo')
    ? args[args.indexOf('--fresh-photo') + 1]
    : undefined;
  const cohort = args.includes('--cohort') ? args[args.indexOf('--cohort') + 1] : 'initial-v1';
  if (
    cohort !== 'initial-v1' &&
    cohort !== 'corrected-v2' &&
    cohort !== 'corrected-v3' &&
    cohort !== 'corrected-v4'
  )
    throw new Error('Unknown fixture cohort');
  if (acceptance && regression) throw new Error('Choose acceptance or exposed regression');
  const candidateRoot = args.includes('--candidate-root')
    ? args[args.indexOf('--candidate-root') + 1]
    : undefined;
  if (!args.includes('--output') || !output)
    throw new Error(
      'Use --output NEW_EVIDENCE_DIRECTORY [--photo PATH --video PATH] [--acceptance]'
    );
  const report = await compare({
    output,
    split: acceptance || regression ? 'held-out' : 'tuning',
    cohort,
    regression,
    sources: {
      ...(photo ? { photo } : {}),
      ...(video ? { video } : {}),
      ...(tuningPhoto ? { tuningPhoto } : {}),
      ...(freshPhoto ? { freshPhoto } : {}),
    },
    ...(candidateRoot ? { candidateRoot } : {}),
  });
  console.log(JSON.stringify(report, null, 2));
}
