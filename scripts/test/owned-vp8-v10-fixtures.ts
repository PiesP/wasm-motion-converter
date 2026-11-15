/** Prospective corrected-v10 source-only fixtures. Never read codec output here. */
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

export type V10SourcePaths = V4SourcePaths;

export const V10_PHOTO = {
  name: 'Landscape_of_a_wild_forest.jpg',
  page: 'https://commons.wikimedia.org/wiki/File:Landscape_of_a_wild_forest.jpg',
  revision:
    'https://commons.wikimedia.org/w/index.php?title=File:Landscape_of_a_wild_forest.jpg&oldid=1142609642',
  download: 'https://upload.wikimedia.org/wikipedia/commons/c/c9/Landscape_of_a_wild_forest.jpg',
  license: 'CC0-1.0',
  author: 'SpessiG',
  originalWidth: 3136,
  originalHeight: 2091,
  bytes: 4_978_501,
  sha1: '77503952fb9f6245d2c5c0f70eb6f2f92ea87399',
  sha256: '2f9f01326230bf9166eec430eb6d14cac69412d6cf6e2ecc7a25970683e4ddea',
} as const;

export const V10_PHOTO_REGIONS = {
  primary: { x: 108, y: 125, width: 1360, height: 1350 },
  detail: { x: 1740, y: 430, width: 1100, height: 1280 },
} as const;

const VIDEO_BYTES = 3_145_371;
const MAX_PIXELS = 10_066_329;
const NOISE_SEED = 0x501a9c73;

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

export const V10_HELDOUT: readonly FixtureSpec[] = [
  spec('fresh10-gray', 'held-out', 'grayscale', 563, 319),
  spec('fresh10-gradient', 'held-out', 'gradient', 439, 301),
  spec('fresh10-chroma-edge', 'held-out', 'chroma', 421, 289),
  spec('fresh10-text', 'held-out', 'text', 487, 337),
  spec('fresh10-noise', 'held-out', 'noise', 347, 253),
  spec('fresh10-tiny-7x11', 'held-out', 'tiny', 7, 11),
  spec('fresh10-tiny-11x1', 'held-out', 'tiny', 11, 1),
  spec('fresh10-tiny-1x19', 'held-out', 'tiny', 1, 19),
  spec('fresh10-one-column', 'held-out', 'odd', 1, 397),
  spec('fresh10-one-row', 'held-out', 'odd', 401, 1),
  spec('fresh10-large-admitted', 'held-out', 'large', 4019, 2504),
  spec('fresh10-bgra', 'held-out', 'layout', 313, 193, 'BGRA'),
  spec('fresh10-rgbx', 'held-out', 'layout', 313, 193, 'RGBX'),
  spec('fresh10-bgrx', 'held-out', 'layout', 313, 193, 'BGRX'),
  spec('fresh10-padded-rgba', 'held-out', 'padded-stride', 321, 187),
  spec('fresh10-photo', 'held-out', 'photograph', 457, 593, 'RGBA', 'photo'),
  spec('fresh10-photo-detail', 'held-out', 'photograph-detail', 303, 389, 'RGBA', 'photo'),
  spec('fresh10-video-101', 'held-out', 'video', 544, 306, 'RGBA', 'video', 101),
  spec('fresh10-video-143', 'held-out', 'video', 544, 306, 'RGBA', 'video', 143),
  spec(
    'fresh10-duplicate-hold',
    'held-out',
    'duplicate-hold',
    544,
    306,
    'RGBA',
    'video',
    101,
    'fresh10-video-101'
  ),
];

const GLYPHS: Record<string, readonly string[]> = {
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '10001', '01110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function textPixel(x: number, y: number): boolean {
  const scale = 8;
  const col = Math.floor((x - 47) / scale);
  const row = Math.floor((y - 91) / scale);
  if (col < 0 || row < 0 || row >= 7) return false;
  const letter = Math.floor(col / 6);
  const within = col % 6;
  const glyph = GLYPHS['FOREST 10'[letter] ?? ' '];
  return within < 5 && glyph?.[row]?.[within] === '1';
}

