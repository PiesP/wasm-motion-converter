/** Prospective V14 source recipes. This module has no candidate or comparator dependency. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QUALITIES, type FixtureSpec, type PixelFixture } from './owned-vp8-v2-fixtures.ts';
import { assertV13PriorManifestRoles, type V13Manifest } from './owned-vp8-v13-fixtures.ts';

export type V14SourcePaths = { v14Photo?: string; v14Video?: string };
type Region = readonly [x: number, y: number, width: number, height: number];
type Recipe = FixtureSpec & { region?: Region; pts?: number };
type SourcePin = {
  page: string;
  revision: string;
  download: string;
  author: string;
  license: string;
  licenseUrl: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
};
export type V14Manifest = {
  schemaVersion: number;
  cohort: string;
  status: 'PROSPECTIVE_UNFROZEN' | 'FROZEN_UNEXECUTED' | 'EXPOSED_REGRESSION';
  freezeId: string;
  attemptBudget: number;
  thresholds: typeof THRESHOLDS;
  generatorSha256: string;
  ffmpegVersion: string;
  sources: { photo: SourcePin; video: SourcePin & { streamIndex: number; timeBase: string } };
  priorV13: { path: string; sha256: string };
  fixtures: Array<Recipe & { stride: number; qualities: number[]; sha256: string | null }>;
};

const FREEZE_ID = 'vp8-v14-first-heldout-20261120-01';
const THRESHOLDS = {
  psnrBaselineDeltaDb: -1,
  ssimBaselineDelta: -0.01,
  sizeRatio: 1.25,
  sizeAdditiveBytes: 128,
};
const PRIOR_V13 = {
  path: 'docs/experiments/501-owned-vp8-v13-fixtures.json',
  sha256: 'eedc528acbeaf09faf94330ef4f2501d2209ad628fa92c8fd0b6e6e8ed49df3d',
};
const MEDIA = {
  photo: {
    width: 3240,
    height: 4320,
    bytes: 4944951,
    sha256: 'ce9f07d1ffcd63fd8c13b7e0fe86eae2f224a601ee54121885727c387cfba1d3',
  },
  video: {
    width: 640,
    height: 360,
    bytes: 789968,
    sha256: '50fb6cacfbb5133c66f9759f6d4d0282c7f2b16ed1bea3c88ed819cb1744423e',
    streamIndex: 0,
    timeBase: '1/1000',
  },
};
const SEED = 0x501e1401;
const SHA = /^[a-f0-9]{64}$/;
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function recipe(
  name: string,
  kind: string,
  width: number,
  height: number,
  source: FixtureSpec['source'] = 'generated'
): Recipe {
  return {
    id: `fresh14-${name}`,
    split: 'held-out',
    class: kind,
    width,
    height,
    layout: 'RGBA',
    source,
  };
}

export const V14_HELDOUT: readonly Recipe[] = [
  recipe('neutral', 'neutral', 557, 347),
  recipe('near-neutral', 'near-neutral', 421, 281),
  recipe('glyph', 'glyph-edge', 457, 323),
  recipe('diagonal', 'diagonal-chroma', 419, 271),
  recipe('dark', 'dark-gradient', 401, 253),
  recipe('saturated', 'saturated-boundary', 389, 265),
  recipe('noise', 'deterministic-noise', 317, 229),
  recipe('curvature', 'mixed-curvature', 431, 307),
  recipe('tiny', 'tiny', 1, 13),
  recipe('odd', 'odd', 5, 9),
  recipe('wide', 'wide-shallow', 2053, 23),
  recipe('large', 'large-admitted', 3329, 1949),
  { ...recipe('photo-nw', 'photograph-crop', 353, 461, 'photo'), region: [180, 270, 1260, 1620] },
  { ...recipe('photo-ne', 'photograph-crop', 337, 419, 'photo'), region: [1800, 270, 1260, 1620] },
  { ...recipe('photo-sw', 'photograph-crop', 331, 437, 'photo'), region: [180, 2430, 1260, 1620] },
  { ...recipe('photo-se', 'photograph-crop', 349, 457, 'photo'), region: [1800, 2430, 1260, 1620] },
  { ...recipe('video-1000', 'video-packet-pts', 533, 301, 'video'), pts: 1000 },
  { ...recipe('video-4000', 'video-packet-pts', 517, 293, 'video'), pts: 4000 },
  { ...recipe('video-6000', 'video-packet-pts', 491, 279, 'video'), pts: 6000 },
  { ...recipe('video-8000', 'video-packet-pts', 557, 315, 'video'), pts: 8000 },
];

function generated({ id, width, height }: Recipe): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  let random = SEED;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const luma = (9 * x + 23 * y) & 255;
      let rgb: readonly [number, number, number];
      switch (id) {
        case 'fresh14-neutral':
          rgb = [luma, luma, luma];
          break;
        case 'fresh14-near-neutral': {
          const n = 8 + (luma % 240);
          rgb = [n, n - 3, n + 4];
          break;
        }
        case 'fresh14-glyph':
          rgb = x % 71 < 6 || (y % 47 < 4 && x % 71 < 35) ? [235, 53, 96] : [24, 38, 46];
          break;
        case 'fresh14-diagonal':
          rgb = ((x * 7 + y * 11) >> 5) & 1 ? [219, 45, 137] : [42, 171, 225];
          break;
        case 'fresh14-dark':
          rgb = [9 + ((x + y) >> 5), 4 + ((x + 3 * y) >> 6), 3 + ((4 * x + y) >> 6)];
          break;
        case 'fresh14-saturated':
          rgb = x * 3 + y < width * 2 ? [15, 228, 31] : [239, 22, 202];
          break;
        case 'fresh14-noise':
          random ^= random << 13;
          random ^= random >>> 17;
          random ^= random << 5;
          rgb = [random & 255, (random >>> 8) & 255, (random >>> 16) & 255];
          break;
        case 'fresh14-curvature': {
          const arc = ((x - 113) ** 2 + 3 * (y - 211) ** 2) >> 9;
          rgb = [(arc + luma) & 255, (2 * arc + y) & 255, (arc + 3 * x) & 255];
          break;
        }
        case 'fresh14-tiny':
        case 'fresh14-odd':
          rgb = [(x * 67 + y * 37) & 255, (x * 19 + y * 83) & 255, (x * 47 + y * 17) & 255];
          break;
        case 'fresh14-wide':
          rgb = [(x >> 4) & 255, (x + y * 31) & 255, ((x * y) >> 6) & 255];
          break;
        case 'fresh14-large': {
          const n = ((x >> 3) + (y >> 2)) & 255;
          rgb = [n, (n + (x >> 5)) & 255, (n + (y >> 5)) & 255];
          break;
        }
        default:
          throw new Error(`Unknown V14 generated input: ${id}`);
      }
      pixels[offset] = rgb[0];
      pixels[offset + 1] = rgb[1];
      pixels[offset + 2] = rgb[2];
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

export function assertV14Shape(manifest: V14Manifest): void {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.cohort, 'corrected-v14');
  assert.equal(manifest.freezeId, FREEZE_ID);
  assert.equal(manifest.attemptBudget, 1);
  assert.deepEqual(manifest.thresholds, THRESHOLDS);
  assert.deepEqual(manifest.priorV13, PRIOR_V13);
  for (const kind of ['photo', 'video'] as const) {
    const pin = manifest.sources[kind];
    for (const field of [
      'page',
      'revision',
      'download',
      'author',
      'license',
      'licenseUrl',
    ] as const)
      assert.ok(pin[field]?.trim(), `V14 ${kind} attribution is missing ${field}`);
    for (const [key, value] of Object.entries(MEDIA[kind]))
      assert.equal(pin[key as keyof typeof pin], value, `V14 ${kind} ${key} changed`);
  }
  assert.equal(V14_HELDOUT.length, 20);
  assert.equal(manifest.fixtures.length, V14_HELDOUT.length);
  const ids = new Set<string>();
  for (const [index, spec] of V14_HELDOUT.entries()) {
    const { sha256, ...row } = manifest.fixtures[index]!;
    assert.deepEqual(row, { ...spec, stride: spec.width * 4, qualities: [...QUALITIES] });
    assert.ok(sha256 === null || SHA.test(sha256), `${spec.id} has an invalid pixel hash`);
    assert.ok(!ids.has(spec.id), `${spec.id} is duplicated`);
    ids.add(spec.id);
    assert.ok(spec.width > 0 && spec.height > 0 && spec.width <= 16383 && spec.height <= 16383);
    assert.ok(spec.width * spec.height <= 10_066_329);
  }
}

function priorIdentities(root: string) {
  const inputs = new Set<string>();
  const sources = new Set<string>();
  const ids = new Set<string>();
  const readPin = (pin: { path: string | null; sha256: string | null }) => {
    assert.ok(pin.path && pin.sha256);
    const bytes = readFileSync(resolve(root, pin.path));
    assert.equal(digest(bytes), pin.sha256, `${pin.path} canonical prior manifest changed`);
    return JSON.parse(bytes.toString('utf8')) as V13Manifest;
  };
  const v13 = readPin(PRIOR_V13);
  assert.equal(v13.status, 'EXPOSED_REGRESSION');
  assertV13PriorManifestRoles(v13);
  const collectSources = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'sha256' || key === 'originalSha256') && typeof child === 'string')
        sources.add(child);
      else collectSources(child);
    }
  };
  for (const prior of [v13, ...Object.values(v13.priorManifests).map(readPin)]) {
    for (const { id, sha256 } of prior.fixtures) {
      assert.ok(id && sha256 && SHA.test(sha256), 'Prior input pin is incomplete');
      inputs.add(sha256);
      ids.add(id);
    }
    collectSources(prior.sources);
  }
  return { inputs, sources, ids };
}

function generateFixture(
  item: Recipe,
  paths: { photo: string; video: string },
  manifest: V14Manifest
): PixelFixture {
  const stride = item.width * 4;
  if (item.source === 'generated') return { ...item, stride, pixels: generated(item) };
  const scale = `scale=${item.width}:${item.height}:flags=bicubic`;
  let ffmpegInput: string[];
  let stream: string;
  let filter: string;
  if (item.region) {
    const [x, y, width, height] = item.region;
    ffmpegInput = ['-i', paths.photo];
    stream = '0:v:0';
    filter = `crop=${width}:${height}:${x}:${y}:exact=1,${scale}`;
  } else {
    const { streamIndex, timeBase } = manifest.sources.video;
    ffmpegInput = ['-copyts', '-i', paths.video];
    stream = `0:${streamIndex}`;
    filter = `settb=expr=${timeBase},select=eq(pts\\,${item.pts}),${scale}`;
  }
  const pixels = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-noautorotate',
      ...ffmpegInput,
      '-map',
      stream,
      '-vf',
      filter,
      '-frames:v',
      '1',
      '-an',
      '-c:v',
      'rawvideo',
      '-threads:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      'pipe:1',
    ],
    { maxBuffer: stride * item.height + 4096 }
  );
  assert.equal(pixels.length, stride * item.height, `${item.id} decoded length changed`);
  return { ...item, stride, pixels };
}

function validateSourcePins(manifest: V14Manifest, paths: V14SourcePaths, root: string) {
  assertV14Shape(manifest);
  assert.equal(manifest.generatorSha256, digest(readFileSync(fileURLToPath(import.meta.url))));
  const prior = priorIdentities(root);
  const repo = realpathSync(root);
  const photo = paths.v14Photo;
  const video = paths.v14Video;
  assert.ok(photo && video, 'V14 needs --v14-photo and --v14-video private originals');
  const originals = { photo: realpathSync(photo), video: realpathSync(video) };
  assert.notEqual(manifest.sources.photo.sha256, manifest.sources.video.sha256);
  for (const [kind, path] of Object.entries(originals) as Array<['photo' | 'video', string]>) {
    const subpath = relative(repo, path);
    assert.ok(subpath.startsWith(`..${sep}`), `V14 ${kind} must be outside the harness checkout`);
    const pin = manifest.sources[kind];
    assert.ok(!prior.sources.has(pin.sha256), `V14 ${kind} reuses an exposed original`);
    const bytes = readFileSync(path);
    assert.equal(bytes.length, pin.bytes, `V14 ${kind} original byte length changed`);
    assert.equal(digest(bytes), pin.sha256, `V14 ${kind} original SHA-256 changed`);
  }
  const version = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0];
  assert.ok(version?.trim());
  assert.equal(version, manifest.ffmpegVersion, 'V14 FFmpeg version changed');
  return { prior, originals };
}

function collectFixtures(
  manifest: V14Manifest,
  paths: V14SourcePaths,
  root: string,
  verify: boolean
) {
  const { prior, originals } = validateSourcePins(manifest, paths, root);
  const result = new Map<string, { fixture: PixelFixture; sha256: string }>();
  for (const [index, spec] of V14_HELDOUT.entries()) {
    assert.ok(!prior.ids.has(spec.id), `${spec.id} reuses an exposed ID`);
    const fixture = generateFixture(spec, originals, manifest);
    const sha256 = digest(fixture.pixels);
    if (verify)
      assert.equal(sha256, manifest.fixtures[index]!.sha256, `${spec.id} pixel pin changed`);
    assert.ok(!prior.inputs.has(sha256), `${spec.id} pixel hash matches a prior input`);
    prior.inputs.add(sha256);
    result.set(spec.id, { fixture, sha256 });
  }
  return result;
}

/** Reject draft/wrong-purpose manifests before examining originals, FFmpeg or either encoder. */
export function preflightV14(
  manifest: V14Manifest,
  paths: V14SourcePaths,
  root: string,
  regression: boolean
) {
  assert.equal(
    manifest.status,
    regression ? 'EXPOSED_REGRESSION' : 'FROZEN_UNEXECUTED',
    'V14 draft or wrong-purpose cohort is not acceptance ready'
  );
  assert.ok(
    manifest.fixtures.every((row) => row.sha256 && SHA.test(row.sha256)),
    'V14 pixel pins are incomplete'
  );
  const rows = collectFixtures(manifest, paths, root, true);
  return new Map([...rows].map(([id, { fixture }]) => [id, fixture]));
}

/** Emit source-only pixel pins for review; this never promotes the draft. */
export function prepareV14Manifest(
  manifest: V14Manifest,
  paths: V14SourcePaths,
  root: string
): V14Manifest {
  assert.equal(manifest.status, 'PROSPECTIVE_UNFROZEN');
  assert.ok(
    manifest.fixtures.every((row) => row.sha256 === null),
    'V14 source-only draft is already populated'
  );
  const rows = collectFixtures(manifest, paths, root, false);
  return {
    ...manifest,
    fixtures: manifest.fixtures.map((row) => ({ ...row, sha256: rows.get(row.id)!.sha256 })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.equal(args.length, 4, 'Use --v14-photo ORIGINAL --v14-video ORIGINAL');
  assert.equal(args[0], '--v14-photo');
  assert.equal(args[2], '--v14-video');
  const root = resolve(import.meta.dirname, '../..');
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v14-fixtures.json'), 'utf8')
  ) as V14Manifest;
  const prepared = prepareV14Manifest(manifest, { v14Photo: args[1]!, v14Video: args[3]! }, root);
  process.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`);
}
