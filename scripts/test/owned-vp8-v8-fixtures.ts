/** Prospective corrected-v8 source-only fixtures. Never read codec output here. */
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

export type V8SourcePaths = V4SourcePaths;

export const V8_PHOTO = {
  name: 'Architecture along Wall Street, New York City.jpg',
  page: 'https://commons.wikimedia.org/wiki/File:Architecture_along_Wall_Street,_New_York_City.jpg',
  revision:
    'https://commons.wikimedia.org/w/index.php?title=File:Architecture_along_Wall_Street,_New_York_City.jpg&oldid=1298939179',
  download:
    'https://upload.wikimedia.org/wikipedia/commons/d/de/Architecture_along_Wall_Street%2C_New_York_City.jpg',
  license: 'CC0-1.0',
  author: 'Z3lvs',
  originalWidth: 3024,
  originalHeight: 4032,
  bytes: 5_289_121,
  sha1: 'c6d9b52d1534df3d01404ff9d881767b7161e433',
  sha256: '46a843f7cbf299faa7bb5d3a97267e6dadbf4cf6ee0bccaff492af188ca92136',
} as const;

export const V8_PHOTO_REGIONS = {
  primary: { x: 0, y: 0, width: 1512, height: 2016 },
  detail: { x: 2016, y: 2688, width: 1008, height: 1344 },
} as const;

const VIDEO_BYTES = 3_145_371;
const MAX_PIXELS = 10_066_329;
const NOISE_SEED = 0x5018d00d;

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

export const V8_HELDOUT: readonly FixtureSpec[] = [
  spec('fresh8-gray', 'held-out', 'grayscale', 533, 319),
  spec('fresh8-gradient', 'held-out', 'gradient', 421, 281),
  spec('fresh8-chroma-edge', 'held-out', 'chroma', 391, 271),
  spec('fresh8-text', 'held-out', 'text', 457, 313),
  spec('fresh8-noise', 'held-out', 'noise', 317, 227),
  spec('fresh8-tiny-3x11', 'held-out', 'tiny', 3, 11),
  spec('fresh8-tiny-7x1', 'held-out', 'tiny', 7, 1),
  spec('fresh8-tiny-1x13', 'held-out', 'tiny', 1, 13),
  spec('fresh8-one-column', 'held-out', 'odd', 1, 367),
  spec('fresh8-one-row', 'held-out', 'odd', 371, 1),
  spec('fresh8-large-admitted', 'held-out', 'large', 4100, 2455),
  spec('fresh8-bgra', 'held-out', 'layout', 293, 169, 'BGRA'),
  spec('fresh8-rgbx', 'held-out', 'layout', 293, 169, 'RGBX'),
  spec('fresh8-bgrx', 'held-out', 'layout', 293, 169, 'BGRX'),
  spec('fresh8-padded-rgba', 'held-out', 'padded-stride', 301, 173),
  spec('fresh8-photo', 'held-out', 'photograph', 429, 571, 'RGBA', 'photo'),
  spec('fresh8-photo-detail', 'held-out', 'photograph-detail', 281, 375, 'RGBA', 'photo'),
  spec('fresh8-video-63', 'held-out', 'video', 544, 306, 'RGBA', 'video', 63),
  spec('fresh8-video-159', 'held-out', 'video', 544, 306, 'RGBA', 'video', 159),
  spec(
    'fresh8-duplicate-hold',
    'held-out',
    'duplicate-hold',
    544,
    306,
    'RGBA',
    'video',
    63,
    'fresh8-video-63'
  ),
];