function generated(item: FixtureSpec): Uint8Array {
  const { id, width, height, layout } = item;
  const stride = width * 4 + (id === 'fresh10-padded-rgba' ? 28 : 0);
  const bytes = new Uint8Array(stride * height);
  if (id === 'fresh10-padded-rgba') bytes.fill(0x73);
  let seed = NOISE_SEED;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      let rgb: readonly number[];
      switch (id) {
        case 'fresh10-gray': {
          const value = (37 * x + 43 * y + ((7 * x * y) % 91)) & 255;
          rgb = [value, value, value];
          break;
        }
        case 'fresh10-gradient':
          rgb = [
            Math.floor((255 * (5 * x + 3 * y)) / (5 * (width - 1) + 3 * (height - 1))),
            Math.floor(
              (255 * (4 * (width - 1 - x) + 3 * y)) / (4 * (width - 1) + 3 * (height - 1))
            ),
            Math.floor(
              (255 * (7 * (height - 1 - y) + 2 * x)) / (7 * (height - 1) + 2 * (width - 1))
            ),
          ];
          break;
        case 'fresh10-chroma-edge':
          rgb = Math.floor((17 * x + 7 * y) / 23) & 1 ? [232, 53, 142] : [41, 217, 89];
          break;
        case 'fresh10-text':
          rgb = textPixel(x, y) ? [239, 197, 67] : [43 + ((x >> 3) & 27), 61 + ((y >> 3) & 21), 73];
          break;
        case 'fresh10-noise':
          rgb = [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255];
          break;
        case 'fresh10-tiny-7x11':
          rgb = [
            (67 + 43 * x + 79 * y) & 255,
            (181 + 61 * x + 41 * y) & 255,
            (53 + 29 * x + 83 * y) & 255,
          ];
          break;
        case 'fresh10-tiny-11x1':
          rgb =
            (7 * x + y) % 3 === 0
              ? [237, 51, 163]
              : (3 * x + y) & 1
                ? [57, 223, 113]
                : [107, 83, 213];
          break;
        case 'fresh10-tiny-1x19':
          rgb = [
            (31 + 59 * x + 41 * y + 13 * x * y) & 255,
            (173 + 37 * x + 89 * y) & 255,
            (79 + 73 * x + 53 * y) & 255,
          ];
          break;
        case 'fresh10-one-column':
          rgb = [(43 * y + 19) & 255, (59 * y + 37) & 255, (23 * y + 17) & 255];
          break;
        case 'fresh10-one-row':
          rgb = [(47 * x + 31) & 255, (43 * x + 53) & 255, (71 * x + 23) & 255];
          break;
        case 'fresh10-large-admitted':
          rgb = [
            (((7 * x) >> 6) + ((13 * y) >> 7)) & 255,
            ((9 * x + 7 * y) >> 7) & 255,
            (((13 * x) ^ (5 * y)) >> 6) & 255,
          ];
          break;
        case 'fresh10-bgra':
        case 'fresh10-rgbx':
        case 'fresh10-bgrx':
        case 'fresh10-padded-rgba':
          rgb = [(53 * x + 29 * y) & 255, (31 * x + 47 * y) & 255, (61 * x + 19 * y) & 255];
          break;
        default:
          throw new Error(`Unknown corrected-v10 generator: ${id}`);
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

function checkedSource(
  path: string,
  bytes: number,
  sha256: string,
  label: string,
  sha1?: string
): void {
  const contents = readFileSync(path);
  assert.equal(contents.length, bytes, `${label} source byte count changed`);
  if (sha1)
    assert.equal(
      createHash('sha1').update(contents).digest('hex'),
      sha1,
      `${label} source SHA1 changed`
    );
  assert.equal(
    createHash('sha256').update(contents).digest('hex'),
    sha256,
    `${label} source SHA256 changed`
  );
}

export function generateV10Fixture(id: string, paths: V10SourcePaths = {}): PixelFixture {
  const item = V10_HELDOUT.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown corrected-v10 fixture: ${id}`);
  let pixels: Uint8Array;
  if (item.source === 'generated') pixels = generated(item);
  else {
    const photo = item.source === 'photo';
    const path = photo ? paths.freshPhoto : paths.video;
    if (!path) throw new Error(`Missing ${photo ? 'fresh photo' : 'video'} source for ${id}`);
    checkedSource(
      path,
      photo ? V10_PHOTO.bytes : VIDEO_BYTES,
      photo ? V10_PHOTO.sha256 : EXTERNAL_SOURCES.video.sha256,
      photo ? 'fresh photo' : 'video',
      photo ? V10_PHOTO.sha1 : undefined
    );
    const region =
      item.id === 'fresh10-photo-detail' ? V10_PHOTO_REGIONS.detail : V10_PHOTO_REGIONS.primary;
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
  return { ...item, stride: item.width * 4 + (item.id === 'fresh10-padded-rgba' ? 28 : 0), pixels };
}

export function v10Manifest(paths: V10SourcePaths): object {
  const entries = V10_HELDOUT;
  assert.equal(V10_HELDOUT.length, 20);
  assert.equal(new Set(entries.map((item) => item.id)).size, entries.length);
  const [primary, detail] = [V10_PHOTO_REGIONS.primary, V10_PHOTO_REGIONS.detail];
  for (const region of [primary, detail]) {
    assert.ok(region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0);
    assert.ok(region.x + region.width <= V10_PHOTO.originalWidth);
    assert.ok(region.y + region.height <= V10_PHOTO.originalHeight);
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
    cohort: 'corrected-v10',
    purpose:
      'Prospective source-only fresh held-out inputs; v1-v9 remain exposed regression evidence',
    tuningBasis: 'No new tuning entries; the existing 15 tuning fixtures stay exposed controls',
    pixelConvention: {
      stride: 'width * 4, except fresh10-padded-rgba uses width * 4 + 28 with 0x73 padding',
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
      photoBytes: V10_PHOTO.bytes,
      videoBytes: VIDEO_BYTES,
    },
    sources: {
      photo: V10_PHOTO,
      photoRegions: V10_PHOTO_REGIONS,
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
      correctedV8: sha256(resolve(root, 'docs/experiments/501-owned-vp8-v8-fixtures.json')),
      correctedV9: sha256(resolve(root, 'docs/experiments/501-owned-vp8-v9-fixtures.json')),
    },
    generator: 'scripts/test/owned-vp8-v10-fixtures.ts; source-only generation, no codec outputs',
    generatorSha256: sha256(fileURLToPath(import.meta.url)),
    externalDecode: {
      ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
      command:
        'ffmpeg -v error -noautorotate -i SOURCE -vf FILTER -frames:v 1 -f rawvideo -pix_fmt rgba pipe:1',
      photoFilter: 'crop=1360:1350:108:125,scale=457:593:flags=bicubic',
      photoDetailFilter: 'crop=1100:1280:1740:430,scale=303:389:flags=bicubic',
      videoFilter: 'select=eq(n\\,FRAME),scale=544:306:flags=bicubic',
    },
    fixtures: entries.map((item) => {
      const { pixels, ...details } = generateV10Fixture(item.id, paths);
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
      v10Manifest({
        ...(value('--fresh-photo') ? { freshPhoto: value('--fresh-photo')! } : {}),
        ...(value('--video') ? { video: value('--video')! } : {}),
      }),
      null,
      2
    )}\n`
  );
}
