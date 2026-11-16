/** Prospective V13 source-only recipes. No candidate or comparator output is read here. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QUALITIES, type FixtureSpec, type PixelFixture } from './owned-vp8-v2-fixtures.ts';

export type V13SourcePaths = { photoA?: string; photoB?: string };
type Region = { x: number; y: number; width: number; height: number };
type PhotoPin = {
  page: string | null;
  revision: string | null;
  download: string | null;
  license: string | null;
  author: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  sha256: string | null;
};
export type V13Manifest = {
  schemaVersion: number;
  cohort: string;
  status: string | null;
  freezeId: string | null;
  attemptBudget: number | null;
  thresholds: {
    psnrBaselineDeltaDb: number;
    ssimBaselineDelta: number;
    sizeRatio: number;
    sizeAdditiveBytes: number;
  };
  generatorSha256: string | null;
  ffmpegVersion: string | null;
  sources: { photoA: PhotoPin; photoB: PhotoPin };
  priorManifests: Record<string, { path: string | null; sha256: string | null }>;
  fixtures: Array<
    FixtureSpec & {
      stride: number;
      qualities: number[];
      sha256: string | null;
      photo?: 'photoA' | 'photoB';
      region?: Region;
    }
  >;
};

// Canonical source-only manifests: V1-V7 at b9b7e893, V8-V11 at e8067062,
// V12 at 6e0b1e07. Each digest was read from that revision's committed JSON.
const PRIOR_MANIFEST_ROLES = {
  initialV1: [
    '501-owned-vp8-v2-fixtures.json',
    '75646176a29a6cc6506b07d5ad955401571573df1cd7f2c217f9b7565b7f5918',
    null,
  ],
  correctedV2: [
    '501-owned-vp8-v2-correction-fixtures.json',
    '015b9a64af8cdc648f7ac976c14e64ae355a239f343115d21f2269c381afeb81',
    'corrected-v2',
  ],
  correctedV3: [
    '501-owned-vp8-v3-fixtures.json',
    '072947742fe4fce1aaf77702f8cfee3d2c7410a79d5715155f047913f00c2d2a',
    'corrected-v3',
  ],
  correctedV4: [
    '501-owned-vp8-v4-fixtures.json',
    '13c723fe5e5839fc3cc48a06056ada04cce0127b2b04931163a25f9619fd23b7',
    'corrected-v4',
  ],
  correctedV5: [
    '501-owned-vp8-v5-fixtures.json',
    'c8929d67d57c6df20e2c152c85ac4178b9b4a4c9c7184892b62df130de8faf83',
    'corrected-v5',
  ],
  correctedV6: [
    '501-owned-vp8-v6-fixtures.json',
    '7451495d9c36648193d6864d2e68318262989a32c5cb3e621acd9232dc7e9c2b',
    'corrected-v6',
  ],
  correctedV7: [
    '501-owned-vp8-v7-fixtures.json',
    '0fe8e83f194f25c2ba1f6d9e68486c46a4567d631f7db3aee4e5681bd02fa6bb',
    'corrected-v7',
  ],
  correctedV8: [
    '501-owned-vp8-v8-fixtures.json',
    'd4b17b2990ce5fbb96dfa75c3377c8b6fb20336e91e202a5440f5e5d2da24e19',
    'corrected-v8',
  ],
  correctedV9: [
    '501-owned-vp8-v9-fixtures.json',
    '8eeae4aeb52b433ff2936ee7973d31795b6d39edc5f734e0a33de84ebf176c54',
    'corrected-v9',
  ],
  correctedV10: [
    '501-owned-vp8-v10-fixtures.json',
    '741d4674a4ef687be0e57ea02e8d0470bdbd7f21a74b16c17b25e66f9bc8db40',
    'corrected-v10',
  ],
  correctedV11: [
    '501-owned-vp8-v11-fixtures.json',
    '976a1365e7eeb13759df8f00d8b9ff296875c531ad10c707d445a25ac5c298a0',
    'corrected-v11',
  ],
  correctedV12: [
    '501-owned-vp8-v12-fixtures.json',
    '56ce94096af1c1d4424e55854b933f5c82ebc14e06bf8360b6cd9470f1a91d95',
    'corrected-v12',
  ],
} as const;

export function assertV13PriorManifestRoles(manifest: V13Manifest): void {
  assert.deepEqual(Object.keys(manifest.priorManifests), Object.keys(PRIOR_MANIFEST_ROLES));
  for (const [role, [file, sha256]] of Object.entries(PRIOR_MANIFEST_ROLES)) {
    const pin = manifest.priorManifests[role];
    assert.ok(pin?.path && pin.sha256, `${role} prior manifest pin is missing`);
    assert.equal(basename(pin.path), file, `${role} prior manifest filename is wrong`);
    assert.equal(pin.sha256, sha256, `${role} prior manifest role digest is wrong`);
  }
}

const specs = (
  [
    ['neutral', 'neutral', 521, 317],
    ['near-neutral', 'near-neutral', 409, 277],
    ['glyph', 'glyph-edge', 443, 311],
    ['diagonal', 'diagonal-chroma', 379, 269],
    ['dark', 'dark-gradient', 393, 241],
    ['saturated', 'saturated-boundary', 367, 257],
    ['noise', 'deterministic-noise', 313, 223],
    ['curvature', 'mixed-curvature', 419, 283],
    ['tiny', 'tiny', 1, 11],
    ['odd', 'odd', 3, 7],
    ['wide2049', 'wide-shallow', 2049, 17],
    ['muted', 'muted-texture', 307, 211],
    ['checker', 'checker-edge', 343, 233],
  ] as const
).map(([name, kind, width, height]): FixtureSpec => ({
  id: `fresh13-${name}`,
  split: 'held-out',
  class: kind,
  width,
  height,
  layout: 'RGBA',
  source: 'generated',
}));

export const V13_HELDOUT: readonly FixtureSpec[] = [
  ...specs,
  ...([0, 1, 2] as const).flatMap((index) =>
    (['photoA', 'photoB'] as const).map((photo): FixtureSpec => ({
      id: `fresh13-${photo}-${index + 1}`,
      split: 'held-out',
      class: 'photograph-crop',
      width: [401, 337, 289][index]!,
      height: [271, 247, 193][index]!,
      layout: 'RGBA',
      source: 'photo',
    }))
  ),
  {
    id: 'fresh13-duplicate-hold',
    split: 'held-out',
    class: 'intentional-duplicate',
    width: 401,
    height: 271,
    layout: 'RGBA',
    source: 'photo',
    repeatOf: 'fresh13-photoA-1',
  },
];

const SEED = 0x501d1301;
function generated(item: FixtureSpec): Uint8Array {
  const pixels = new Uint8Array(item.width * item.height * 4);
  let random = SEED;
  for (let y = 0; y < item.height; y++)
    for (let x = 0; x < item.width; x++) {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      random >>>= 0;
      const stripe = ((x * 5 + y * 7) >> 4) & 1;
      let rgb: readonly number[];
      switch (item.id) {
        case 'fresh13-neutral': {
          const n = (17 * x + 31 * y) & 255;
          rgb = [n, n, n];
          break;
        }
        case 'fresh13-near-neutral': {
          const n = (11 * x + 19 * y) & 255;
          rgb = [n, (n + 2) & 255, (n + 5) & 255];
          break;
        }
        case 'fresh13-glyph':
          rgb = (x % 67 < 8 || y % 43 < 5) && x > 20 && y > 20 ? [243, 218, 39] : [37, 48, 77];
          break;
        case 'fresh13-diagonal':
          rgb = stripe ? [227, 31, 183] : [21, 204, 69];
          break;
        case 'fresh13-dark':
          rgb = [((x + y) >> 5) & 63, ((3 * x + y) >> 6) & 63, ((x + 3 * y) >> 5) & 63];
          break;
        case 'fresh13-saturated':
          rgb = x < item.width / 2 ? [249, 18, 35] : [14, 39, 251];
          break;
        case 'fresh13-noise':
          rgb = [random & 255, (random >>> 8) & 255, (random >>> 16) & 255];
          break;
        case 'fresh13-curvature': {
          const r = Math.floor(Math.hypot(x - 211, y - 142));
          rgb = [(r * 7) & 255, ((x * y) >> 8) & 255, (r + x - y) & 255];
          break;
        }
        case 'fresh13-tiny':
        case 'fresh13-odd':
          rgb = [(x * 71 + y * 43) & 255, (x * 29 + y * 89) & 255, (x * 53 + y * 13) & 255];
          break;
        case 'fresh13-wide2049':
          rgb = [(x >> 3) & 255, (x + y * 17) & 255, ((x * y) >> 5) & 255];
          break;
        case 'fresh13-muted':
          rgb = [86 + (random & 31), 92 + ((random >>> 8) & 31), 97 + ((random >>> 16) & 31)];
          break;
        case 'fresh13-checker':
          rgb = ((x >> 3) ^ (y >> 3)) & 1 ? [232, 205, 61] : [33, 51, 209];
          break;
        default:
          throw new Error(`Unknown V13 generated fixture: ${item.id}`);
      }
      const offset = (y * item.width + x) * 4;
      pixels.set([rgb[0]!, rgb[1]!, rgb[2]!, 255], offset);
    }
  return pixels;
}

function requiredPin(
  pin: PhotoPin,
  label: string
): asserts pin is PhotoPin & {
  width: number;
  height: number;
  bytes: number;
  sha256: string;
} {
  assert.ok(
    pin.width && pin.height && pin.bytes,
    `${label} original geometry and bytes are not frozen`
  );
  assert.match(pin.sha256 ?? '', /^[a-f0-9]{64}$/, `${label} original SHA-256 is not frozen`);
}

export function generateV13Fixture(
  id: string,
  paths: V13SourcePaths,
  manifest: V13Manifest
): PixelFixture {
  const item = V13_HELDOUT.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown V13 fixture: ${id}`);
  if (item.source === 'generated')
    return { ...item, stride: item.width * 4, pixels: generated(item) };
  const row = manifest.fixtures.find((entry) => entry.id === id);
  const original = row?.repeatOf
    ? manifest.fixtures.find((entry) => entry.id === row.repeatOf)
    : row;
  const photo = original?.photo;
  const region = original?.region;
  assert.ok(photo && region, `V13 ${id} photo crop is not frozen`);
  const pin = manifest.sources[photo];
  requiredPin(pin, photo);
  assert.ok(region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0);
  assert.ok(region.x + region.width <= pin.width && region.y + region.height <= pin.height);
  const path = paths[photo];
  assert.ok(path, `Missing ${photo} original for ${id}`);
  const bytes = readFileSync(path);
  assert.equal(bytes.length, pin.bytes, `${photo} original bytes changed`);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    pin.sha256,
    `${photo} original SHA-256 changed`
  );
  const output = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-noautorotate',
      '-i',
      path,
      '-vf',
      `crop=${region.width}:${region.height}:${region.x}:${region.y}:exact=1,scale=${item.width}:${item.height}:flags=bicubic`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      'pipe:1',
    ],
    { maxBuffer: item.width * item.height * 4 + 4096 }
  );
  assert.equal(output.length, item.width * item.height * 4, `V13 ${id} decoded length changed`);
  return { ...item, stride: item.width * 4, pixels: new Uint8Array(output) };
}

export function assertV13Shape(manifest: V13Manifest): void {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.cohort, 'corrected-v13');
  assert.equal(V13_HELDOUT.length, 20);
  assert.equal(manifest.fixtures.length, 20);
  assert.deepEqual(manifest.thresholds, {
    psnrBaselineDeltaDb: -1,
    ssimBaselineDelta: -0.01,
    sizeRatio: 1.25,
    sizeAdditiveBytes: 128,
  });
  assert.deepEqual(
    manifest.fixtures.map((row) => row.id),
    V13_HELDOUT.map((row) => row.id)
  );
  for (let index = 0; index < V13_HELDOUT.length; index++) {
    const spec = V13_HELDOUT[index]!;
    const row = manifest.fixtures[index]!;
    for (const key of [
      'split',
      'class',
      'width',
      'height',
      'layout',
      'source',
      'repeatOf',
    ] as const)
      assert.equal(row[key], spec[key], `${spec.id} ${key} changed`);
    assert.equal(row.stride, spec.width * 4);
    assert.deepEqual(row.qualities, [...QUALITIES]);
    assert.ok(spec.width > 0 && spec.height > 0 && spec.width <= 16383 && spec.height <= 16383);
    assert.ok(spec.width * spec.height <= 10_066_329);
    if (spec.source === 'photo') {
      assert.ok(row.photo && row.region, `${spec.id} source mapping is missing`);
      assert.equal(row.photo, spec.id.includes('photoB') ? 'photoB' : 'photoA');
      if (spec.repeatOf) {
        const prior = manifest.fixtures.find((entry) => entry.id === spec.repeatOf);
        assert.equal(row.photo, prior?.photo);
        assert.deepEqual(row.region, prior?.region);
      }
    }
  }
}

/** Run before candidate prebuilt verification, oracle loading, output creation or encoding. */
export function validateV13SourcePins(
  manifest: V13Manifest,
  paths: V13SourcePaths,
  root: string
): void {
  assertV13Shape(manifest);
  const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  assert.equal(
    manifest.generatorSha256,
    sha256(readFileSync(fileURLToPath(import.meta.url))),
    'V13 generator pin changed'
  );
  const ffmpegVersion = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0];
  assert.equal(manifest.ffmpegVersion, ffmpegVersion, 'V13 FFmpeg decoder pin changed');
  const priorInputIds = new Set<string>();
  const priorInputHashes = new Set<string>();
  const priorSourceHashes = new Set<string>();
  assertV13PriorManifestRoles(manifest);
  for (const [name, pin] of Object.entries(manifest.priorManifests)) {
    assert.ok(pin.path && pin.sha256, `${name} prior manifest pin is missing`);
    const path = isAbsolute(pin.path) ? pin.path : resolve(root, pin.path);
    const bytes = readFileSync(path);
    assert.equal(sha256(bytes), pin.sha256, `${name} prior manifest changed`);
    const prior = JSON.parse(bytes.toString()) as {
      schemaVersion?: number;
      cohort?: string;
      fixtures: Array<{ id: string; sha256: string }>;
      sources?: unknown;
    };
    const expectedCohort = PRIOR_MANIFEST_ROLES[name as keyof typeof PRIOR_MANIFEST_ROLES][2];
    assert.equal(prior.schemaVersion, 1, `${name} prior manifest schema changed`);
    assert.equal(
      prior.cohort,
      expectedCohort ?? undefined,
      `${name} prior manifest cohort is wrong`
    );
    assert.ok(Array.isArray(prior.fixtures) && prior.fixtures.length > 0);
    for (const row of prior.fixtures) {
      assert.ok(row.id && /^[a-f0-9]{64}$/.test(row.sha256), `${name} incomplete input pin`);
      priorInputIds.add(row.id);
      priorInputHashes.add(row.sha256);
    }
    const collectSources = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (
          (key === 'sha256' || key === 'originalSha256') &&
          typeof child === 'string' &&
          /^[a-f0-9]{64}$/.test(child)
        )
          priorSourceHashes.add(child);
        else collectSources(child);
      }
    };
    collectSources(prior.sources);
  }
  assert.notEqual(
    manifest.sources.photoA.sha256,
    manifest.sources.photoB.sha256,
    'V13 originals must be distinct'
  );
  for (const [name, pin] of Object.entries(manifest.sources)) {
    requiredPin(pin, name);
    for (const key of ['page', 'revision', 'download', 'license', 'author'] as const)
      assert.ok(pin[key]?.trim(), `${name} ${key} is not frozen`);
    assert.ok(!priorSourceHashes.has(pin.sha256), `${name} reuses an exposed original`);
  }
  const currentHashes = new Map<string, string>();
  for (const row of manifest.fixtures) {
    assert.ok(!priorInputIds.has(row.id), `${row.id} reuses an exposed ID`);
    const fixture = generateV13Fixture(row.id, paths, manifest);
    const hash = sha256(fixture.pixels);
    assert.equal(row.sha256, hash, `${row.id} pixel pin is missing or changed`);
    assert.ok(!priorInputHashes.has(hash), `${row.id} collides with an exposed input`);
    const priorId = currentHashes.get(hash);
    assert.equal(priorId, row.repeatOf, `${row.id} has an unplanned V13 duplicate`);
    currentHashes.set(hash, row.id);
  }
  const crops = manifest.fixtures.filter((row) => row.source === 'photo' && !row.repeatOf);
  for (const first of crops)
    for (const second of crops) {
      if (first === second || first.photo !== second.photo || first.id >= second.id) continue;
      const a = first.region!;
      const b = second.region!;
      assert.ok(
        a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y,
        `${first.id} and ${second.id} overlap`
      );
    }
}

