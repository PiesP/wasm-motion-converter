/** Prospective V18 source recipes. This module has no candidate or comparator dependency. */
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
import { assertV17Shape, type V17Manifest } from './owned-vp8-v17-fixtures.ts';

export type V18SourcePaths = { v18Photo?: string; v18Video?: string };
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
export type V18Manifest = {
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
  priorV17: { path: string; sha256: string };
  fixtures: Array<
    Recipe & { stride: number; qualities: number[]; sha256: string | null; pts?: number }
  >;
};

const FREEZE_ID = 'vp8-v18-first-heldout-20261121-01';
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
const PRIOR_V17 = {
  path: 'docs/experiments/501-owned-vp8-v17-fixtures.json',
  sha256: 'f8bff775eb17f720b8284b669526799b09c6d5c596b330861d72e684cbb5ed56',
};
const SOURCE_SELECTION_SHA = '51266f44e6c0cab308d358f787f517163bdfa6eb93233ab07335801a04c54488';
const SOURCE_METADATA_SHA = 'a9c3268f63ecf1a6f6c5d977e7d65d2f3909dd4028bc2542ec0bc7b9e8ff56af';
const VIDEO_PTS: readonly number[] = [2302, 8842, 17417, 26760];
const MEDIA = {
  photo: {
    page: 'https://commons.wikimedia.org/wiki/File:Wallowa_Mountains.jpg',
    revision:
      'https://commons.wikimedia.org/w/index.php?title=File:Wallowa_Mountains.jpg&oldid=1254755557',
    download: 'https://upload.wikimedia.org/wikipedia/commons/5/55/Wallowa_Mountains.jpg',
    author: 'Marc Shandro',
    license: 'CC-BY-2.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/2.0/',
    width: 3008,
    height: 2000,
    bytes: 1566343,
    publisherSha1: 'ac1461ba768f03db1f9a24653bb92c53c4755ebc',
    sha256: '30cee00fb1d7ae9cb915d755d73a37a64c95734886973991647fe71457f9c305',
  },
  video: {
    page: 'https://commons.wikimedia.org/wiki/File:Future_USS_Omaha_(LCS_12)_Transits_the_Panama_Canal_(105250195).webm',
    revision:
      'https://commons.wikimedia.org/w/index.php?title=File:Future_USS_Omaha_(LCS_12)_Transits_the_Panama_Canal_(105250195).webm&oldid=1010574993',
    download:
      'https://upload.wikimedia.org/wikipedia/commons/9/94/Future_USS_Omaha_%28LCS_12%29_Transits_the_Panama_Canal_%28105250195%29.webm',
    author: 'Lt. Chris Krokus, U.S. Navy',
    license: 'Public-Domain-US',
    licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
    width: 640,
    height: 480,
    bytes: 5838561,
    publisherSha1: '2166fd2c324da394e14a277c40763731a9a73a4f',
    sha256: '51294e9655615409442ceb01a14627b5bc36b019ada9235a13a5bc456136f22b',
    streamIndex: 0,
    timeBase: '1/1000',
  },
};
const SEED = 0x5024185b;
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
    id: `fresh18-${name}`,
    split: 'held-out',
    class: kind,
    width,
    height,
    layout: 'RGBA',
    source,
  };
}

export const V18_HELDOUT: readonly Recipe[] = [
  recipe('folded-light', 'neutral', 521, 373),
  recipe('luminance-stair', 'near-neutral', 457, 341),
  recipe('type-marks', 'glyph-edge', 479, 329),
  recipe('oblique-pairs', 'diagonal-chroma', 419, 307),
  recipe('dark-sine', 'dark-gradient', 379, 283),
  recipe('fan-boundary', 'saturated-boundary', 421, 317),
  recipe('grouped-grain', 'deterministic-noise', 337, 257),
  recipe('cells', 'mixed-curvature', 463, 323),
  recipe('tiny-cross', 'tiny', 9, 13),
  recipe('odd-rim', 'odd', 29, 21),
  recipe('wide-bars', 'wide-shallow', 2441, 47),
  recipe('large-mesh', 'large-admitted', 3179, 1957),
  { ...recipe('photo-nw', 'photograph-crop', 541, 353, 'photo'), region: [65, 103, 1321, 849] },
  { ...recipe('photo-ne', 'photograph-crop', 591, 383, 'photo'), region: [1531, 117, 1367, 889] },
  { ...recipe('photo-sw', 'photograph-crop', 499, 327, 'photo'), region: [81, 1029, 1397, 903] },
  { ...recipe('photo-se', 'photograph-crop', 559, 349, 'photo'), region: [1613, 1097, 1293, 811] },
  { ...recipe('video-a', 'video-packet-pts', 503, 377, 'video'), minimumMs: 2271 },
  { ...recipe('video-b', 'video-packet-pts', 597, 449, 'video'), minimumMs: 8817 },
  { ...recipe('video-c', 'video-packet-pts', 545, 409, 'video'), minimumMs: 17389 },
  { ...recipe('video-d', 'video-packet-pts', 629, 471, 'video'), minimumMs: 26749 },
];