const GLYPHS: Record<string, readonly string[]> = {
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function textPixel(x: number, y: number): boolean {
  const scale = 8;
  const col = Math.floor((x - 51) / scale);
  const row = Math.floor((y - 107) / scale);
  if (col < 0 || row < 0 || row >= 7) return false;
  const letter = Math.floor(col / 6);
  const within = col % 6;
  const glyph = GLYPHS['FRESH 8'[letter] ?? ' '];
  return within < 5 && glyph?.[row]?.[within] === '1';
}

function generated(item: FixtureSpec): Uint8Array {
  const { id, width, height, layout } = item;
  const stride = width * 4 + (id === 'fresh8-padded-rgba' ? 20 : 0);
  const bytes = new Uint8Array(stride * height);
  if (id === 'fresh8-padded-rgba') bytes.fill(0xa7);
  let seed = NOISE_SEED;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      let rgb: readonly number[];
      switch (id) {
        case 'fresh8-gray': {
          const value = (41 * x + 17 * y + ((3 * x * y) % 71)) & 255;
          rgb = [value, value, value];
          break;
        }
        case 'fresh8-gradient':
          rgb = [
            Math.floor((255 * (5 * x + y)) / (5 * (width - 1) + height - 1)),
            Math.floor((255 * (width - 1 - x + 4 * y)) / (width - 1 + 4 * (height - 1))),
            Math.floor(
              (255 * (4 * (height - 1 - y) + 3 * x)) / (4 * (height - 1) + 3 * (width - 1))
            ),
          ];
          break;
        case 'fresh8-chroma-edge':
          rgb = Math.floor((11 * x + 7 * y) / 17) & 1 ? [237, 31, 192] : [29, 219, 63];
          break;
        case 'fresh8-text':
          rgb = textPixel(x, y) ? [253, 194, 37] : [31 + ((x >> 3) & 31), 43 + ((y >> 5) & 15), 73];
          break;
        case 'fresh8-noise':
          rgb = [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255];
          break;
        case 'fresh8-tiny-3x11':
          rgb = [
            (53 + 37 * x + 79 * y) & 255,
            (211 + 67 * x + 31 * y) & 255,
            (39 + 19 * x + 97 * y) & 255,
          ];
          break;
        case 'fresh8-tiny-7x1':
          rgb =
            (3 * x + y) % 4 === 0
              ? [244, 29, 171]
              : (2 * x + y) & 1
                ? [35, 227, 91]
                : [89, 61, 239];
          break;
        case 'fresh8-tiny-1x13':
          rgb = [
            (19 + 61 * x + 41 * y + 7 * x * y) & 255,
            (173 + 29 * x + 89 * y) & 255,
            (67 + 83 * x + 53 * y) & 255,
          ];
          break;
        case 'fresh8-one-column':
          rgb = [(43 * y + 13) & 255, (47 * y + 29) & 255, (17 * y + 11) & 255];
          break;
        case 'fresh8-one-row':
          rgb = [(37 * x + 23) & 255, (31 * x + 43) & 255, (71 * x + 17) & 255];
          break;
        case 'fresh8-large-admitted':
          rgb = [
            (((3 * x) >> 5) + ((7 * y) >> 6)) & 255,
            ((5 * x + 3 * y) >> 7) & 255,
            (((7 * x) ^ (5 * y)) >> 6) & 255,
          ];
          break;
        case 'fresh8-bgra':
        case 'fresh8-rgbx':
        case 'fresh8-bgrx':
        case 'fresh8-padded-rgba':
          rgb = [(43 * x + 29 * y) & 255, (23 * x + 47 * y) & 255, (61 * x + 13 * y) & 255];
          break;
        default:
          throw new Error(`Unknown corrected-v8 generator: ${id}`);
      }
      const at = y * stride + x * 4;
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

export function generateV8Fixture(id: string, paths: V8SourcePaths = {}): PixelFixture {
  const item = V8_HELDOUT.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown corrected-v8 fixture: ${id}`);
  let pixels: Uint8Array;
  if (item.source === 'generated') pixels = generated(item);
  else {
    const photo = item.source === 'photo';
    const path = photo ? paths.freshPhoto : paths.video;
    if (!path) throw new Error(`Missing ${photo ? 'fresh photo' : 'video'} source for ${id}`);
    checkedSource(
      path,
      photo ? V8_PHOTO.bytes : VIDEO_BYTES,
      photo ? V8_PHOTO.sha256 : EXTERNAL_SOURCES.video.sha256,
      photo ? 'fresh photo' : 'video'
    );
    const region =
      item.id === 'fresh8-photo-detail' ? V8_PHOTO_REGIONS.detail : V8_PHOTO_REGIONS.primary;
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
  return { ...item, stride: item.width * 4 + (item.id === 'fresh8-padded-rgba' ? 20 : 0), pixels };
}

export function v8Manifest(paths: V8SourcePaths): object {
  const entries = V8_HELDOUT;
  assert.equal(V8_HELDOUT.length, 20);
  assert.equal(new Set(entries.map((item) => item.id)).size, entries.length);
  const [primary, detail] = [V8_PHOTO_REGIONS.primary, V8_PHOTO_REGIONS.detail];
  for (const region of [primary, detail]) {
    assert.ok(region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0);
    assert.ok(region.x + region.width <= V8_PHOTO.originalWidth);
    assert.ok(region.y + region.height <= V8_PHOTO.originalHeight);
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
    cohort: 'corrected-v8',
    purpose:
      'Prospective source-only fresh held-out inputs; v1-v7 remain exposed regression evidence',
    tuningBasis: 'No new tuning entries; the existing 15 tuning fixtures stay exposed controls',
    pixelConvention: {
      stride: 'width * 4, except fresh8-padded-rgba uses width * 4 + 20 with 0xa7 padding',
      rgba: 'R,G,B,A with A=255',
      bgra: 'B,G,R,A with A=255',
      rgbx: 'R,G,B,X with deterministic seeded X bytes ignored by RGB comparison',
      bgrx: 'B,G,R,X with deterministic seeded X bytes ignored by RGB comparison',
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
      photoBytes: V8_PHOTO.bytes,
      videoBytes: VIDEO_BYTES,
    },
    sources: {
      photo: V8_PHOTO,
      photoRegions: V8_PHOTO_REGIONS,
      video: { ...EXTERNAL_SOURCES.video, bytes: VIDEO_BYTES, frameCount: 192, fps: 30 },
    },
    priorManifestSha256: {
      initialV1: sha256(resolve(root, 'docs/experiments/501-owned-vp8-v2-fixtures.json')),
      correctedV2: sha256(
        resolve(root, 'docs/experiments/501-owned-vp8-v2-correction-fixtures.json')
      ),
      correctedV3: sha256(resolve(root, 'docs/experiments/501-owned-vp8-v3-fixtures.json')),
      correctedV4: sha256(resolve(root, 'docs/experiments/501-owned-vp8-v4-fixtures.json')),
      correctedV5: sha256(resolve(root, 'docs/experiments/501-owned-vp8-v5-fixtures.json')),
      correctedV6: sha256(resolve(root, 'docs/experiments/501-owned-vp8-v6-fixtures.json')),
      correctedV7: sha256(resolve(root, 'docs/experiments/501-owned-vp8-v7-fixtures.json')),
    },
    generator: 'scripts/test/owned-vp8-v8-fixtures.ts; source-only generation, no codec outputs',
    generatorSha256: sha256(fileURLToPath(import.meta.url)),
    externalDecode: {
      ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
      command:
        'ffmpeg -v error -noautorotate -i SOURCE -vf FILTER -frames:v 1 -f rawvideo -pix_fmt rgba pipe:1',
      photoFilter: 'crop=1512:2016:0:0,scale=429:571:flags=bicubic',
      photoDetailFilter: 'crop=1008:1344:2016:2688,scale=281:375:flags=bicubic',
      videoFilter: 'select=eq(n\\,FRAME),scale=544:306:flags=bicubic',
    },
    fixtures: entries.map((item) => {
      const { pixels, ...details } = generateV8Fixture(item.id, paths);
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
      v8Manifest({
        ...(value('--fresh-photo') ? { freshPhoto: value('--fresh-photo')! } : {}),
        ...(value('--video') ? { video: value('--video')! } : {}),
      }),
      null,
      2
    )}\n`
  );
}
