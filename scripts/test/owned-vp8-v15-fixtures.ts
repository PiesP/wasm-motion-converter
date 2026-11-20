/** Prospective V15 source recipes. This module has no candidate or comparator dependency. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QUALITIES, type FixtureSpec, type PixelFixture } from './owned-vp8-v2-fixtures.ts';
import { assertV13PriorManifestRoles, type V13Manifest } from './owned-vp8-v13-fixtures.ts';
import { assertV14Shape, type V14Manifest } from './owned-vp8-v14-fixtures.ts';

export type V15SourcePaths = { v15Photo?: string; v15Video?: string };
type Region = readonly [x: number, y: number, width: number, height: number];
type Recipe = FixtureSpec & { region?: Region; seconds?: number; pts?: number };
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
export type V15Manifest = {
  schemaVersion: number;
  cohort: string;
  status: 'PROSPECTIVE_UNFROZEN' | 'FROZEN_UNEXECUTED' | 'EXPOSED_REGRESSION';
  freezeId: string;
  attemptBudget: number;
  thresholds: typeof THRESHOLDS;
  generatorSha256: string;
  ffmpegVersion: string;
  sources: { photo: SourcePin; video: SourcePin & { streamIndex: number; timeBase: string } };
  sourceSelectionSha256: string;
  sourceMetadataSha256: string;
  priorV13: { path: string; sha256: string };
  priorV14: { path: string; sha256: string };
  fixtures: Array<Recipe & { stride: number; qualities: number[]; sha256: string | null }>;
};

const FREEZE_ID = 'vp8-v15-first-heldout-20261120-01';
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
const PRIOR_V14 = {
  path: 'docs/experiments/501-owned-vp8-v14-fixtures.json',
  sha256: 'f4f096225a12d56ebba36b5e1f8676fff508022865049e232f1d38a603bdae59',
};
const SOURCE_SELECTION_SHA = 'b774c622e185f9d3dab1007f6782de431ecf356afa8fb4758ab5ed3aa132c5af';
const SOURCE_METADATA_SHA = 'fff1f152ec9d433167973f989f6a297964bcbf4c65d131ecb6e87b58a5e85f4e';
const MEDIA = {
  photo: {
    page: 'https://commons.wikimedia.org/wiki/File:Rotterdam_aerial_photograph.jpg',
    revision:
      'https://commons.wikimedia.org/w/index.php?title=File:Rotterdam_aerial_photograph.jpg&oldid=1226096299',
    download: 'https://upload.wikimedia.org/wikipedia/commons/7/7c/Rotterdam_aerial_photograph.jpg',
    author: 'acediscovery',
    license: 'CC-BY-4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    width: 1581,
    height: 1383,
    bytes: 2326693,
    sha256: 'c2811ae01650ba6b942e647cd84e1b5ae0403d84862ea3d457c2b794bb83e994',
  },
  video: {
    page: 'https://commons.wikimedia.org/wiki/File:River_Bank-Closeup.webm',
    revision:
      'https://commons.wikimedia.org/w/index.php?title=File:River_Bank-Closeup.webm&oldid=1204104561',
    download: 'https://upload.wikimedia.org/wikipedia/commons/7/7a/River_Bank-Closeup.webm',
    author: 'Chazzie1769',
    license: 'CC0-1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    width: 1920,
    height: 1080,
    bytes: 23973140,
    sha256: '8e54de109cd68404f3cceab59a2cdd842d7916f53a164641dced6aee12ed2381',
    streamIndex: 0,
    timeBase: '1/1000',
  },
};
const SEED = 0x501e1501;
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
    id: `fresh15-${name}`,
    split: 'held-out',
    class: kind,
    width,
    height,
    layout: 'RGBA',
    source,
  };
}

export const V15_HELDOUT: readonly Recipe[] = [
  recipe('neutral', 'neutral', 541, 359),
  recipe('near-neutral', 'near-neutral', 439, 273),
  recipe('glyph', 'glyph-edge', 467, 309),
  recipe('diagonal', 'diagonal-chroma', 433, 283),
  recipe('dark', 'dark-gradient', 379, 257),
  recipe('saturated', 'saturated-boundary', 403, 269),
  recipe('noise', 'deterministic-noise', 331, 241),
  recipe('curvature', 'mixed-curvature', 449, 293),
  recipe('tiny', 'tiny', 1, 17),
  recipe('odd', 'odd', 7, 11),
  recipe('wide', 'wide-shallow', 2063, 27),
  recipe('large', 'large-admitted', 3391, 1961),
  { ...recipe('photo-nw', 'photograph-crop', 443, 373, 'photo'), region: [64, 72, 660, 560] },
  { ...recipe('photo-ne', 'photograph-crop', 421, 359, 'photo'), region: [849, 72, 660, 560] },
  { ...recipe('photo-sw', 'photograph-crop', 457, 389, 'photo'), region: [64, 728, 660, 560] },
  { ...recipe('photo-se', 'photograph-crop', 433, 367, 'photo'), region: [849, 728, 660, 560] },
  { ...recipe('video-1s', 'video-packet-pts', 541, 305, 'video'), seconds: 1, pts: 1001 },
  { ...recipe('video-4s', 'video-packet-pts', 509, 287, 'video'), seconds: 4, pts: 4004 },
  { ...recipe('video-6s', 'video-packet-pts', 527, 297, 'video'), seconds: 6, pts: 6006 },
  { ...recipe('video-8s', 'video-packet-pts', 563, 317, 'video'), seconds: 8, pts: 8008 },
];

function generated({ id, width, height }: Recipe): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  let random = SEED;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const luma = (13 * x + 19 * y) & 255;
      let rgb: readonly [number, number, number];
      switch (id) {
        case 'fresh15-neutral':
          rgb = [luma, luma, luma];
          break;
        case 'fresh15-near-neutral': {
          const n = 10 + (luma % 237);
          rgb = [n + 3, n - 2, n + 1];
          break;
        }
        case 'fresh15-glyph':
          rgb = x % 67 < 5 || (y % 41 < 3 && x % 67 < 31) ? [225, 66, 123] : [36, 42, 51];
          break;
        case 'fresh15-diagonal':
          rgb = ((x * 11 + y * 9) >> 5) & 1 ? [202, 54, 151] : [46, 163, 214];
          break;
        case 'fresh15-dark':
          rgb = [8 + ((x + 2 * y) >> 6), 5 + ((x + 3 * y) >> 6), 4 + ((3 * x + y) >> 6)];
          break;
        case 'fresh15-saturated':
          rgb = x * 5 + y * 2 < width * 3 ? [17, 234, 40] : [242, 18, 189];
          break;
        case 'fresh15-noise':
          random ^= random << 13;
          random ^= random >>> 17;
          random ^= random << 5;
          rgb = [random & 255, (random >>> 8) & 255, (random >>> 16) & 255];
          break;
        case 'fresh15-curvature': {
          const arc = ((x - 131) ** 2 + 2 * (y - 197) ** 2) >> 8;
          rgb = [(arc + luma) & 255, (2 * arc + y) & 255, (arc + 3 * x) & 255];
          break;
        }
        case 'fresh15-tiny':
        case 'fresh15-odd':
          rgb = [(x * 61 + y * 43) & 255, (x * 29 + y * 79) & 255, (x * 53 + y * 11) & 255];
          break;
        case 'fresh15-wide':
          rgb = [(x >> 3) & 255, (x + y * 29) & 255, ((x * y) >> 7) & 255];
          break;
        case 'fresh15-large': {
          const n = ((x >> 3) + 3 * (y >> 3)) & 255;
          rgb = [n, (n + (x >> 5)) & 255, (n + (y >> 5)) & 255];
          break;
        }
        default:
          throw new Error(`Unknown V15 generated input: ${id}`);
      }
      pixels[offset] = rgb[0];
      pixels[offset + 1] = rgb[1];
      pixels[offset + 2] = rgb[2];
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

export function assertV15Shape(manifest: V15Manifest): void {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.cohort, 'corrected-v15');
  assert.equal(manifest.freezeId, FREEZE_ID);
  assert.equal(manifest.attemptBudget, 1);
  assert.deepEqual(manifest.thresholds, THRESHOLDS);
  assert.deepEqual(manifest.priorV13, PRIOR_V13);
  assert.deepEqual(manifest.priorV14, PRIOR_V14);
  assert.equal(manifest.sourceSelectionSha256, SOURCE_SELECTION_SHA);
  assert.equal(manifest.sourceMetadataSha256, SOURCE_METADATA_SHA);
  assert.deepEqual(manifest.sources, MEDIA);
  assert.equal(V15_HELDOUT.length, 20);
  assert.equal(manifest.fixtures.length, V15_HELDOUT.length);
  const ids = new Set<string>();
  for (const [index, spec] of V15_HELDOUT.entries()) {
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
  const readPin = <T>(pin: { path: string | null; sha256: string | null }): T => {
    assert.ok(pin.path && pin.sha256);
    const bytes = readFileSync(resolve(root, pin.path));
    assert.equal(digest(bytes), pin.sha256, `${pin.path} canonical prior manifest changed`);
    return JSON.parse(bytes.toString('utf8')) as T;
  };
  const v13 = readPin<V13Manifest>(PRIOR_V13);
  assert.equal(v13.status, 'EXPOSED_REGRESSION');
  assertV13PriorManifestRoles(v13);
  const v14 = readPin<V14Manifest>(PRIOR_V14);
  assertV14Shape(v14);
  const collectSources = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'sha256' || key === 'originalSha256') && typeof child === 'string')
        sources.add(child);
      else collectSources(child);
    }
  };
  for (const prior of [v14, v13, ...Object.values(v13.priorManifests).map(readPin<V13Manifest>)]) {
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
  manifest: V15Manifest
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
    ffmpegInput = ['-copyts', '-c:v', 'vp9', '-i', paths.video];
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
  for (let alpha = 3; alpha < pixels.length; alpha += 4)
    assert.equal(pixels[alpha], 255, `${item.id} decoded RGB track must be opaque`);
  return { ...item, stride, pixels };
}

function validateSourcePins(manifest: V15Manifest, paths: V15SourcePaths, root: string) {
  assertV15Shape(manifest);
  assert.equal(manifest.generatorSha256, digest(readFileSync(fileURLToPath(import.meta.url))));
  const prior = priorIdentities(root);
  const repo = realpathSync(root);
  const photo = paths.v15Photo;
  const video = paths.v15Video;
  assert.ok(photo && video, 'V15 needs --v15-photo and --v15-video private originals');
  const originals = { photo: realpathSync(photo), video: realpathSync(video) };
  assert.notEqual(manifest.sources.photo.sha256, manifest.sources.video.sha256);
  for (const [kind, path] of Object.entries(originals) as Array<['photo' | 'video', string]>) {
    const subpath = relative(repo, path);
    assert.ok(subpath.startsWith(`..${sep}`), `V15 ${kind} must be outside the harness checkout`);
    const pin = manifest.sources[kind];
    assert.ok(!prior.sources.has(pin.sha256), `V15 ${kind} reuses an exposed original`);
    const bytes = readFileSync(path);
    assert.equal(bytes.length, pin.bytes, `V15 ${kind} original byte length changed`);
    assert.equal(digest(bytes), pin.sha256, `V15 ${kind} original SHA-256 changed`);
  }
  const version = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0];
  assert.ok(version?.trim());
  assert.equal(version, manifest.ffmpegVersion, 'V15 FFmpeg version changed');
  return { prior, originals };
}

function collectFixtures(
  manifest: V15Manifest,
  paths: V15SourcePaths,
  root: string,
  verify: boolean
) {
  const { prior, originals } = validateSourcePins(manifest, paths, root);
  const result = new Map<string, { fixture: PixelFixture; sha256: string }>();
  for (const [index, spec] of V15_HELDOUT.entries()) {
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
export function preflightV15(
  manifest: V15Manifest,
  paths: V15SourcePaths,
  root: string,
  regression: boolean
) {
  assert.equal(
    manifest.status,
    regression ? 'EXPOSED_REGRESSION' : 'FROZEN_UNEXECUTED',
    'V15 draft or wrong-purpose cohort is not acceptance ready'
  );
  assert.ok(
    manifest.fixtures.every((row) => row.sha256 && SHA.test(row.sha256)),
    'V15 pixel pins are incomplete'
  );
  const rows = collectFixtures(manifest, paths, root, true);
  return new Map([...rows].map(([id, { fixture }]) => [id, fixture]));
}

/** Emit source-only pixel pins for review; this never promotes the draft. */
export function prepareV15Manifest(
  manifest: V15Manifest,
  paths: V15SourcePaths,
  root: string
): V15Manifest {
  assert.equal(manifest.status, 'PROSPECTIVE_UNFROZEN');
  assert.ok(
    manifest.fixtures.every((row) => row.sha256 === null),
    'V15 source-only draft is already populated'
  );
  const rows = collectFixtures(manifest, paths, root, false);
  return {
    ...manifest,
    fixtures: manifest.fixtures.map((row) => ({ ...row, sha256: rows.get(row.id)!.sha256 })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.equal(args.length, 4, 'Use --v15-photo ORIGINAL --v15-video ORIGINAL');
  assert.equal(args[0], '--v15-photo');
  assert.equal(args[2], '--v15-video');
  const root = resolve(import.meta.dirname, '../..');
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v15-fixtures.json'), 'utf8')
  ) as V15Manifest;
  const prepared = prepareV15Manifest(manifest, { v15Photo: args[1]!, v15Video: args[3]! }, root);
  process.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`);
}