export function preflightV13(
  manifest: V13Manifest,
  paths: V13SourcePaths,
  root: string,
  regression = false
): void {
  assert.equal(
    manifest.status,
    regression ? 'EXPOSED_REGRESSION' : 'FROZEN_UNEXECUTED',
    'V13 draft or wrong-purpose cohort is not acceptance ready'
  );
  assert.ok(manifest.freezeId && manifest.freezeId.trim(), 'V13 prospective freeze ID is missing');
  assert.equal(manifest.attemptBudget, 1, 'V13 one-attempt budget is not frozen');
  validateV13SourcePins(manifest, paths, root);
}

/** Produce reviewed source-only pins on stdout; keep the result UNFROZEN. */
export function prepareV13Manifest(
  manifest: V13Manifest,
  paths: V13SourcePaths,
  root: string
): V13Manifest {
  assert.equal(manifest.status, 'PROSPECTIVE_UNFROZEN');
  assertV13Shape(manifest);
  const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  const filled: V13Manifest = {
    ...manifest,
    generatorSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    ffmpegVersion: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
    fixtures: manifest.fixtures.map((row) => ({
      ...row,
      sha256: sha256(generateV13Fixture(row.id, paths, manifest).pixels),
    })),
  };
  validateV13SourcePins(filled, paths, root);
  return filled;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined =>
    args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const root = resolve(import.meta.dirname, '../..');
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v13-fixtures.json'), 'utf8')
  ) as V13Manifest;
  process.stdout.write(
    `${JSON.stringify(
      prepareV13Manifest(
        manifest,
        {
          ...(value('--photo-a') ? { photoA: value('--photo-a')! } : {}),
          ...(value('--photo-b') ? { photoB: value('--photo-b')! } : {}),
        },
        root
      ),
      null,
      2
    )}\n`
  );
}
