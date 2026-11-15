/** Prospective corrected-v9 source-only fixtures. Never read codec output here. */
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

export type V9SourcePaths = V4SourcePaths;

export const V9_PHOTO = {
  name: '20190710_copenhagen_jpeg2_11.jpg',
  page: 'https://commons.wikimedia.org/wiki/File:20190710_copenhagen_jpeg2_11.jpg',
  revision:
    'https://commons.wikimedia.org/w/index.php?title=File:20190710_copenhagen_jpeg2_11.jpg&oldid=963886723',
  download: 'https://upload.wikimedia.org/wikipedia/commons/2/23/20190710_copenhagen_jpeg2_11.jpg',
  license: 'CC0-1.0',
  author: 'SeanDaRos',
  originalWidth: 6000,
  originalHeight: 4000,
  bytes: 2_940_346,
  sha1: 'bb722366844eb60130c50c8f0ae68999ef07e39b',
  sha256: 'c73dc8ab9bac25caa802d3e5195590e3f9a7dd18042539d6f3a7e4b9605de143',
} as const;

export const V9_PHOTO_REGIONS = {
  primary: { x: 0, y: 0, width: 1600, height: 2400 },
  detail: { x: 3600, y: 2300, width: 1200, height: 1500 },
} as const;

const VIDEO_BYTES = 3_145_371;
const MAX_PIXELS = 10_066_329;
const NOISE_SEED = 0x5019b47e;

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

export const V9_HELDOUT: readonly FixtureSpec[] = [
  spec('fresh9-gray', 'held-out', 'grayscale', 547, 331),
  spec('fresh9-gradient', 'held-out', 'gradient', 433, 293),
  spec('fresh9-chroma-edge', 'held-out', 'chroma', 407, 277),
  spec('fresh9-text', 'held-out', 'text', 469, 329),
  spec('fresh9-noise', 'held-out', 'noise', 331, 239),
  spec('fresh9-tiny-5x9', 'held-out', 'tiny', 5, 9),
  spec('fresh9-tiny-9x1', 'held-out', 'tiny', 9, 1),
  spec('fresh9-tiny-1x17', 'held-out', 'tiny', 1, 17),
  spec('fresh9-one-column', 'held-out', 'odd', 1, 379),
  spec('fresh9-one-row', 'held-out', 'odd', 383, 1),
  spec('fresh9-large-admitted', 'held-out', 'large', 4120, 2443),
  spec('fresh9-bgra', 'held-out', 'layout', 307, 181, 'BGRA'),
  spec('fresh9-rgbx', 'held-out', 'layout', 307, 181, 'RGBX'),
  spec('fresh9-bgrx', 'held-out', 'layout', 307, 181, 'BGRX'),
  spec('fresh9-padded-rgba', 'held-out', 'padded-stride', 315, 179),
  spec('fresh9-photo', 'held-out', 'photograph', 451, 601, 'RGBA', 'photo'),
  spec('fresh9-photo-detail', 'held-out', 'photograph-detail', 297, 397, 'RGBA', 'photo'),
  spec('fresh9-video-86', 'held-out', 'video', 552, 310, 'RGBA', 'video', 86),
  spec('fresh9-video-176', 'held-out', 'video', 552, 310, 'RGBA', 'video', 176),
  spec(
    'fresh9-duplicate-hold',
    'held-out',
    'duplicate-hold',
    552,
    310,
    'RGBA',
    'video',
    86,
    'fresh9-video-86'
  ),
];

