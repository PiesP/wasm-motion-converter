/** Prospective V17 source recipes. This module has no candidate or comparator dependency. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QUALITIES, type FixtureSpec, type PixelFixture } from './owned-vp8-v2-fixtures.ts';
import { assertV13PriorManifestRoles, type V13Manifest } from './owned-vp8-v13-fixtures.ts';
import { assertV14Shape, type V14Manifest } from './owned-vp8-v14-fixtures.ts';
import { assertV15Shape, type V15Manifest } from './owned-vp8-v15-fixtures.ts';
import { assertV16Shape, type V16Manifest } from './owned-vp8-v16-fixtures.ts';

export type V17SourcePaths = { v17Photo?: string; v17Video?: string };
type Region = readonly [x: number, y: number, width: number, height: number];
type Recipe = FixtureSpec & { region?: Region; minimumMs?: number };
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
  publisherSha1: string;
};
export type V17Manifest = {
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
  priorV15: { path: string; sha256: string };
  priorV16: { path: string; sha256: string };
  fixtures: Array<
    Recipe & { stride: number; qualities: number[]; sha256: string | null; pts?: number }
  >;
};

const FREEZE_ID = 'vp8-v17-first-heldout-20261120-01';
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
const PRIOR_V15 = {
  path: 'docs/experiments/501-owned-vp8-v15-fixtures.json',
  sha256: '2025389427eaac1f938b827410156f89149df91556141b97a7bcd2cee4a55d05',
};
const PRIOR_V16 = {
  path: 'docs/experiments/501-owned-vp8-v16-fixtures.json',
  sha256: 'a3760f36a26c821677becdddb87732f04a77327dfe445072ddc046e4d101a2be',
};
const SOURCE_SELECTION_SHA = '7e0b86cb0c88237c3b40d0457fb42587ec2b2d7d895e4d9aec07a8b5dc444e82';
const SOURCE_METADATA_SHA = 'cebf3a3b3f4898419472b396633a3c94a684beba1f00ce600066d4fb79b3cce7';
const VIDEO_PTS: readonly number[] = [1709, 5679, 9717, 14455];
const MEDIA = {
  photo: {
    page: 'https://commons.wikimedia.org/wiki/File:National_Gallery_at_dusk,_Canberra_ACT.jpg',
    revision:
      'https://commons.wikimedia.org/w/index.php?title=File:National_Gallery_at_dusk,_Canberra_ACT.jpg&oldid=1100210507',
    download:
      'https://upload.wikimedia.org/wikipedia/commons/f/f3/National_Gallery_at_dusk%2C_Canberra_ACT.jpg',
    author: 'Thennicke',
    license: 'CC-BY-SA-4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    width: 5419,
    height: 3048,
    bytes: 7235369,
    publisherSha1: '39e94e8aca404feacae596d2bfc252ee7f7dbe44',
    sha256: '0f3b60394d4dc07850692ec95741704b53494981ec7b5d3737721412917bcb0b',
  },
  video: {
    page: 'https://commons.wikimedia.org/wiki/File:Wasserstufen.webm',
    revision:
      'https://commons.wikimedia.org/w/index.php?title=File:Wasserstufen.webm&oldid=1034149324',
    download: 'https://upload.wikimedia.org/wikipedia/commons/e/e5/Wasserstufen.webm',
    author: 'Xocolatl',
    license: 'CC-BY-SA-4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    width: 1920,
    height: 1080,
    bytes: 22782712,
    publisherSha1: 'f7d7adf6d7eb11c11fc6e1ecd22411d71eacb565',
    sha256: '514a600752de6ec6d64da5cda022548d1d7590788e3eaa629c60a18b7a631891',
    streamIndex: 0,
    timeBase: '1/1000',
  },
};
const SEED = 0x501e1701;
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
    id: `fresh17-${name}`,
    split: 'held-out',
    class: kind,
    width,
    height,
    layout: 'RGBA',
    source,
  };
}

export const V17_HELDOUT: readonly Recipe[] = [
  recipe('neutral', 'neutral', 517, 359),
  recipe('near-neutral', 'near-neutral', 443, 337),
  recipe('glyph', 'glyph-edge', 491, 327),
  recipe('diagonal', 'diagonal-chroma', 427, 299),
  recipe('dark', 'dark-gradient', 367, 271),
  recipe('saturated', 'saturated-boundary', 409, 313),
  recipe('noise', 'deterministic-noise', 321, 263),
  recipe('curvature', 'mixed-curvature', 453, 319),
  recipe('tiny', 'tiny', 7, 11),
  recipe('odd', 'odd', 23, 19),
  recipe('wide', 'wide-shallow', 2377, 43),
  recipe('large', 'large-admitted', 3247, 2011),
  { ...recipe('photo-upper', 'photograph-crop', 517, 287, 'photo'), region: [195, 143, 1643, 911] },
  { ...recipe('photo-mid', 'photograph-crop', 563, 337, 'photo'), region: [1731, 829, 1829, 1093] },
  {
    ...recipe('photo-lower', 'photograph-crop', 461, 357, 'photo'),
    region: [717, 1923, 1273, 987],
  },
  {
    ...recipe('photo-right', 'photograph-crop', 587, 419, 'photo'),
    region: [3511, 1183, 1567, 1117],
  },
  { ...recipe('video-1680ms', 'video-packet-pts', 617, 347, 'video'), minimumMs: 1680 },
  { ...recipe('video-5675ms', 'video-packet-pts', 557, 313, 'video'), minimumMs: 5675 },
  { ...recipe('video-9710ms', 'video-packet-pts', 473, 267, 'video'), minimumMs: 9710 },
  { ...recipe('video-14430ms', 'video-packet-pts', 683, 385, 'video'), minimumMs: 14430 },
];

export function draftV17Manifest(): V17Manifest {
  let videoIndex = 0;
  return {
    schemaVersion: 1,
    cohort: 'corrected-v17',
    status: 'PROSPECTIVE_UNFROZEN',
    freezeId: FREEZE_ID,
    attemptBudget: 1,
    thresholds: THRESHOLDS,
    generatorSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
    ffmpegVersion: 'ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers',
    sourceSelectionSha256: SOURCE_SELECTION_SHA,
    sourceMetadataSha256: SOURCE_METADATA_SHA,
    sources: MEDIA,
    priorV13: PRIOR_V13,
    priorV14: PRIOR_V14,
    priorV15: PRIOR_V15,
    priorV16: PRIOR_V16,
    fixtures: V17_HELDOUT.map((row) => ({
      ...row,
      stride: row.width * 4,
      qualities: [...QUALITIES],
      ...(row.source === 'video' ? { pts: VIDEO_PTS[videoIndex++]! } : {}),
      sha256: null,
    })),
  };
}

function generated({ id, width, height }: Recipe): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  let random = SEED;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      let rgb: readonly [number, number, number];
      switch (id) {
        case 'fresh17-neutral': {
          const n = (3 * x + 5 * y + ((x * y) >> 10) + 7 * (x >> 6)) & 255;
          rgb = [n, n, n];
          break;
        }
        case 'fresh17-near-neutral': {
          const t = (3 * x + 2 * y + ((x * y) >> 10)) % 360;
          const n = 24 + Math.min(t, 360 - t);
          rgb = [n - 1, n + ((y >> 4) & 1), n + 1];
          break;
        }
        case 'fresh17-glyph': {
          const u = (x + 7 * (y >> 5)) % 47;
          const v = y % 33;
          const stroke =
            (u < 3 && v < 27) ||
            (v < 3 && u < 25) ||
            (v > 13 && v < 17 && u < 19) ||
            (u > v - 9 && u < v - 6 && v > 17);
          const bevel = !stroke && u < 5 && v < 27;
          rgb = stroke ? [197, 49, 91] : bevel ? [153, 126, 112] : [208, 225, 213];
          break;
        }
        case 'fresh17-diagonal':
          rgb = ((13 * x + 9 * y) >> 4) % 8 < 3 ? [160, 61, 173] : [58, 200, 137];
          break;
        case 'fresh17-dark': {
          const n = 8 + ((x * x + 3 * y * y + 4 * x * y) >> 14);
          rgb = [n + ((2 * x + y) >> 8), n, n + ((x + 2 * y) >> 8)];
          break;
        }
        case 'fresh17-saturated':
          rgb = 4 * x < width + (((y - 141) ** 2) >> 5) ? [216, 92, 14] : [12, 192, 212];
          break;
        case 'fresh17-noise':
          random ^= random << 13;
          random ^= random >>> 17;
          random ^= random << 5;
          rgb = [
            (random + (x >> 4)) & 255,
            (random >>> 8) & 255,
            ((random >>> 16) + (y >> 4)) & 255,
          ];
          break;
        case 'fresh17-curvature': {
          const n = 16 + ((x * (height - y) + y * (width - x)) >> 10);
          const ring = ((x - 291) ** 2 + (y - 129) ** 2) >> 6;
          rgb =
            3 * x + y < 786
              ? [n + 5, n, n + 2]
              : [(x + ring) & 255, (y + 2 * ring) & 255, (3 * x + ring) & 255];
          break;
        }
        case 'fresh17-tiny':
        case 'fresh17-odd':
          rgb = [(21 * x + 73 * y) & 255, (7 * x + 97 * y) & 255, (83 * x + 13 * y) & 255];
          break;
        case 'fresh17-wide':
          rgb = [((x >> 3) + y) & 255, (x + 17 * y) & 255, ((x * y) >> 5) & 255];
          break;
        case 'fresh17-large': {
          const n = 31 + (((x >> 3) + 3 * (y >> 4)) % 112);
          rgb = [n + ((x >> 6) % 19), n + ((y >> 5) % 7), n + ((y >> 7) % 23)];
          break;
        }
        default:
          throw new Error(`Unknown V17 generated input: ${id}`);
      }
      pixels[offset] = rgb[0];
      pixels[offset + 1] = rgb[1];
      pixels[offset + 2] = rgb[2];
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

export function assertV17Shape(manifest: V17Manifest): void {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.cohort, 'corrected-v17');
  assert.equal(manifest.freezeId, FREEZE_ID);
  assert.equal(manifest.attemptBudget, 1);
  assert.deepEqual(manifest.thresholds, THRESHOLDS);
  assert.deepEqual(manifest.priorV13, PRIOR_V13);
  assert.deepEqual(manifest.priorV14, PRIOR_V14);
  assert.deepEqual(manifest.priorV15, PRIOR_V15);
  assert.deepEqual(manifest.priorV16, PRIOR_V16);
  assert.equal(manifest.sourceSelectionSha256, SOURCE_SELECTION_SHA);
  assert.equal(manifest.sourceMetadataSha256, SOURCE_METADATA_SHA);
  assert.deepEqual(manifest.sources, MEDIA);
  assert.equal(V17_HELDOUT.length, 20);
  assert.equal(manifest.fixtures.length, V17_HELDOUT.length);
  const ids = new Set<string>();
  let videoIndex = 0;
  for (const [index, spec] of V17_HELDOUT.entries()) {
    const { sha256, pts, ...row } = manifest.fixtures[index]!;
    assert.deepEqual(row, { ...spec, stride: spec.width * 4, qualities: [...QUALITIES] });
    assert.equal(pts, spec.source === 'video' ? VIDEO_PTS[videoIndex++] : undefined);
    if (spec.source === 'video') assert.ok(Number.isSafeInteger(pts));
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
  const v15 = readPin<V15Manifest>(PRIOR_V15);
  assert.equal(v15.status, 'FROZEN_UNEXECUTED');
  assertV15Shape(v15);
  const v16 = readPin<V16Manifest>(PRIOR_V16);
  assert.equal(v16.status, 'FROZEN_UNEXECUTED');
  assertV16Shape(v16);
  const collectSources = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'sha256' || key === 'originalSha256') && typeof child === 'string')
        sources.add(child);
      else collectSources(child);
    }
  };
  for (const prior of [
    v16,
    v15,
    v14,
    v13,
    ...Object.values(v13.priorManifests).map(readPin<V13Manifest>),
  ]) {
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
  manifest: V17Manifest,
  pts: number | undefined
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
    assert.ok(Number.isSafeInteger(pts), `${item.id} requires an exact video packet PTS`);
    const { streamIndex, timeBase } = manifest.sources.video;
    ffmpegInput = ['-copyts', '-c:v', 'vp9', '-i', paths.video];
    stream = `0:${streamIndex}`;
    filter = `settb=expr=${timeBase},select=eq(pts\\,${pts}),${scale}`;
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

function validateSourcePins(manifest: V17Manifest, paths: V17SourcePaths, root: string) {
  assertV17Shape(manifest);
  assert.equal(manifest.generatorSha256, digest(readFileSync(fileURLToPath(import.meta.url))));
  const prior = priorIdentities(root);
  const repo = realpathSync(root);
  const photo = paths.v17Photo;
  const video = paths.v17Video;
  assert.ok(photo && video, 'V17 needs --v17-photo and --v17-video private originals');
  const originals = { photo: realpathSync(photo), video: realpathSync(video) };
  assert.notEqual(manifest.sources.photo.sha256, manifest.sources.video.sha256);
  for (const [kind, path] of Object.entries(originals) as Array<['photo' | 'video', string]>) {
    const subpath = relative(repo, path);
    assert.ok(subpath.startsWith(`..${sep}`), `V17 ${kind} must be outside the harness checkout`);
    const pin = manifest.sources[kind];
    assert.ok(!prior.sources.has(pin.sha256), `V17 ${kind} reuses an exposed original`);
    const bytes = readFileSync(path);
    assert.equal(bytes.length, pin.bytes, `V17 ${kind} original byte length changed`);
    assert.equal(createHash('sha1').update(bytes).digest('hex'), pin.publisherSha1);
    assert.equal(digest(bytes), pin.sha256, `V17 ${kind} original SHA-256 changed`);
  }
  const version = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0];
  assert.ok(version?.trim());
  assert.equal(version, manifest.ffmpegVersion, 'V17 FFmpeg version changed');
  return { prior, originals };
}

function collectFixtures(
  manifest: V17Manifest,
  paths: V17SourcePaths,
  root: string,
  verify: boolean
) {
  const { prior, originals } = validateSourcePins(manifest, paths, root);
  const result = new Map<string, { fixture: PixelFixture; sha256: string }>();
  for (const [index, spec] of V17_HELDOUT.entries()) {
    assert.ok(!prior.ids.has(spec.id), `${spec.id} reuses an exposed ID`);
    const fixture = generateFixture(spec, originals, manifest, manifest.fixtures[index]!.pts);
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
export function preflightV17(manifest: V17Manifest, paths: V17SourcePaths, root: string) {
  assert.equal(manifest.status, 'FROZEN_UNEXECUTED', 'V17 draft is not acceptance ready');
  assert.ok(
    manifest.fixtures.every((row) => row.sha256 && SHA.test(row.sha256)),
    'V17 pixel pins are incomplete'
  );
  const rows = collectFixtures(manifest, paths, root, true);
  return new Map([...rows].map(([id, { fixture }]) => [id, fixture]));
}

/** Emit source-only pixel pins for review; this never promotes the draft. */
export function prepareV17Manifest(
  manifest: V17Manifest,
  paths: V17SourcePaths,
  root: string
): V17Manifest {
  assert.equal(manifest.status, 'PROSPECTIVE_UNFROZEN');
  assert.ok(
    manifest.fixtures.every((row) => row.sha256 === null),
    'V17 source-only draft is already populated'
  );
  const rows = collectFixtures(manifest, paths, root, false);
  return {
    ...manifest,
    fixtures: manifest.fixtures.map((row) => ({ ...row, sha256: rows.get(row.id)!.sha256 })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.equal(args.length, 4, 'Use --v17-photo ORIGINAL --v17-video ORIGINAL');
  assert.equal(args[0], '--v17-photo');
  assert.equal(args[2], '--v17-video');
  const root = resolve(import.meta.dirname, '../..');
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v17-fixtures.json'), 'utf8')
  ) as V17Manifest;
  const prepared = prepareV17Manifest(manifest, { v17Photo: args[1]!, v17Video: args[3]! }, root);
  process.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`);
}
