/** Source-bound fixed-pixel tuning/acceptance tool. Never a whole-product benchmark. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
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
  type FixtureSpec,
  type FixtureSplit,
  type PixelFixture,
} from './owned-vp8-v2-fixtures.ts';
import { V3_HELDOUT, V3_TUNING, generateV3Fixture } from './owned-vp8-v3-fixtures.ts';
import { V4_HELDOUT, generateV4Fixture } from './owned-vp8-v4-fixtures.ts';
import { V5_HELDOUT, generateV5Fixture, type V5SourcePaths } from './owned-vp8-v5-fixtures.ts';
import { V6_HELDOUT, generateV6Fixture } from './owned-vp8-v6-fixtures.ts';
import { V7_HELDOUT, generateV7Fixture } from './owned-vp8-v7-fixtures.ts';
import {
  V13_HELDOUT,
  generateV13Fixture,
  preflightV13,
  type V13Manifest,
  type V13SourcePaths,
} from './owned-vp8-v13-fixtures.ts';
import {
  V14_HELDOUT,
  preflightV14,
  type V14Manifest,
  type V14SourcePaths,
} from './owned-vp8-v14-fixtures.ts';
import {
  V15_HELDOUT,
  assertV15Shape,
  preflightV15,
  type V15Manifest,
  type V15SourcePaths,
} from './owned-vp8-v15-fixtures.ts';
import {
  V16_HELDOUT,
  assertV16Shape,
  preflightV16,
  type V16Manifest,
  type V16SourcePaths,
} from './owned-vp8-v16-fixtures.ts';
import {
  V17_HELDOUT,
  assertV17Shape,
  preflightV17,
  type V17Manifest,
  type V17SourcePaths,
} from './owned-vp8-v17-fixtures.ts';
import {
  V18_HELDOUT,
  assertV18Shape,
  preflightV18,
  type V18Manifest,
  type V18SourcePaths,
} from './owned-vp8-v18-fixtures.ts';
import {
  V19_MANIFEST,
  V19_PACK_READER,
  v19PackedReader,
  v19Specs,
  type V19Manifest,
} from './owned-vp8-v19-fixtures.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const ORACLE_HASH = '4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22';
const ORACLE_JS_HASH = '75b19521738cd76144ae58442dbcdf7da3ff61ca0574a334f0079afc705f741c';
const V14_DISPOSITION_SHA256 = 'fbbbdc806239de9311b4d5d5ce4d3aae617d2c1a222a9eb6f17ec5f12ce29034';
const V15_MANIFEST = 'docs/experiments/501-owned-vp8-v15-fixtures.json';
const V15_DISPOSITION_SHA256 = '4da3ccd677592efacffd85990c4bff73864685260f90abf653b10f5ad4cb236b';
const V16_MANIFEST = 'docs/experiments/501-owned-vp8-v16-fixtures.json';
const V16_DISPOSITION_SHA256 = 'a02f0d6e6afa461f7e1788fc96a74a271bd17763868b7dc057b10928e99a4d46';
const V17_MANIFEST = 'docs/experiments/501-owned-vp8-v17-fixtures.json';
const V18_MANIFEST = 'docs/experiments/501-owned-vp8-v18-fixtures.json';
const QUALIFICATION_SIGNER = 'G FD87CD5C91355D3303289847E1AA71ED041B25DF';
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export type FixtureCohort =
  | 'initial-v1'
  | 'corrected-v2'
  | 'corrected-v3'
  | 'corrected-v4'
  | 'corrected-v5'
  | 'corrected-v6'
  | 'corrected-v7'
  | 'corrected-v13'
  | 'corrected-v14'
  | 'corrected-v15'
  | 'corrected-v16'
  | 'corrected-v17'
  | 'corrected-v18'
  | 'corrected-v19';

export function selectFixtureCohort(
  split: FixtureSplit,
  cohort: FixtureCohort,
  regression = false,
  fixtureIds?: readonly string[]
) {
  if (cohort === 'corrected-v19')
    throw new Error('Use the source-bound V19 reservation and signed manifest');
  if (fixtureIds !== undefined && split === 'held-out' && !regression)
    throw new Error('Fixture subsets are diagnostic only; acceptance requires the full cohort');
  const protectedCohort =
    cohort === 'corrected-v13' ||
    cohort === 'corrected-v14' ||
    cohort === 'corrected-v15' ||
    cohort === 'corrected-v16' ||
    cohort === 'corrected-v17' ||
    cohort === 'corrected-v18';
  if (protectedCohort && split === 'tuning')
    throw new Error(`${cohort} has no tuning inputs; use a prior exposed tuning cohort`);
  const reserved = cohort === 'corrected-v17' || cohort === 'corrected-v18';
  if (reserved && regression)
    throw new Error(
      `${cohort === 'corrected-v17' ? 'V17' : 'V18'} requires its reserved first acceptance attempt`
    );
  if (split === 'held-out' && !regression && !reserved)
    throw new Error(`${cohort} is exposed: use --regression; this cohort is not fresh`);
  const exposedEntries =
    cohort === 'corrected-v13'
      ? V13_HELDOUT
      : cohort === 'corrected-v7'
        ? [
            ...FIXTURES.filter((item) => item.split === 'tuning'),
            ...CORRECTION_TUNING,
            ...V3_TUNING,
            ...V7_HELDOUT,
          ]
        : cohort === 'corrected-v6'
          ? [
              ...FIXTURES.filter((item) => item.split === 'tuning'),
              ...CORRECTION_TUNING,
              ...V3_TUNING,
              ...V6_HELDOUT,
            ]
          : cohort === 'corrected-v5'
            ? [
                ...FIXTURES.filter((item) => item.split === 'tuning'),
                ...CORRECTION_TUNING,
                ...V3_TUNING,
                ...V5_HELDOUT,
              ]
            : cohort === 'corrected-v4'
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
  const cohorts: Partial<Record<FixtureCohort, readonly FixtureSpec[]>> = {
    'corrected-v14': V14_HELDOUT,
    'corrected-v15': V15_HELDOUT,
    'corrected-v16': V16_HELDOUT,
    'corrected-v17': V17_HELDOUT,
    'corrected-v18': V18_HELDOUT,
  };
  const available = (cohorts[cohort] ?? exposedEntries).filter((item) => item.split === split);
  if (fixtureIds === undefined) return available;
  if (fixtureIds.length === 0) throw new Error('Fixture subset must contain at least one ID');
  const requested = new Set<string>();
  for (const id of fixtureIds) {
    if (!id) throw new Error('Fixture ID must not be empty');
    if (requested.has(id)) throw new Error(`Duplicate fixture ID: ${id}`);
    if (!available.some((item) => item.id === id))
      throw new Error(`Fixture ${id} is outside the selected ${cohort} ${split} split`);
    requested.add(id);
  }
  return available.filter((item) => requested.has(item.id));
}

export function parseFixtureIds(args: readonly string[]): string[] | undefined {
  const ids: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index]?.startsWith('--fixture='))
      throw new Error('Use --fixture ID, not --fixture=ID');
    if (args[index] !== '--fixture') continue;
    const id = args[++index];
    if (!id || id.startsWith('--')) throw new Error('Use --fixture ID with a nonempty ID');
    ids.push(id);
  }
  return ids.length > 0 ? ids : undefined;
}

export function fixtureSelectionIdentity(
  selected: readonly FixtureSpec[],
  split: FixtureSplit,
  regression: boolean,
  diagnosticSubset: boolean
) {
  return {
    selectedFixtureIds: selected.map((item) => item.id),
    expectedConditionCount: selected.length * QUALITIES.length,
    completeCohort: !diagnosticSubset,
    scope: diagnosticSubset
      ? 'DIAGNOSTIC_SUBSET_NOT_ACCEPTANCE'
      : split === 'tuning'
        ? 'TUNING_ONLY_NOT_ACCEPTANCE'
        : regression
          ? 'EXPOSED_REGRESSION_ONLY_NOT_FRESH_ACCEPTANCE'
          : 'FIXED_PIXEL_ACCEPTANCE_ONLY_NOT_PRODUCT_QUALIFICATION',
  };
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

function readV14ExposedManifest(path: string): V14Manifest {
  const dispositionBytes = readFileSync(
    join(ROOT, 'docs/experiments/501-owned-vp8-v14-disposition.json')
  );
  assert.equal(digest(dispositionBytes), V14_DISPOSITION_SHA256, 'V14 first disposition changed');
  const disposition = JSON.parse(dispositionBytes.toString('utf8')) as {
    freezeId: string;
    originalFrozenManifestSha256: string;
    status: 'EXPOSED_REGRESSION';
  };
  const bytes = readFileSync(path);
  assert.equal(
    digest(bytes),
    disposition.originalFrozenManifestSha256,
    'V14 original manifest changed'
  );
  const manifest = JSON.parse(bytes.toString('utf8')) as V14Manifest;
  assert.equal(manifest.freezeId, disposition.freezeId, 'V14 freeze identity changed');
  assert.equal(manifest.status, 'FROZEN_UNEXECUTED', 'V14 historical source freeze changed');
  return { ...manifest, status: disposition.status };
}

function readV15ExposedManifest(path: string): V15Manifest {
  const dispositionBytes = readFileSync(
    join(ROOT, 'docs/experiments/501-owned-vp8-v15-disposition.json')
  );
  assert.equal(digest(dispositionBytes), V15_DISPOSITION_SHA256, 'V15 first disposition changed');
  const disposition = JSON.parse(dispositionBytes.toString('utf8')) as {
    freezeId: string;
    originalFrozenManifestSha256: string;
    status: 'EXPOSED_REGRESSION';
  };
  const bytes = readFileSync(path);
  assert.equal(
    digest(bytes),
    disposition.originalFrozenManifestSha256,
    'V15 original manifest changed'
  );
  const manifest = JSON.parse(bytes.toString('utf8')) as V15Manifest;
  assert.equal(manifest.freezeId, disposition.freezeId, 'V15 freeze identity changed');
  assert.equal(manifest.status, 'FROZEN_UNEXECUTED', 'V15 historical source freeze changed');
  return { ...manifest, status: disposition.status };
}

function readV16ExposedManifest(path: string): V16Manifest {
  const dispositionBytes = readFileSync(
    join(ROOT, 'docs/experiments/501-owned-vp8-v16-disposition.json')
  );
  assert.equal(digest(dispositionBytes), V16_DISPOSITION_SHA256, 'V16 first disposition changed');
  const disposition = JSON.parse(dispositionBytes.toString('utf8')) as {
    freezeId: string;
    originalFrozenManifestSha256: string;
    status: 'EXPOSED_REGRESSION';
  };
  const bytes = readFileSync(path);
  assert.equal(
    digest(bytes),
    disposition.originalFrozenManifestSha256,
    'V16 original manifest changed'
  );
  const manifest = JSON.parse(bytes.toString('utf8')) as V16Manifest;
  assert.equal(manifest.freezeId, disposition.freezeId, 'V16 freeze identity changed');
  assert.equal(manifest.status, 'FROZEN_UNEXECUTED', 'V16 historical source freeze changed');
  return { ...manifest, status: disposition.status };
}

type FreshCandidateIdentity = {
  repo: string;
  source: string;
  tree: string;
  core: string;
  module: string;
  provenance: { path: string; sha256: string };
};

function readFreshReceipt(path: string, byteLimit: number): Buffer {
  assert.equal(resolve(path), path, 'Use an absolute normalized qualification receipt');
  const parent = dirname(path);
  assert.equal(realpathSync(parent), parent, 'Use a canonical qualification receipt directory');
  const owner = process.geteuid?.();
  assert.ok(
    owner !== undefined && fsConstants.O_NOFOLLOW > 0 && fsConstants.O_NONBLOCK > 0,
    'Qualification receipt verification requires POSIX ownership and no-follow opens'
  );

  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    assert.ok(
      info.isFile() && info.uid === owner && info.nlink === 1 && (info.mode & 0o777) === 0o400,
      'Qualification receipt must be a single-link read-only regular file owned by this user'
    );
    assert.ok(
      info.size > 0 && info.size <= byteLimit,
      'Qualification receipt exceeds its byte bounds'
    );

    // One extra byte detects growth while keeping the descriptor read bounded.
    const data = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    assert.equal(offset, info.size, 'Qualification receipt length changed during read');
    return data.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

type FreshReservationOptions = {
  output: string;
  registryRoot: string;
  privateRegistry: string;
  candidateRoot: string;
  freezeId: string;
  manifestSha256: string;
};

export function readV16Reservation(options: FreshReservationOptions & { sources: V16SourcePaths }) {
  const { sources } = options;
  return readFreshReservation(
    options,
    'V16',
    [sources.v16Photo, sources.v16Video],
    V16_MANIFEST,
    867
  );
}

export function readV17Reservation(options: FreshReservationOptions & { sources: V17SourcePaths }) {
  const { sources } = options;
  return readFreshReservation(
    options,
    'V17',
    [sources.v17Photo, sources.v17Video],
    V17_MANIFEST,
    927
  );
}

export function readV18Reservation(options: FreshReservationOptions & { sources: V18SourcePaths }) {
  const { sources } = options;
  return readFreshReservation(
    options,
    'V18',
    [sources.v18Photo, sources.v18Video],
    V18_MANIFEST,
    987
  );
}

function readFreshReservation(
  options: FreshReservationOptions,
  version: 'V16' | 'V17' | 'V18' | 'V19',
  sources: readonly (string | undefined)[],
  manifest: string,
  exposedCount: number
) {
  const attempt = dirname(options.output);
  assert.equal(
    basename(options.output),
    'rows',
    `${version} acceptance output must be reserved rows`
  );
  assert.equal(basename(attempt), 'first-candidate-attempt-01', `${version} attempt name differs`);
  assert.equal(
    attempt,
    join(options.privateRegistry, 'first-candidate-attempt-01'),
    `${version} canonical custody root differs`
  );
  assert.equal(realpathSync(attempt), attempt, `Use the canonical ${version} attempt directory`);
  assert.ok(
    !lstatSync(join(attempt, 'outcome.json'), { throwIfNoEntry: false }),
    `${version} attempt is settled`
  );
  const request = JSON.parse(
    readFreshReceipt(join(attempt, 'request.json'), 16 * 1024).toString('utf8')
  ) as {
    freezeId: string;
    budget: number;
    canonicalAttempt: string;
    plan: string;
    planSha256: string;
    registration: string;
    startedUtc: string;
  };
  assert.equal(request.freezeId, options.freezeId, `${version} request freeze ID differs`);
  assert.equal(request.budget, 1, `${version} request attempt budget differs`);
  assert.equal(request.canonicalAttempt, attempt, `${version} request canonical attempt differs`);
  assert.match(request.planSha256, /^[a-f0-9]{64}$/);
  assert.match(
    request.registration,
    /^https:\/\/github\.com\/PiesP\/wasm-motion-converter\/issues\/501#issuecomment-[1-9][0-9]{0,20}$/,
    `${version} request registration is outside issue #501`
  );
  assert.match(
    basename(request.plan),
    /^admission-[a-z0-9-]+\.json$/,
    `${version} admission filename differs`
  );
  const planBytes = readFreshReceipt(request.plan, 1024 * 1024);
  assert.equal(digest(planBytes), request.planSha256, `${version} admission digest differs`);
  const plan = JSON.parse(planBytes.toString('utf8')) as {
    status: string;
    freezeId: string;
    budget: number;
    canonicalAttempt: string;
    registryRoot: string;
    registryCommit: string;
    registryTree: string;
    candidate: FreshCandidateIdentity;
    repoPins: Record<string, string>;
    sourcesFromManifestMetadataOnly: Record<string, { path: string }>;
    bridgeSha256?: string;
    primary: { wasmSha256: string; jsSha256: string };
    exposed: { scope: string; status: string; count: number; passed: number };
    plannedUtc: string;
    development?: {
      earlier?: { count: number; passed: number };
      multiscale?: {
        scope: string;
        status: string;
        count: number;
        passed: number;
        failedRows: unknown[];
      };
    };
  };
  assert.equal(
    plan.status,
    `${version}_FIRST_ADMISSION_FROZEN`,
    `${version} admission status differs`
  );
  assert.deepEqual(
    [plan.exposed?.scope, plan.exposed?.status, plan.exposed?.count, plan.exposed?.passed],
    ['EXPOSED_REGRESSION_ONLY', 'PASS_EXPOSED_REGRESSION_ONLY', exposedCount, exposedCount],
    `${version} requires all ${exposedCount} exposed conditions`
  );
  if (version === 'V18' || version === 'V19') {
    const earlier = plan.development?.earlier;
    const diagnostic = plan.development?.multiscale;
    assert.deepEqual(
      [earlier?.count, earlier?.passed],
      [90, 90],
      'V18 requires the earlier development pass'
    );
    assert.ok(
      diagnostic?.scope === 'DEVELOPMENT_ONLY' &&
        diagnostic.count === 72 &&
        Number.isSafeInteger(diagnostic.passed) &&
        diagnostic.passed >= 0 &&
        diagnostic.passed <= 72 &&
        diagnostic.status ===
          (diagnostic.passed === 72 ? 'DEVELOPMENT_GATES_PASSED' : 'DEVELOPMENT_GATES_FAILED') &&
        Array.isArray(diagnostic.failedRows) &&
        diagnostic.failedRows.length === 72 - diagnostic.passed,
      'V18 requires the complete multiscale diagnostic and its original misses'
    );
  }
  assert.equal(plan.freezeId, request.freezeId, `${version} admission freeze ID differs`);
  assert.equal(plan.budget, request.budget, `${version} admission attempt budget differs`);
  assert.equal(
    plan.canonicalAttempt,
    request.canonicalAttempt,
    `${version} admission attempt differs`
  );
  assert.equal(plan.registryRoot, options.registryRoot, `${version} registry root differs`);
  assert.equal(plan.candidate.repo, options.candidateRoot, `${version} candidate root differs`);
  assert.equal(
    plan.repoPins[manifest],
    options.manifestSha256,
    `${version} manifest digest differs`
  );
  assert.deepEqual(plan.primary, { wasmSha256: ORACLE_HASH, jsSha256: ORACLE_JS_HASH });
  assert.deepEqual(
    sources,
    (version === 'V19' ? ['packed'] : ['photo', 'video']).map(
      (role) => plan.sourcesFromManifestMetadataOnly[role]?.path
    ),
    `${version} admission original paths differ`
  );
  const registration = JSON.parse(
    readFreshReceipt(join(attempt, 'registration-readback.json'), 16 * 1024).toString('utf8')
  ) as {
    url: string;
    author: string;
    createdUtc: string;
    updatedUtc: string;
    responseSha256: string;
    planSha256?: string;
    bridgeSha256?: string;
  };
  assert.equal(registration.url, request.registration, `${version} readback URL differs`);
  assert.equal(registration.author, 'PiesP', `${version} readback owner differs`);
  assert.match(registration.responseSha256, /^[a-f0-9]{64}$/);
  if (version === 'V19') {
    assert.match(plan.bridgeSha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(registration.planSha256, request.planSha256);
    assert.equal(registration.bridgeSha256, plan.bridgeSha256);
  }
  if (version !== 'V16')
    assert.equal(
      registration.createdUtc,
      registration.updatedUtc,
      `${version} registration must be unedited`
    );
  const frozen = Date.parse(plan.plannedUtc);
  const created = Date.parse(registration.createdUtc);
  const updated = Date.parse(registration.updatedUtc);
  const started = Date.parse(request.startedUtc);
  assert.ok(
    frozen <= created && created <= updated && updated <= started,
    `${version} registration dates differ`
  );
  return plan;
}

function gitAt(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function cleanCommit(root: string) {
  assert.equal(gitAt(root, 'rev-parse', '--show-toplevel'), root, 'V17 checkout root differs');
  assert.equal(
    gitAt(root, 'status', '--porcelain=v1', '--untracked-files=all'),
    '',
    'V17 checkout is dirty'
  );
  return {
    source: gitAt(root, 'rev-parse', 'HEAD'),
    tree: gitAt(root, 'rev-parse', 'HEAD^{tree}'),
  };
}

function freshCustodyRoot(version: 'V17' | 'V18', photo?: string, video?: string) {
  assert.ok(photo && video, `${version} acceptance requires both private originals`);
  const acquisition = dirname(photo);
  const custody = dirname(acquisition);
  assert.equal(resolve(custody), custody, `Use an absolute normalized ${version} custody root`);
  assert.equal(
    basename(custody),
    `fresh-${version.toLowerCase()}-sources-01`,
    `${version} custody directory differs`
  );
  assert.equal(basename(acquisition), 'acquire-01', `${version} acquisition directory differs`);
  assert.deepEqual(
    [photo, video],
    [join(acquisition, 'photo-original.jpg'), join(acquisition, 'video-original.webm')],
    `${version} original paths are outside the fixed acquisition`
  );
  return custody;
}

export async function compare(options: {
  output: string;
  split: FixtureSplit;
  sources: V5SourcePaths &
    V13SourcePaths &
    V14SourcePaths &
    V15SourcePaths &
    V16SourcePaths &
    V17SourcePaths &
    V18SourcePaths & { v19Packed?: string };
  cohort?: FixtureCohort;
  regression?: boolean;
  fixtureIds?: readonly string[];
  candidateRoot?: string;
}): Promise<object> {
  const cohort = options.cohort ?? 'initial-v1';
  const v19ManifestBytes =
    cohort === 'corrected-v19' ? readFileSync(join(ROOT, V19_MANIFEST)) : undefined;
  const v19Manifest = v19ManifestBytes
    ? (JSON.parse(v19ManifestBytes.toString('utf8')) as V19Manifest)
    : undefined;
  if (v19Manifest)
    assert.ok(
      options.split === 'held-out' && !options.regression && options.fixtureIds === undefined
    );
  const selected = v19Manifest
    ? v19Specs(v19Manifest)
    : selectFixtureCohort(options.split, cohort, options.regression, options.fixtureIds);
  const selection = fixtureSelectionIdentity(
    selected,
    options.split,
    options.regression ?? false,
    options.fixtureIds !== undefined
  );
  let output = resolve(options.output);
  const candidateRoot = resolve(options.candidateRoot ?? ROOT);
  for (const forbidden of ['public', 'dist']) {
    const path = join(ROOT, forbidden);
    if (output === path || output.startsWith(path + sep))
      throw new Error('Evidence must remain outside delivered assets');
  }
  const v13ManifestFile = join(ROOT, 'docs/experiments/501-owned-vp8-v13-fixtures.json');
  const v13Manifest =
    cohort === 'corrected-v13'
      ? (JSON.parse(readFileSync(v13ManifestFile, 'utf8')) as V13Manifest)
      : undefined;
  if (v13Manifest) preflightV13(v13Manifest, options.sources, ROOT, options.regression ?? false);
  const v14ManifestFile = join(ROOT, 'docs/experiments/501-owned-vp8-v14-fixtures.json');
  const v14Manifest =
    cohort === 'corrected-v14' ? readV14ExposedManifest(v14ManifestFile) : undefined;
  const v15ManifestFile = join(ROOT, V15_MANIFEST);
  const v15Manifest =
    cohort === 'corrected-v15' ? readV15ExposedManifest(v15ManifestFile) : undefined;
  const v16Manifest =
    cohort === 'corrected-v16' ? readV16ExposedManifest(join(ROOT, V16_MANIFEST)) : undefined;
  const v17ManifestBytes =
    cohort === 'corrected-v17' ? readFileSync(join(ROOT, V17_MANIFEST)) : undefined;
  const v17Manifest = v17ManifestBytes
    ? (JSON.parse(v17ManifestBytes.toString('utf8')) as V17Manifest)
    : undefined;
  const v18ManifestBytes =
    cohort === 'corrected-v18' ? readFileSync(join(ROOT, V18_MANIFEST)) : undefined;
  const v18Manifest = v18ManifestBytes
    ? (JSON.parse(v18ManifestBytes.toString('utf8')) as V18Manifest)
    : undefined;
  const reservedManifest = v18Manifest ?? v17Manifest;
  const pinnedFreshManifest = reservedManifest ?? v16Manifest ?? v15Manifest ?? v14Manifest;
  if (v15Manifest) assertV15Shape(v15Manifest);
  if (v16Manifest) {
    assertV16Shape(v16Manifest);
    assert.ok(
      options.sources.v16Photo && options.sources.v16Video,
      'V16 exposed replay needs both private originals'
    );
  }
  if (v17Manifest) {
    assertV17Shape(v17Manifest);
    assert.ok(
      !options.regression && v17Manifest.status === 'FROZEN_UNEXECUTED',
      'V17 draft or wrong-purpose cohort is not acceptance ready'
    );
    assert.ok(
      v17Manifest.fixtures.every((row) => row.sha256),
      'V17 pixel pins are incomplete'
    );
  }
  if (v18Manifest) {
    assertV18Shape(v18Manifest);
    assert.ok(
      !options.regression && v18Manifest.status === 'FROZEN_UNEXECUTED',
      'V18 draft or wrong-purpose cohort is not acceptance ready'
    );
    assert.ok(
      v18Manifest.fixtures.every((row) => row.sha256),
      'V18 pixel pins are incomplete'
    );
  }
  if (pinnedFreshManifest || v19Manifest) {
    output = join(realpathSync(dirname(output)), basename(output));
    assert.ok(!lstatSync(output, { throwIfNoEntry: false }), 'Evidence directory already exists');
  }
  const v17ManifestSha256 = v17ManifestBytes && digest(v17ManifestBytes);
  const v18ManifestSha256 = v18ManifestBytes && digest(v18ManifestBytes);
  const v19ManifestSha256 = v19ManifestBytes && digest(v19ManifestBytes);
  const reservedSha = v19ManifestSha256 ?? v18ManifestSha256 ?? v17ManifestSha256;
  const v19Packed = options.sources.v19Packed;
  if (v19Manifest) {
    assert.ok(
      v19Packed && realpathSync(v19Packed) === v19Packed && lstatSync(v19Packed).isDirectory()
    );
    assert.equal(basename(v19Packed), 'packed-01');
    assert.equal(basename(dirname(v19Packed)), 'fresh-v19-sources-01');
  }
  const admission =
    v19Manifest && v19ManifestSha256 && v19Packed
      ? readFreshReservation(
          {
            output,
            registryRoot: ROOT,
            privateRegistry: dirname(v19Packed),
            candidateRoot,
            freezeId: v19Manifest.freezeId,
            manifestSha256: v19ManifestSha256,
          },
          'V19',
          [v19Packed],
          V19_MANIFEST,
          1047
        )
      : reservedManifest && reservedSha && !options.regression
        ? readFreshReservation(
            {
              output,
              registryRoot: ROOT,
              privateRegistry: v18Manifest
                ? freshCustodyRoot('V18', options.sources.v18Photo, options.sources.v18Video)
                : freshCustodyRoot('V17', options.sources.v17Photo, options.sources.v17Video),
              candidateRoot,
              freezeId: reservedManifest.freezeId,
              manifestSha256: reservedSha,
            },
            v18Manifest ? 'V18' : 'V17',
            v18Manifest
              ? [options.sources.v18Photo, options.sources.v18Video]
              : [options.sources.v17Photo, options.sources.v17Video],
            v18Manifest ? V18_MANIFEST : V17_MANIFEST,
            v18Manifest ? 987 : 927
          )
        : undefined;
  if (v15Manifest || v16Manifest || reservedManifest || v19Manifest) {
    const roots = [realpathSync(ROOT), realpathSync(candidateRoot)];
    for (const root of roots)
      assert.ok(
        output !== root && !output.startsWith(root + sep),
        'Use private qualification evidence'
      );
    const originals = v19Manifest
      ? [v19Packed]
      : v18Manifest
        ? [options.sources.v18Photo, options.sources.v18Video]
        : v17Manifest
          ? [options.sources.v17Photo, options.sources.v17Video]
          : v16Manifest
            ? [options.sources.v16Photo, options.sources.v16Video]
            : [options.sources.v15Photo, options.sources.v15Video];
    for (const original of originals) {
      if (!original) continue;
      const path = realpathSync(original);
      if (reservedManifest) assert.equal(path, original, 'Use canonical qualification originals');
      for (const root of roots)
        assert.ok(
          path !== root && !path.startsWith(root + sep),
          'Use private qualification originals'
        );
    }
  }
  if (admission) {
    const registry = cleanCommit(ROOT);
    assert.equal(
      gitAt(ROOT, 'show', '-s', '--format=%G? %GF'),
      QUALIFICATION_SIGNER,
      'V17 registry signature differs'
    );
    assert.equal(registry.source, admission.registryCommit, 'V17 registry source differs');
    assert.equal(registry.tree, admission.registryTree, 'V17 registry tree differs');
    for (const path of [
      v19Manifest ? V19_MANIFEST : v18Manifest ? V18_MANIFEST : V17_MANIFEST,
      v19Manifest
        ? V19_PACK_READER
        : v18Manifest
          ? 'scripts/test/owned-vp8-v18-fixtures.ts'
          : 'scripts/test/owned-vp8-v17-fixtures.ts',
      'scripts/test/owned-vp8-v2-compare.ts',
      'scripts/test/owned-vp8-v2-abi.ts',
    ]) {
      assert.equal(digest(readFileSync(join(ROOT, path))), admission.repoPins[path], path);
    }

    const candidate = cleanCommit(candidateRoot);
    assert.equal(
      gitAt(candidateRoot, 'show', '-s', '--format=%G? %GF'),
      QUALIFICATION_SIGNER,
      'V17 candidate signature differs'
    );
    assert.equal(candidate.source, admission.candidate.source, 'V17 candidate source differs');
    assert.equal(candidate.tree, admission.candidate.tree, 'V17 candidate tree differs');
    const core = gitAt(candidateRoot, 'rev-parse', 'HEAD:packages/core');
    assert.equal(core, admission.candidate.core, 'V17 candidate core gitlink differs');
    assert.equal(
      cleanCommit(join(candidateRoot, 'packages/core')).source,
      core,
      'V17 actual candidate core differs'
    );
  }
  const v14Fixtures = v14Manifest
    ? preflightV14(v14Manifest, options.sources, ROOT, true)
    : undefined;
  if (!reservedManifest && !v19Manifest) mkdirSync(output, { recursive: !pinnedFreshManifest });
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
  const candidateWasmSha256 = digest(candidateBytes);
  const candidateProvenancePath = join(candidateRoot, 'crates/owned-vp8/wasm-provenance.json');
  const candidateProvenanceSha256 = digest(readFileSync(candidateProvenancePath));
  if (admission) {
    assert.equal(candidateWasmSha256, admission.candidate.module, 'V17 candidate module differs');
    assert.deepEqual(
      { path: candidateProvenancePath, sha256: candidateProvenanceSha256 },
      admission.candidate.provenance,
      'V17 candidate provenance differs'
    );
  }
  const oracleWasm = readFileSync(join(ROOT, 'node_modules/wasm-webp/dist/esm/webp-wasm.wasm'));
  assert.equal(digest(oracleWasm), ORACLE_HASH, 'Primary shipped comparator changed');
  const oracleUrl = new URL('../../node_modules/wasm-webp/dist/esm/webp-wasm.js', import.meta.url);
  if (pinnedFreshManifest || v19Manifest)
    assert.equal(digest(readFileSync(oracleUrl)), ORACLE_JS_HASH, 'Patched primary JS changed');
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
  const v5ManifestFile = join(ROOT, 'docs/experiments/501-owned-vp8-v5-fixtures.json');
  const v6ManifestFile = join(ROOT, 'docs/experiments/501-owned-vp8-v6-fixtures.json');
  const v7ManifestFile = join(ROOT, 'docs/experiments/501-owned-vp8-v7-fixtures.json');
  if (cohort !== 'initial-v1') {
    const correction = JSON.parse(readFileSync(correctionManifestFile, 'utf8')) as typeof frozen;
    assert.equal(
      correction.generatorSha256,
      digest(readFileSync(new URL('./owned-vp8-v2-correction-fixtures.ts', import.meta.url)))
    );
    frozen.fixtures.push(...correction.fixtures);
  }
  if (
    cohort === 'corrected-v3' ||
    cohort === 'corrected-v4' ||
    cohort === 'corrected-v5' ||
    cohort === 'corrected-v6' ||
    cohort === 'corrected-v7'
  ) {
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
  if (
    cohort === 'corrected-v4' ||
    cohort === 'corrected-v5' ||
    cohort === 'corrected-v6' ||
    cohort === 'corrected-v7'
  ) {
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
  if (cohort === 'corrected-v5' || cohort === 'corrected-v6' || cohort === 'corrected-v7') {
    const fresh = JSON.parse(readFileSync(v5ManifestFile, 'utf8')) as typeof frozen & {
      priorManifestSha256: {
        initialV1: string;
        correctedV2: string;
        correctedV3: string;
        correctedV4: string;
      };
    };
    assert.equal(
      fresh.generatorSha256,
      digest(readFileSync(new URL('./owned-vp8-v5-fixtures.ts', import.meta.url)))
    );
    assert.equal(fresh.priorManifestSha256.initialV1, digest(readFileSync(baselineManifestFile)));
    assert.equal(
      fresh.priorManifestSha256.correctedV2,
      digest(readFileSync(correctionManifestFile))
    );
    assert.equal(fresh.priorManifestSha256.correctedV3, digest(readFileSync(v3ManifestFile)));
    assert.equal(fresh.priorManifestSha256.correctedV4, digest(readFileSync(v4ManifestFile)));
    frozen.fixtures.push(...fresh.fixtures);
  }
  if (cohort === 'corrected-v6' || cohort === 'corrected-v7') {
    const fresh = JSON.parse(readFileSync(v6ManifestFile, 'utf8')) as typeof frozen & {
      priorManifestSha256: Record<
        'initialV1' | 'correctedV2' | 'correctedV3' | 'correctedV4' | 'correctedV5',
        string
      >;
    };
    assert.equal(
      fresh.generatorSha256,
      digest(readFileSync(new URL('./owned-vp8-v6-fixtures.ts', import.meta.url)))
    );
    for (const [key, file] of Object.entries({
      initialV1: baselineManifestFile,
      correctedV2: correctionManifestFile,
      correctedV3: v3ManifestFile,
      correctedV4: v4ManifestFile,
      correctedV5: v5ManifestFile,
    }))
      assert.equal(
        fresh.priorManifestSha256[key as keyof typeof fresh.priorManifestSha256],
        digest(readFileSync(file))
      );
    frozen.fixtures.push(...fresh.fixtures);
  }
  if (cohort === 'corrected-v7') {
    const fresh = JSON.parse(readFileSync(v7ManifestFile, 'utf8')) as typeof frozen & {
      priorManifestSha256: Record<
        'initialV1' | 'correctedV2' | 'correctedV3' | 'correctedV4' | 'correctedV5' | 'correctedV6',
        string
      >;
    };
    assert.equal(
      fresh.generatorSha256,
      digest(readFileSync(new URL('./owned-vp8-v7-fixtures.ts', import.meta.url)))
    );
    for (const [key, file] of Object.entries({
      initialV1: baselineManifestFile,
      correctedV2: correctionManifestFile,
      correctedV3: v3ManifestFile,
      correctedV4: v4ManifestFile,
      correctedV5: v5ManifestFile,
      correctedV6: v6ManifestFile,
    }))
      assert.equal(
        fresh.priorManifestSha256[key as keyof typeof fresh.priorManifestSha256],
        digest(readFileSync(file))
      );
    frozen.fixtures.push(...fresh.fixtures);
  }
  const newestManifest = v19Manifest ?? pinnedFreshManifest ?? v13Manifest;
  if (newestManifest)
    frozen.fixtures.push(
      ...newestManifest.fixtures.map((row) => ({
        id: row.id,
        sha256: row.sha256 ?? '',
      }))
    );
  assert.equal(new Set(frozen.fixtures.map((entry) => entry.id)).size, frozen.fixtures.length);
  const freshManifestSha256 =
    reservedSha ??
    (v16Manifest ? digest(readFileSync(join(ROOT, V16_MANIFEST))) : undefined) ??
    (v15Manifest ? digest(readFileSync(v15ManifestFile)) : undefined) ??
    (v14Manifest ? digest(readFileSync(v14ManifestFile)) : undefined);
  const identities = {
    ...selection,
    cohort,
    purpose: options.regression ? 'EXPOSED_REGRESSION_NOT_FRESH_ACCEPTANCE' : options.split,
    correctionManifestSha256:
      cohort !== 'initial-v1' ? digest(readFileSync(correctionManifestFile)) : null,
    freshManifestSha256:
      freshManifestSha256 ??
      (cohort === 'corrected-v13'
        ? digest(readFileSync(v13ManifestFile))
        : cohort === 'corrected-v7'
          ? digest(readFileSync(v7ManifestFile))
          : cohort === 'corrected-v6'
            ? digest(readFileSync(v6ManifestFile))
            : cohort === 'corrected-v5'
              ? digest(readFileSync(v5ManifestFile))
              : cohort === 'corrected-v4'
                ? digest(readFileSync(v4ManifestFile))
                : cohort === 'corrected-v3'
                  ? digest(readFileSync(v3ManifestFile))
                  : null),
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
    ...(pinnedFreshManifest
      ? {
          oracleJsSha256: ORACLE_JS_HASH,
          freshFreezeId: pinnedFreshManifest.freezeId,
          freshGeneratorSha256: pinnedFreshManifest.generatorSha256,
          freshSourceSha256: {
            photo: pinnedFreshManifest.sources.photo.sha256,
            video: pinnedFreshManifest.sources.video.sha256,
          },
        }
      : {}),
    ...(v19Manifest
      ? {
          oracleJsSha256: ORACLE_JS_HASH,
          freshFreezeId: v19Manifest.freezeId,
          freshGeneratorSha256: v19Manifest.generatorSha256,
          freshSourceSha256: Object.fromEntries(
            v19Manifest.fixtures.map((row) => [row.id, row.sha256])
          ),
        }
      : {}),
    ...(v14Manifest ? { freshDispositionSha256: V14_DISPOSITION_SHA256 } : {}),
    ...(v15Manifest ? { freshDispositionSha256: V15_DISPOSITION_SHA256 } : {}),
    ...(v16Manifest ? { freshDispositionSha256: V16_DISPOSITION_SHA256 } : {}),
    candidateWasmSha256,
    candidateProvenanceSha256,
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
  };
  if (options.split === 'held-out' && (identities.dirty || identities.harnessDirty)) {
    throw new Error('Held-out acceptance requires committed candidate and harness identities');
  }
  const readV19 =
    v19Manifest && v19Packed
      ? v19PackedReader(v19Packed, v19Manifest, readFreshReceipt, digest)
      : undefined;
  if (reservedManifest || v19Manifest) mkdirSync(output);
  const v15Fixtures = v15Manifest
    ? preflightV15(v15Manifest, options.sources, ROOT, options.regression ?? false)
    : undefined;
  const v16Fixtures = v16Manifest
    ? preflightV16(v16Manifest, options.sources, ROOT, true)
    : undefined;
  const v17Fixtures = v17Manifest ? preflightV17(v17Manifest, options.sources, ROOT) : undefined;
  const v18Fixtures = v18Manifest ? preflightV18(v18Manifest, options.sources, ROOT) : undefined;
  writeFileSync(join(output, 'identities.json'), `${JSON.stringify(identities, null, 2)}\n`, {
    flag: 'wx',
  });
  const results: object[] = [];
  for (const spec of selected) {
    const freshV13 = V13_HELDOUT.some((entry) => entry.id === spec.id);
    const freshV7 = V7_HELDOUT.some((entry) => entry.id === spec.id);
    const freshV6 = V6_HELDOUT.some((entry) => entry.id === spec.id);
    const freshV5 = V5_HELDOUT.some((entry) => entry.id === spec.id);
    const freshV4 = V4_HELDOUT.some((entry) => entry.id === spec.id);
    const correction =
      CORRECTION_TUNING.some((entry) => entry.id === spec.id) ||
      CORRECTION_HELDOUT.some((entry) => entry.id === spec.id);
    const fresh =
      V3_TUNING.some((entry) => entry.id === spec.id) ||
      V3_HELDOUT.some((entry) => entry.id === spec.id);
    const fixture =
      readV19?.(spec) ??
      v18Fixtures?.get(spec.id) ??
      v17Fixtures?.get(spec.id) ??
      v16Fixtures?.get(spec.id) ??
      v15Fixtures?.get(spec.id) ??
      v14Fixtures?.get(spec.id) ??
      (freshV13
        ? generateV13Fixture(spec.id, options.sources, v13Manifest!)
        : freshV7
          ? generateV7Fixture(spec.id, options.sources)
          : freshV6
            ? generateV6Fixture(spec.id, options.sources)
            : freshV5
              ? generateV5Fixture(spec.id, options.sources)
              : freshV4
                ? generateV4Fixture(spec.id, options.sources)
                : fresh
                  ? generateV3Fixture(spec.id, options.sources)
                  : correction
                    ? generateCorrectionFixture(spec.id, options.sources)
                    : generateFixture(spec.id, options.sources));
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
  assert.equal(results.length, selection.expectedConditionCount);
  const report = { ...identities, results };
  writeFileSync(join(output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
  });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const fixtureIds = parseFixtureIds(args);
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
  const photoA = args.includes('--photo-a') ? args[args.indexOf('--photo-a') + 1] : undefined;
  const photoB = args.includes('--photo-b') ? args[args.indexOf('--photo-b') + 1] : undefined;
  const v14Photo = args.includes('--v14-photo') ? args[args.indexOf('--v14-photo') + 1] : undefined;
  const v14Video = args.includes('--v14-video') ? args[args.indexOf('--v14-video') + 1] : undefined;
  const v15Photo = args.includes('--v15-photo') ? args[args.indexOf('--v15-photo') + 1] : undefined;
  const v15Video = args.includes('--v15-video') ? args[args.indexOf('--v15-video') + 1] : undefined;
  const v16Photo = args.includes('--v16-photo') ? args[args.indexOf('--v16-photo') + 1] : undefined;
  const v16Video = args.includes('--v16-video') ? args[args.indexOf('--v16-video') + 1] : undefined;
  const v17Photo = args.includes('--v17-photo') ? args[args.indexOf('--v17-photo') + 1] : undefined;
  const v17Video = args.includes('--v17-video') ? args[args.indexOf('--v17-video') + 1] : undefined;
  const v18Photo = args.includes('--v18-photo') ? args[args.indexOf('--v18-photo') + 1] : undefined;
  const v18Video = args.includes('--v18-video') ? args[args.indexOf('--v18-video') + 1] : undefined;
  const v19Packed = args.includes('--v19-packed')
    ? args[args.indexOf('--v19-packed') + 1]
    : undefined;
  const cohort = args.includes('--cohort') ? args[args.indexOf('--cohort') + 1] : 'initial-v1';
  if (
    cohort !== 'initial-v1' &&
    cohort !== 'corrected-v2' &&
    cohort !== 'corrected-v3' &&
    cohort !== 'corrected-v4' &&
    cohort !== 'corrected-v5' &&
    cohort !== 'corrected-v6' &&
    cohort !== 'corrected-v7' &&
    cohort !== 'corrected-v13' &&
    cohort !== 'corrected-v14' &&
    cohort !== 'corrected-v15' &&
    cohort !== 'corrected-v16' &&
    cohort !== 'corrected-v17' &&
    cohort !== 'corrected-v18' &&
    cohort !== 'corrected-v19'
  )
    throw new Error('Unknown fixture cohort');
  if (acceptance && regression) throw new Error('Choose acceptance or exposed regression');
  const candidateRoot = args.includes('--candidate-root')
    ? args[args.indexOf('--candidate-root') + 1]
    : undefined;
  if (!args.includes('--output') || !output)
    throw new Error(
      'Use --output NEW_EVIDENCE_DIRECTORY [--photo-a PATH --photo-b PATH for V13] [--v14-photo PATH --v14-video PATH for V14] [--v15-photo PATH --v15-video PATH for V15] [--v16-photo PATH --v16-video PATH for V16] [--v17-photo PATH --v17-video PATH for V17] [--v18-photo PATH --v18-video PATH for V18] [--fixture ID ... for tuning or --regression only]'
    );
  const report = await compare({
    output,
    split: acceptance || regression ? 'held-out' : 'tuning',
    cohort,
    regression,
    ...(fixtureIds ? { fixtureIds } : {}),
    sources: {
      ...(photo ? { photo } : {}),
      ...(video ? { video } : {}),
      ...(tuningPhoto ? { tuningPhoto } : {}),
      ...(freshPhoto ? { freshPhoto } : {}),
      ...(photoA ? { photoA } : {}),
      ...(photoB ? { photoB } : {}),
      ...(v14Photo ? { v14Photo } : {}),
      ...(v14Video ? { v14Video } : {}),
      ...(v15Photo ? { v15Photo } : {}),
      ...(v15Video ? { v15Video } : {}),
      ...(v16Photo ? { v16Photo } : {}),
      ...(v16Video ? { v16Video } : {}),
      ...(v17Photo ? { v17Photo } : {}),
      ...(v17Video ? { v17Video } : {}),
      ...(v18Photo ? { v18Photo } : {}),
      ...(v18Video ? { v18Video } : {}),
      ...(v19Packed ? { v19Packed } : {}),
    },
    ...(candidateRoot ? { candidateRoot } : {}),
  });
  console.log(JSON.stringify(report, null, 2));
}