export function draftV18Manifest(): V18Manifest {
  let videoIndex = 0;
  return {
    schemaVersion: 1,
    cohort: 'corrected-v18',
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
    priorV17: PRIOR_V17,
    fixtures: V18_HELDOUT.map((row) => ({
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
        case 'fresh18-folded-light': {
          const n =
            90 + Math.round(51 * Math.sin((x + y) / 75) + 38 * Math.cos((2 * x - 3 * y) / 131));
          rgb = [n, n, n];
          break;
        }
        case 'fresh18-luminance-stair': {
          const n =
            36 + Math.floor((x + 3 * y) / 81) * 7 + Math.round(24 * Math.cos(x / 41 + y / 73));
          const d = (x >= width / 2 ? 2 : 1) * (y >= height / 2 ? 1 : -1);
          rgb = [n + d, n, n - d];
          break;
        }
        case 'fresh18-type-marks': {
          const u = (x + (y >> 5) * 13) % 59;
          const v = y % 39;
          const on =
            (u > 8 && u < 11 && v > 4 && v < 32) ||
            (u >= 10 && u < 49 && v > 25 && v < 29) ||
            Math.abs((u - 30) ** 2 + 2 * (v - 17) ** 2 - 85) <= 18;
          rgb = on ? [48, 60, 168] : u % 19 === 0 ? [188, 151, 67] : [217, 212, 200];
          break;
        }
        case 'fresh18-oblique-pairs': {
          const s = (7 * x - 11 * y + 34 * (x >> 6) + 4096) & 127;
          const n = 99 + (s & 3) * 2;
          rgb = s < 43 ? [n + 75, n - 31, n - 52] : [n - 51, n + 26, n + 75];
          break;
        }
        case 'fresh18-dark-sine': {
          const n = 22 + Math.round(9 * Math.sin(x / 92 + y / 81) + 7 * Math.cos(y / 114 - x / 63));
          const c = Math.round(2 * Math.sin((x - y) / 109));
          rgb = [n + c, n, n - c];
          break;
        }
        case 'fresh18-fan-boundary': {
          const mask = (x * 13 + y * 3 > width * 8 ? 1 : 0) + (y * 9 - x * 4 > height * 2 ? 2 : 0);
          rgb = mask === 0 ? [219, 58, 28] : mask === 1 ? [21, 179, 223] : [123, 196, 24];
          break;
        }
        case 'fresh18-grouped-grain': {
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          const d = (random >>> 27) - 16;
          const n = ((31 * (x >> 3) + 7 * (y >> 4)) & 127) + 60;
          rgb = [n + d, n + ((random >>> 21) & 31) - 16, n - d];
          break;
        }
        case 'fresh18-cells': {
          const u = (x % 87) - 43;
          const v = (y % 69) - 34;
          const n = 45 + Math.floor((x * 61 + y * 43) / width);
          const texture = (x * 11 + y * 19) & 95;
          rgb =
            2 * Math.max(Math.abs(u), Math.abs(v)) + Math.min(Math.abs(u), Math.abs(v)) < 75
              ? [n + 3, n, n + 5]
              : [61 + texture, 165 - texture, 111 + ((texture * 3) & 111)];
          break;
        }
        case 'fresh18-tiny-cross':
          rgb = [
            (17 * (x + 13) + 53 * y) & 255,
            (x * y * 7 + y * 19) & 255,
            (19 * x + 31 * y) & 255,
          ];
          break;
        case 'fresh18-odd-rim': {
          const n = 75 + 3 * (x + y);
          rgb = x === width - 1 || y === height - 1 ? [21, 221, 177] : [n + 11, n, n - 9];
          break;
        }
        case 'fresh18-wide-bars': {
          const n = 40 + ((x % 223) >> 1) + 2 * y;
          const bar = (x + 7 * y) % 251 < 15;
          rgb = [n + (bar ? 29 : 3), n, n - (bar ? 35 : 5)];
          break;
        }
        case 'fresh18-large-mesh': {
          const n = 44 + ((x >> 4) % 62) + ((y >> 5) % 49);
          const d = ((x * 3 + y * 7) >> 8) % 5 === 0 ? 13 : 2;
          rgb = [n + d, n + ((y >> 4) & 3), n - d];
          break;
        }
        default:
          throw new Error(`Unknown V18 generated input: ${id}`);
      }
      for (const [channel, value] of rgb.entries())
        pixels[offset + channel] = Math.max(0, Math.min(255, value));
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

export function assertV18Shape(manifest: V18Manifest): void {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.cohort, 'corrected-v18');
  assert.equal(manifest.freezeId, FREEZE_ID);
  assert.equal(manifest.attemptBudget, 1);
  assert.deepEqual(manifest.thresholds, THRESHOLDS);
  assert.deepEqual(manifest.priorV13, PRIOR_V13);
  assert.deepEqual(manifest.priorV14, PRIOR_V14);
  assert.deepEqual(manifest.priorV15, PRIOR_V15);
  assert.deepEqual(manifest.priorV16, PRIOR_V16);
  assert.deepEqual(manifest.priorV17, PRIOR_V17);
  assert.equal(manifest.sourceSelectionSha256, SOURCE_SELECTION_SHA);
  assert.equal(manifest.sourceMetadataSha256, SOURCE_METADATA_SHA);
  assert.deepEqual(manifest.sources, MEDIA);
  assert.equal(V18_HELDOUT.length, 20);
  assert.equal(manifest.fixtures.length, V18_HELDOUT.length);
  const ids = new Set<string>();
  let videoIndex = 0;
  for (const [index, spec] of V18_HELDOUT.entries()) {
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
  const v17 = readPin<V17Manifest>(PRIOR_V17);
  assert.equal(v17.status, 'FROZEN_UNEXECUTED');
  assertV17Shape(v17);
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
    v17,
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
  manifest: V18Manifest,
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
    ffmpegInput = ['-copyts', '-c:v', 'vp8', '-i', paths.video];
    stream = `0:${streamIndex}`;
    filter = `settb=expr=${timeBase},select=eq(pts\\,${pts}),${scale}`;
  }
  const pixels = execFileSync(
    '/usr/bin/ffmpeg',
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

function validateSourcePins(manifest: V18Manifest, paths: V18SourcePaths, root: string) {
  assertV18Shape(manifest);
  assert.equal(manifest.generatorSha256, digest(readFileSync(fileURLToPath(import.meta.url))));
  const prior = priorIdentities(root);
  const repo = realpathSync(root);
  const photo = paths.v18Photo;
  const video = paths.v18Video;
  assert.ok(photo && video, 'V18 needs --v18-photo and --v18-video private originals');
  const originals = { photo: realpathSync(photo), video: realpathSync(video) };
  assert.notEqual(manifest.sources.photo.sha256, manifest.sources.video.sha256);
  for (const [kind, path] of Object.entries(originals) as Array<['photo' | 'video', string]>) {
    const subpath = relative(repo, path);
    assert.ok(subpath.startsWith(`..${sep}`), `V18 ${kind} must be outside the harness checkout`);
    const pin = manifest.sources[kind];
    assert.ok(!prior.sources.has(pin.sha256), `V18 ${kind} reuses an exposed original`);
    const bytes = readFileSync(path);
    assert.equal(bytes.length, pin.bytes, `V18 ${kind} original byte length changed`);
    assert.equal(createHash('sha1').update(bytes).digest('hex'), pin.publisherSha1);
    assert.equal(digest(bytes), pin.sha256, `V18 ${kind} original SHA-256 changed`);
  }
  const version = execFileSync('/usr/bin/ffmpeg', ['-version'], { encoding: 'utf8' }).split(
    '\n'
  )[0];
  assert.ok(version?.trim());
  assert.equal(version, manifest.ffmpegVersion, 'V18 FFmpeg version changed');
  return { prior, originals };
}

function collectFixtures(
  manifest: V18Manifest,
  paths: V18SourcePaths,
  root: string,
  verify: boolean
) {
  const { prior, originals } = validateSourcePins(manifest, paths, root);
  const result = new Map<string, { fixture: PixelFixture; sha256: string }>();
  for (const [index, spec] of V18_HELDOUT.entries()) {
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
export function preflightV18(manifest: V18Manifest, paths: V18SourcePaths, root: string) {
  assert.equal(manifest.status, 'FROZEN_UNEXECUTED', 'V18 draft is not acceptance ready');
  assert.ok(
    manifest.fixtures.every((row) => row.sha256 && SHA.test(row.sha256)),
    'V18 pixel pins are incomplete'
  );
  const rows = collectFixtures(manifest, paths, root, true);
  return new Map([...rows].map(([id, { fixture }]) => [id, fixture]));
}

/** Emit source-only pixel pins for review; this never promotes the draft. */
export function prepareV18Manifest(
  manifest: V18Manifest,
  paths: V18SourcePaths,
  root: string
): V18Manifest {
  assert.equal(manifest.status, 'PROSPECTIVE_UNFROZEN');
  assert.ok(
    manifest.fixtures.every((row) => row.sha256 === null),
    'V18 source-only draft is already populated'
  );
  const rows = collectFixtures(manifest, paths, root, false);
  return {
    ...manifest,
    fixtures: manifest.fixtures.map((row) => ({ ...row, sha256: rows.get(row.id)!.sha256 })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.equal(args.length, 4, 'Use --v18-photo ORIGINAL --v18-video ORIGINAL');
  assert.equal(args[0], '--v18-photo');
  assert.equal(args[2], '--v18-video');
  const root = resolve(import.meta.dirname, '../..');
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v18-fixtures.json'), 'utf8')
  ) as V18Manifest;
  const prepared = prepareV18Manifest(manifest, { v18Photo: args[1]!, v18Video: args[3]! }, root);
  process.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`);
}
