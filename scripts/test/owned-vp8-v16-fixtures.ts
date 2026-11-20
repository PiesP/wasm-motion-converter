/** Prospective V16 source recipes. This module has no candidate or comparator dependency. */
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

export type V16SourcePaths = { v16Photo?: string; v16Video?: string };
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
export type V16Manifest = {
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
  fixtures: Array<
    Recipe & { stride: number; qualities: number[]; sha256: string | null; pts?: number }
  >;
};

const FREEZE_ID = 'vp8-v16-first-heldout-20261120-01';
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
const SOURCE_SELECTION_SHA = '9c2f31d078338fce680f05097a812a9116b16172a2105e0c28c16c6178ba8b28';
const SOURCE_METADATA_SHA = '25f9ecdc2a4a066f200692bcd5a5dfbf63d044485a4c76b5f6366de00b9a8a76';
const VIDEO_PTS: readonly number[] = [1407, 4774, 7907, 11140];
const MEDIA = {
  photo: {
    page: 'https://commons.wikimedia.org/wiki/File:Grand_Central_Station_Main_Concourse_Rectilinear_projection_Jan_2006.jpg',
    revision:
      'https://commons.wikimedia.org/w/index.php?title=File:Grand_Central_Station_Main_Concourse_Rectilinear_projection_Jan_2006.jpg&oldid=927156370',
    download:
      'https://upload.wikimedia.org/wikipedia/commons/9/95/Grand_Central_Station_Main_Concourse_Rectilinear_projection_Jan_2006.jpg',
    author: 'David Iliff (Diliff)',
    license: 'CC-BY-SA-3.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
    width: 2500,
    height: 1287,
    bytes: 1182771,
    publisherSha1: '2ad5e091d4968ea6cc3655079ded94b546322076',
    sha256: 'cc449f71424d673078394299ea0660b175f05ded1ff8c75dfa81f1cb73113b72',
  },
  video: {
    page: 'https://commons.wikimedia.org/wiki/File:Escalator_S%C3%B6dra_station_2019.webm',
    revision:
      'https://commons.wikimedia.org/w/index.php?title=File:Escalator_S%C3%B6dra_station_2019.webm&oldid=813105970',
    download:
      'https://upload.wikimedia.org/wikipedia/commons/4/44/Escalator_S%C3%B6dra_station_2019.webm',
    author: 'Jan Ainali',
    license: 'CC-BY-SA-4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    width: 2560,
    height: 1440,
    bytes: 18092630,
    publisherSha1: 'e6e9ba4c86a375bf5c7d728b7e2ea8857f09fa09',
    sha256: '067d8ecce314927dc8a3e237d0d65ca1b7c048d71533c51e879eced9ce2032e6',
    streamIndex: 0,
    timeBase: '1/1000',
  },
};
const SEED = 0x501e1601;
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
    id: `fresh16-${name}`,
    split: 'held-out',
    class: kind,
    width,
    height,
    layout: 'RGBA',
    source,
  };
}

export const V16_HELDOUT: readonly Recipe[] = [
  recipe('neutral', 'neutral', 503, 373),
  recipe('near-neutral', 'near-neutral', 461, 301),
  recipe('glyph', 'glyph-edge', 487, 321),
  recipe('diagonal', 'diagonal-chroma', 413, 317),
  recipe('dark', 'dark-gradient', 353, 283),
  recipe('saturated', 'saturated-boundary', 421, 287),
  recipe('noise', 'deterministic-noise', 307, 251),
  recipe('curvature', 'mixed-curvature', 469, 307),
  recipe('tiny', 'tiny', 13, 1),
  recipe('odd', 'odd', 9, 15),
  recipe('wide', 'wide-shallow', 2411, 31),
  recipe('large', 'large-admitted', 3269, 2053),
  { ...recipe('photo-nw', 'photograph-crop', 503, 339, 'photo'), region: [137, 93, 603, 407] },
  { ...recipe('photo-ne', 'photograph-crop', 553, 391, 'photo'), region: [1391, 81, 677, 479] },
  { ...recipe('photo-sw', 'photograph-crop', 449, 311, 'photo'), region: [267, 753, 519, 359] },
  { ...recipe('photo-se', 'photograph-crop', 607, 365, 'photo'), region: [1541, 741, 729, 437] },
  { ...recipe('video-1375ms', 'video-packet-pts', 601, 337, 'video'), minimumMs: 1375 },
  { ...recipe('video-4750ms', 'video-packet-pts', 539, 303, 'video'), minimumMs: 4750 },
  { ...recipe('video-7875ms', 'video-packet-pts', 449, 253, 'video'), minimumMs: 7875 },
  { ...recipe('video-11125ms', 'video-packet-pts', 719, 405, 'video'), minimumMs: 11125 },
];