const GLYPHS: Record<string, readonly string[]> = {
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  '9': ['01110', '10001', '10001', '01111', '00001', '10001', '01110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function textPixel(x: number, y: number): boolean {
  const scale = 9;
  const col = Math.floor((x - 59) / scale);
  const row = Math.floor((y - 113) / scale);
  if (col < 0 || row < 0 || row >= 7) return false;
  const letter = Math.floor(col / 6);
  const within = col % 6;
  const glyph = GLYPHS['FRESH 9'[letter] ?? ' '];
  return within < 5 && glyph?.[row]?.[within] === '1';
}

function generated(item: FixtureSpec): Uint8Array {
  const { id, width, height, layout } = item;
  const stride = width * 4 + (id === 'fresh9-padded-rgba' ? 24 : 0);
  const bytes = new Uint8Array(stride * height);
  if (id === 'fresh9-padded-rgba') bytes.fill(0x6d);
  let seed = NOISE_SEED;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      let rgb: readonly number[];
      switch (id) {
        case 'fresh9-gray': {
          const value = (41 * x + 29 * y + ((5 * x * y) % 83)) & 255;
          rgb = [value, value, value];
          break;
        }
        case 'fresh9-gradient':
          rgb = [
            Math.floor((255 * (3 * x + 2 * y)) / (3 * (width - 1) + 2 * (height - 1))),
            Math.floor(
              (255 * (2 * (width - 1 - x) + 5 * y)) / (2 * (width - 1) + 5 * (height - 1))
            ),
            Math.floor((255 * (6 * (height - 1 - y) + x)) / (6 * (height - 1) + width - 1)),
          ];
          break;
        case 'fresh9-chroma-edge':
          rgb = Math.floor((13 * x + 5 * y) / 19) & 1 ? [221, 44, 184] : [35, 207, 71];
          break;
        case 'fresh9-text':
          rgb = textPixel(x, y) ? [247, 201, 49] : [39 + ((x >> 4) & 23), 51 + ((y >> 4) & 19), 81];
          break;
        case 'fresh9-noise':
          rgb = [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255];
          break;
        case 'fresh9-tiny-5x9':
          rgb = [
            (61 + 31 * x + 73 * y) & 255,
            (193 + 59 * x + 37 * y) & 255,
            (47 + 23 * x + 89 * y) & 255,
          ];
          break;
        case 'fresh9-tiny-9x1':
          rgb =
            (5 * x + y) % 3 === 0
              ? [231, 41, 183]
              : (3 * x + y) & 1
                ? [47, 213, 103]
                : [97, 73, 223];
          break;
        case 'fresh9-tiny-1x17':
          rgb = [
            (29 + 53 * x + 37 * y + 11 * x * y) & 255,
            (181 + 31 * x + 83 * y) & 255,
            (71 + 79 * x + 47 * y) & 255,
          ];
          break;
        case 'fresh9-one-column':
          rgb = [(39 * y + 17) & 255, (53 * y + 31) & 255, (19 * y + 13) & 255];
          break;
        case 'fresh9-one-row':
          rgb = [(41 * x + 29) & 255, (37 * x + 47) & 255, (67 * x + 19) & 255];
          break;
        case 'fresh9-large-admitted':
          rgb = [
            (((5 * x) >> 6) + ((11 * y) >> 7)) & 255,
            ((7 * x + 5 * y) >> 7) & 255,
            (((11 * x) ^ (3 * y)) >> 6) & 255,
          ];
          break;
        case 'fresh9-bgra':
        case 'fresh9-rgbx':
        case 'fresh9-bgrx':
        case 'fresh9-padded-rgba':
          rgb = [(47 * x + 23 * y) & 255, (29 * x + 43 * y) & 255, (59 * x + 17 * y) & 255];
          break;
        default:
          throw new Error(`Unknown corrected-v9 generator: ${id}`);
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

export function generateV9Fixture(id: string, paths: V9SourcePaths = {}): PixelFixture {
  const item = V9_HELDOUT.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown corrected-v9 fixture: ${id}`);
  let pixels: Uint8Array;
  if (item.source === 'generated') pixels = generated(item);
  else {
    const photo = item.source === 'photo';
    const path = photo ? paths.freshPhoto : paths.video;
    if (!path) throw new Error(`Missing ${photo ? 'fresh photo' : 'video'} source for ${id}`);
    checkedSource(
      path,
      photo ? V9_PHOTO.bytes : VIDEO_BYTES,
      photo ? V9_PHOTO.sha256 : EXTERNAL_SOURCES.video.sha256,
      photo ? 'fresh photo' : 'video'
    );
    const region =
      item.id === 'fresh9-photo-detail' ? V9_PHOTO_REGIONS.detail : V9_PHOTO_REGIONS.primary;
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
  return { ...item, stride: item.width * 4 + (item.id === 'fresh9-padded-rgba' ? 24 : 0), pixels };
}

export function v9Manifest(paths: V9SourcePaths): object {
  const entries = V9_HELDOUT;
  assert.equal(V9_HELDOUT.length, 20);
  assert.equal(new Set(entries.map((item) => item.id)).size, entries.length);
  const [primary, detail] = [V9_PHOTO_REGIONS.primary, V9_PHOTO_REGIONS.detail];
  for (const region of [primary, detail]) {
    assert.ok(region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0);
    assert.ok(region.x + region.width <= V9_PHOTO.originalWidth);
    assert.ok(region.y + region.height <= V9_PHOTO.originalHeight);
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
    cohort: 'corrected-v9',
    purpose:
      'Prospective source-only fresh held-out inputs; v1-v8 remain exposed regression evidence',
    tuningBasis: 'No new tuning entries; the existing 15 tuning fixtures stay exposed controls',
    pixelConvention: {
      stride: 'width * 4, except fresh9-padded-rgba uses width * 4 + 24 with 0x6d padding',
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
      photoBytes: V9_PHOTO.bytes,
      videoBytes: VIDEO_BYTES,
    },
    sources: {
      photo: V9_PHOTO,
      photoRegions: V9_PHOTO_REGIONS,
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
    },
    generator: 'scripts/test/owned-vp8-v9-fixtures.ts; source-only generation, no codec outputs',
    generatorSha256: sha256(fileURLToPath(import.meta.url)),
    externalDecode: {
      ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
      command:
        'ffmpeg -v error -noautorotate -i SOURCE -vf FILTER -frames:v 1 -f rawvideo -pix_fmt rgba pipe:1',
      photoFilter: 'crop=1600:2400:0:0,scale=451:601:flags=bicubic',
      photoDetailFilter: 'crop=1200:1500:3600:2300,scale=297:397:flags=bicubic',
      videoFilter: 'select=eq(n\\,FRAME),scale=552:310:flags=bicubic',
    },
    fixtures: entries.map((item) => {
      const { pixels, ...details } = generateV9Fixture(item.id, paths);
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
      v9Manifest({
        ...(value('--fresh-photo') ? { freshPhoto: value('--fresh-photo')! } : {}),
        ...(value('--video') ? { video: value('--video')! } : {}),
      }),
      null,
      2
    )}\n`
  );
}
