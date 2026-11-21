/** Prospective corrected-v5 source-only fixtures. Never read codec output here. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXTERNAL_SOURCES,
  QUALITIES,
  type FixtureSpec,
  type PixelFixture,
} from './owned-vp8-v2-fixtures.ts';
import type { V4SourcePaths } from './owned-vp8-v4-fixtures.ts';

export type V5SourcePaths = V4SourcePaths;

export const V5_PHOTO = {
  name: 'Street in downtown Toronto.jpg',
  page: 'https://commons.wikimedia.org/wiki/File:Street_in_downtown_Toronto.jpg',
  revision:
    'https://commons.wikimedia.org/w/index.php?title=File:Street_in_downtown_Toronto.jpg&oldid=1086201642',
  download: 'https://upload.wikimedia.org/wikipedia/commons/b/bf/Street_in_downtown_Toronto.jpg',
  license: 'CC0-1.0',
  author: 'Jason Zhang',
  originalWidth: 2816,
  originalHeight: 2112,
  bytes: 3_284_011,
  sha1: '07484e9a34e51af66e32c9e6bf064993f04bb688',
  sha256: 'dbfcbea6e39f69c359ab4de504f20b81802eac8e6eef44e9d4147ba155d0c6fa',
} as const;

export const V5_PHOTO_REGIONS = {
  primary: { x: 0, y: 0, width: 1408, height: 1056 },
  detail: { x: 1760, y: 1260, width: 704, height: 528 },
} as const;

const VIDEO_BYTES = 3_145_371;
const MAX_PIXELS = 10_066_329;
const NOISE_SEED = 0x50152026;

function spec(
  id: string,
  split: 'tuning' | 'held-out',
  kind: string,
  width: number,
  height: number,
  layout: FixtureSpec['layout'] = 'RGBA',
  source: 'generated' | 'photo' | 'video' = 'generated',
  frame?: number,
  repeatOf?: string
): FixtureSpec {
  return {
    id,
    split,
    class: kind,
    width,
    height,
    layout,
    source,
    ...(frame === undefined ? {} : { frame }),
    ...(repeatOf ? { repeatOf } : {}),
  };
}

export const V5_HELDOUT: readonly FixtureSpec[] = [
  spec('fresh5-gray', 'held-out', 'grayscale', 503, 313),
  spec('fresh5-gradient', 'held-out', 'gradient', 397, 283),
  spec('fresh5-chroma-edge', 'held-out', 'chroma', 367, 257),
  spec('fresh5-text', 'held-out', 'text', 419, 301),
  spec('fresh5-noise', 'held-out', 'noise', 311, 199),
  spec('fresh5-tiny-2x7', 'held-out', 'tiny', 2, 7),
  spec('fresh5-tiny-5x3', 'held-out', 'tiny', 5, 3),
  spec('fresh5-tiny-7x2', 'held-out', 'tiny', 7, 2),
  spec('fresh5-one-column', 'held-out', 'odd', 1, 319),
  spec('fresh5-one-row', 'held-out', 'odd', 331, 1),
  spec('fresh5-large-admitted', 'held-out', 'large', 4000, 2516),
  spec('fresh5-bgra', 'held-out', 'layout', 277, 161, 'BGRA'),
  spec('fresh5-rgbx', 'held-out', 'layout', 277, 161, 'RGBX'),
  spec('fresh5-photo', 'held-out', 'photograph', 533, 399, 'RGBA', 'photo'),
  spec('fresh5-photo-detail', 'held-out', 'photograph-detail', 317, 237, 'RGBA', 'photo'),
  spec('fresh5-video-24', 'held-out', 'video', 520, 292, 'RGBA', 'video', 24),
  spec('fresh5-video-137', 'held-out', 'video', 520, 292, 'RGBA', 'video', 137),
  spec(
    'fresh5-duplicate-hold',
    'held-out',
    'duplicate-hold',
    520,
    292,
    'RGBA',
    'video',
    24,
    'fresh5-video-24'
  ),
];

const GLYPHS: Record<string, readonly string[]> = {
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function textPixel(x: number, y: number): boolean {
  const scale = 6;
  const col = Math.floor((x - 33) / scale);
  const row = Math.floor((y - 97) / scale);
  if (col < 0 || row < 0 || row >= 7) return false;
  const letter = Math.floor(col / 6);
  const within = col % 6;
  const glyph = GLYPHS['FRESH 5'[letter] ?? ' '];
  return within < 5 && glyph?.[row]?.[within] === '1';
}

function generated(item: FixtureSpec): Uint8Array {
  const { id, width, height, layout } = item;
  const bytes = new Uint8Array(width * height * 4);
  let seed = NOISE_SEED;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      let rgb: readonly number[];
      switch (id) {
        case 'fresh5-gray': {
          const value = (19 * x + 37 * y + ((x * y) % 61)) & 255;
          rgb = [value, value, value];
          break;
        }
        case 'fresh5-gradient':
          rgb = [
            Math.floor((255 * (2 * x + y)) / (2 * (width - 1) + height - 1)),
            Math.floor((255 * (width - 1 - x + 3 * y)) / (width - 1 + 3 * (height - 1))),
            Math.floor((255 * (2 * (height - 1 - y) + x)) / (2 * (height - 1) + width - 1)),
          ];
          break;
        case 'fresh5-chroma-edge':
          rgb = Math.floor((7 * x + 3 * y) / 11) & 1 ? [241, 28, 178] : [24, 212, 71];
          break;
        case 'fresh5-text':
          rgb = textPixel(x, y) ? [246, 196, 39] : [25 + ((x >> 5) & 31), 38 + ((y >> 3) & 15), 67];
          break;
        case 'fresh5-noise':
          rgb = [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255];
          break;
        case 'fresh5-tiny-2x7':
          rgb = [
            (37 + 41 * x + 67 * y) & 255,
            (211 + 71 * x + 23 * y) & 255,
            (19 + 13 * x + 89 * y) & 255,
          ];
          break;
        case 'fresh5-tiny-5x3':
          rgb =
            (x + 2 * y) % 3 === 0 ? [246, 22, 170] : (x + y) & 1 ? [31, 219, 84] : [73, 64, 245];
          break;
        case 'fresh5-tiny-7x2':
          rgb = [
            (17 + 53 * x + 29 * y + 11 * x * y) & 255,
            (193 + 17 * x + 83 * y) & 255,
            (61 + 79 * x + 47 * y) & 255,
          ];
          break;
        case 'fresh5-one-column':
          rgb = [(17 * y) & 255, (43 * y) & 255, (9 * y) & 255];
          break;
        case 'fresh5-one-row':
          rgb = [(31 * x) & 255, (13 * x) & 255, (53 * x) & 255];
          break;
        case 'fresh5-large-admitted':
          rgb = [
            ((x >> 4) + ((3 * y) >> 5)) & 255,
            ((x + 5 * y) >> 6) & 255,
            (((3 * x) ^ y) >> 5) & 255,
          ];
          break;
        case 'fresh5-bgra':
        case 'fresh5-rgbx':
          rgb = [(29 * x + 17 * y) & 255, (13 * x + 31 * y) & 255, (41 * x + 7 * y) & 255];
          break;
        default:
          throw new Error(`Unknown corrected-v5 generator: ${id}`);
      }
      const at = (y * width + x) * 4;
      bytes.set(
        layout === 'BGRA' || layout === 'BGRX'
          ? [rgb[2]!, rgb[1]!, rgb[0]!, layout === 'BGRX' ? seed & 255 : 255]
          : [rgb[0]!, rgb[1]!, rgb[2]!, layout === 'RGBX' ? seed & 255 : 255],
        at
      );
    }
  return bytes;
}

function checkedSource(path: string, bytes: number, sha256: string, label: string): void {
  const contents = readFileSync(path);
  assert.equal(contents.length, bytes, `${label} source byte count changed`);
  assert.equal(
    createHash('sha256').update(contents).digest('hex'),
    sha256,
    `${label} source SHA256 changed`
  );
}

export function generateV5Fixture(id: string, paths: V5SourcePaths = {}): PixelFixture {
  const item = V5_HELDOUT.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown corrected-v5 fixture: ${id}`);
  let pixels: Uint8Array;
  if (item.source === 'generated') pixels = generated(item);
  else {
    const photo = item.source === 'photo';
    const path = photo ? paths.freshPhoto : paths.video;
    if (!path) throw new Error(`Missing ${photo ? 'fresh photo' : 'video'} source for ${id}`);
    checkedSource(
      path,
      photo ? V5_PHOTO.bytes : VIDEO_BYTES,
      photo ? V5_PHOTO.sha256 : EXTERNAL_SOURCES.video.sha256,
      photo ? 'fresh photo' : 'video'
    );
    const region =
      item.id === 'fresh5-photo-detail' ? V5_PHOTO_REGIONS.detail : V5_PHOTO_REGIONS.primary;
    const filter = photo
      ? `crop=${region.width}:${region.height}:${region.x}:${region.y},scale=${item.width}:${item.height}:flags=bicubic`
      : `select=eq(n\\,${item.frame}),scale=${item.width}:${item.height}:flags=bicubic`;
    const decoded = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-noautorotate',
        '-i',
        path,
        '-vf',
        filter,
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
    assert.equal(
      decoded.length,
      item.width * item.height * 4,
      `Unexpected decoded length for ${id}`
    );
    pixels = new Uint8Array(decoded);
  }
  return { ...item, stride: item.width * 4, pixels };
}

export function v5Manifest(paths: V5SourcePaths): object {
  const entries = V5_HELDOUT;
  assert.equal(V5_HELDOUT.length, 18);
  assert.equal(new Set(entries.map((item) => item.id)).size, entries.length);
  const [primary, detail] = [V5_PHOTO_REGIONS.primary, V5_PHOTO_REGIONS.detail];
  for (const region of [primary, detail]) {
    assert.ok(region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0);
    assert.ok(region.x + region.width <= V5_PHOTO.originalWidth);
    assert.ok(region.y + region.height <= V5_PHOTO.originalHeight);
  }
  assert.ok(
    primary.x + primary.width <= detail.x ||
      detail.x + detail.width <= primary.x ||
      primary.y + primary.height <= detail.y ||
      detail.y + detail.height <= primary.y,
    'Photograph source regions must not overlap'
  );
  for (const item of entries) {
    assert.ok(item.width > 0 && item.height > 0 && item.width <= 16383 && item.height <= 16383);
    assert.ok(item.width * item.height <= MAX_PIXELS, `${item.id} exceeds the frame cap`);
    if (item.repeatOf) {
      const first = entries.find((other) => other.id === item.repeatOf);
      assert.ok(first && first.source === item.source && first.frame === item.frame);
      assert.ok(
        first.width === item.width && first.height === item.height && first.layout === item.layout
      );
    }
  }
  const root = resolve(import.meta.dirname, '../..');
  const sha256 = (file: string): string =>
    createHash('sha256').update(readFileSync(file)).digest('hex');
  return {
    schemaVersion: 1,
    cohort: 'corrected-v5',
    purpose:
      'Prospective source-only fresh held-out inputs after corrected-v4 44/45 rejection; all earlier cohorts remain exposed regression evidence',
    tuningBasis: 'No new tuning entries; the existing 15 tuning fixtures stay exposed controls',
    rejectedCandidate: '9071b71842e2dcd83163d047e49329aafe336aea',
    rejectedWasmSha256: 'a53d77301d020c892b08048a02293515daa56e30a023fcd68fa4c228da5868c0',
    previousOutcome: {
      jointPasses: 44,
      conditions: 45,
      failed: [
        {
          fixture: 'fresh4-tiny',
          quality: 60,
          gate: 'ssim',
          baseline: 0.55991,
          candidate: 0.525307,
          minimum: 0.54991,
        },
      ],
    },
    thresholds: {
      psnrBaselineDeltaDb: -1,
      ssimBaselineDelta: -0.01,
      sizeRatio: 1.25,
      sizeAdditiveBytes: 128,
    },
    bounds: {
      maxWidth: 16383,
      maxHeight: 16383,
      maxPixels: MAX_PIXELS,
      photoBytes: V5_PHOTO.bytes,
      videoBytes: VIDEO_BYTES,
    },
    sources: {
      photo: V5_PHOTO,
      photoRegions: V5_PHOTO_REGIONS,
      video: { ...EXTERNAL_SOURCES.video, bytes: VIDEO_BYTES },
    },
    priorManifestSha256: {
      initialV1: sha256(resolve(root, 'docs/experiments/501-owned-vp8-v2-fixtures.json')),
      correctedV2: sha256(
        resolve(root, 'docs/experiments/501-owned-vp8-v2-correction-fixtures.json')
      ),
      correctedV3: sha256(resolve(root, 'docs/experiments/501-owned-vp8-v3-fixtures.json')),
      correctedV4: sha256(resolve(root, 'docs/experiments/501-owned-vp8-v4-fixtures.json')),
    },
    generator: 'scripts/test/owned-vp8-v5-fixtures.ts; source-only generation, no codec outputs',
    generatorSha256: sha256(fileURLToPath(import.meta.url)),
    externalDecode: {
      ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
      command:
        'ffmpeg -v error -noautorotate -i SOURCE -vf FILTER -frames:v 1 -f rawvideo -pix_fmt rgba pipe:1',
      photoFilter: 'crop=1408:1056:0:0,scale=533:399:flags=bicubic',
      photoDetailFilter: 'crop=704:528:1760:1260,scale=317:237:flags=bicubic',
      videoFilter: 'select=eq(n\\,FRAME),scale=520:292:flags=bicubic',
    },
    fixtures: entries.map((item) => {
      const { pixels, ...details } = generateV5Fixture(item.id, paths);
      return {
        ...details,
        qualities: QUALITIES,
        sha256: createHash('sha256').update(pixels).digest('hex'),
      };
    }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  process.stdout.write(
    `${JSON.stringify(
      v5Manifest({
        ...(value('--fresh-photo') ? { freshPhoto: value('--fresh-photo')! } : {}),
        ...(value('--video') ? { video: value('--video')! } : {}),
      }),
      null,
      2
    )}\n`
  );
}