export function draftV16Manifest(): V16Manifest {
  let videoIndex = 0;
  return {
    schemaVersion: 1,
    cohort: 'corrected-v16',
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
    fixtures: V16_HELDOUT.map((row) => ({
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
        case 'fresh16-neutral': {
          const n = (9 * x + 23 * y + ((x * y) >> 7)) & 255;
          rgb = [n, n, n];
          break;
        }
        case 'fresh16-near-neutral': {
          const n = 16 + ((x + 3 * y + ((x * y) >> 9)) % 224);
          rgb = [n + ((x >> 5) & 1), n, n - 2];
          break;
        }
        case 'fresh16-glyph': {
          const u = (x + 9 * ((y >> 5) & 1)) % 61;
          const v = y % 37;
          const stroke =
            ((u < 4 || (u > 26 && u < 30)) && v < 33) ||
            (v < 3 && u < 30) ||
            (v >= 15 && v < 18 && u < 28);
          rgb = stroke ? [19, 140, 183] : [208, 218, 195];
          break;
        }
        case 'fresh16-diagonal':
          rgb = ((7 * x - 11 * y) >> 4) & 1 ? [173, 51, 129] : [33, 167, 205];
          break;
        case 'fresh16-dark': {
          const n = 6 + ((2 * x + y) >> 6) + ((x * y) >> 15);
          rgb = [n + ((x + 2 * y) >> 8), n, n + (y >> 7)];
          break;
        }
        case 'fresh16-saturated':
          rgb = 4 * x - 3 * y < width ? [201, 29, 209] : [40, 223, 27];
          break;
        case 'fresh16-noise':
          random ^= random << 13;
          random ^= random >>> 17;
          random ^= random << 5;
          rgb = [random & 255, (random >>> 8) & 255, (random >>> 16) & 255];
          break;
        case 'fresh16-curvature': {
          const n = (x + 2 * y) >> 3;
          const arc = ((x - 321) ** 2 + 2 * (y - 139) ** 2) >> 8;
          rgb =
            x < width / 2
              ? [n, n + 3, n + 7]
              : [(x + y + arc) & 255, (x + 2 * arc) & 255, (3 * y + arc) & 255];
          break;
        }
        case 'fresh16-tiny':
        case 'fresh16-odd':
          rgb = [(37 * x + 61 * y) & 255, (19 * x + 113 * y) & 255, (71 * x + 17 * y) & 255];
          break;
        case 'fresh16-wide':
          rgb = [(x >> 4) & 255, (x + 23 * y) & 255, ((x * y) >> 6) & 255];
          break;
        case 'fresh16-large': {
          const n = 27 + (((x >> 4) + 2 * (y >> 4)) % 100);
          rgb = [n + ((x >> 7) % 31), n, n + ((y >> 6) % 29)];
          break;
        }
        default:
          throw new Error(`Unknown V16 generated input: ${id}`);
      }
      pixels[offset] = rgb[0];
      pixels[offset + 1] = rgb[1];
      pixels[offset + 2] = rgb[2];
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

export function assertV16Shape(manifest: V16Manifest): void {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.cohort, 'corrected-v16');
  assert.equal(manifest.freezeId, FREEZE_ID);
  assert.equal(manifest.attemptBudget, 1);
  assert.deepEqual(manifest.thresholds, THRESHOLDS);
  assert.deepEqual(manifest.priorV13, PRIOR_V13);
  assert.deepEqual(manifest.priorV14, PRIOR_V14);
  assert.deepEqual(manifest.priorV15, PRIOR_V15);
  assert.equal(manifest.sourceSelectionSha256, SOURCE_SELECTION_SHA);
  assert.equal(manifest.sourceMetadataSha256, SOURCE_METADATA_SHA);
  assert.deepEqual(manifest.sources, MEDIA);
  assert.equal(V16_HELDOUT.length, 20);
  assert.equal(manifest.fixtures.length, V16_HELDOUT.length);
  const ids = new Set<string>();
  let videoIndex = 0;
  for (const [index, spec] of V16_HELDOUT.entries()) {
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
  const collectSources = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'sha256' || key === 'originalSha256') && typeof child === 'string')
        sources.add(child);
      else collectSources(child);
    }
  };
  for (const prior of [
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
  manifest: V16Manifest,
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

function validateSourcePins(manifest: V16Manifest, paths: V16SourcePaths, root: string) {
  assertV16Shape(manifest);
  assert.equal(manifest.generatorSha256, digest(readFileSync(fileURLToPath(import.meta.url))));
  const prior = priorIdentities(root);
  const repo = realpathSync(root);
  const photo = paths.v16Photo;
  const video = paths.v16Video;
  assert.ok(photo && video, 'V16 needs --v16-photo and --v16-video private originals');
  const originals = { photo: realpathSync(photo), video: realpathSync(video) };
  assert.notEqual(manifest.sources.photo.sha256, manifest.sources.video.sha256);
  for (const [kind, path] of Object.entries(originals) as Array<['photo' | 'video', string]>) {
    const subpath = relative(repo, path);
    assert.ok(subpath.startsWith(`..${sep}`), `V16 ${kind} must be outside the harness checkout`);
    const pin = manifest.sources[kind];
    assert.ok(!prior.sources.has(pin.sha256), `V16 ${kind} reuses an exposed original`);
    const bytes = readFileSync(path);
    assert.equal(bytes.length, pin.bytes, `V16 ${kind} original byte length changed`);
    assert.equal(createHash('sha1').update(bytes).digest('hex'), pin.publisherSha1);
    assert.equal(digest(bytes), pin.sha256, `V16 ${kind} original SHA-256 changed`);
  }
  const version = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0];
  assert.ok(version?.trim());
  assert.equal(version, manifest.ffmpegVersion, 'V16 FFmpeg version changed');
  return { prior, originals };
}

function collectFixtures(
  manifest: V16Manifest,
  paths: V16SourcePaths,
  root: string,
  verify: boolean
) {
  const { prior, originals } = validateSourcePins(manifest, paths, root);
  const result = new Map<string, { fixture: PixelFixture; sha256: string }>();
  for (const [index, spec] of V16_HELDOUT.entries()) {
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
export function preflightV16(
  manifest: V16Manifest,
  paths: V16SourcePaths,
  root: string,
  regression: boolean
) {
  assert.equal(
    manifest.status,
    regression ? 'EXPOSED_REGRESSION' : 'FROZEN_UNEXECUTED',
    'V16 draft or wrong-purpose cohort is not acceptance ready'
  );
  assert.ok(
    manifest.fixtures.every((row) => row.sha256 && SHA.test(row.sha256)),
    'V16 pixel pins are incomplete'
  );
  const rows = collectFixtures(manifest, paths, root, true);
  return new Map([...rows].map(([id, { fixture }]) => [id, fixture]));
}

/** Emit source-only pixel pins for review; this never promotes the draft. */
export function prepareV16Manifest(
  manifest: V16Manifest,
  paths: V16SourcePaths,
  root: string
): V16Manifest {
  assert.equal(manifest.status, 'PROSPECTIVE_UNFROZEN');
  assert.ok(
    manifest.fixtures.every((row) => row.sha256 === null),
    'V16 source-only draft is already populated'
  );
  const rows = collectFixtures(manifest, paths, root, false);
  return {
    ...manifest,
    fixtures: manifest.fixtures.map((row) => ({ ...row, sha256: rows.get(row.id)!.sha256 })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.equal(args.length, 4, 'Use --v16-photo ORIGINAL --v16-video ORIGINAL');
  assert.equal(args[0], '--v16-photo');
  assert.equal(args[2], '--v16-video');
  const root = resolve(import.meta.dirname, '../..');
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v16-fixtures.json'), 'utf8')
  ) as V16Manifest;
  const prepared = prepareV16Manifest(manifest, { v16Photo: args[1]!, v16Video: args[3]! }, root);
  process.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`);
}
