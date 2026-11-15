/** Prospective corrected-v7 source-only fixtures. Never read codec output here. */
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

export type V7SourcePaths = V4SourcePaths;

export const V7_PHOTO = {
  name: 'Street scene - London, England - DSC01018.jpg',
  page: 'https://commons.wikimedia.org/wiki/File:Street_scene_-_London,_England_-_DSC01018.jpg',
  revision:
    'https://commons.wikimedia.org/w/index.php?title=File:Street_scene_-_London,_England_-_DSC01018.jpg&oldid=966946951',
  download:
    'https://upload.wikimedia.org/wikipedia/commons/7/7b/Street_scene_-_London%2C_England_-_DSC01018.jpg',
  license: 'CC0-1.0',
  author: 'Daderot',
  originalWidth: 5472,
  originalHeight: 3648,
  bytes: 4_742_790,
  sha1: 'caadd7e4af7b9fc273e9a1bb4a325fbb8b414218',
  sha256: '68fa5ae7a078678681aeed1c470ec87798b2dfd6fb7d76bb5871293f92a64a2e',
} as const;

export const V7_PHOTO_REGIONS = {
  primary: { x: 0, y: 0, width: 2736, height: 1824 },
  detail: { x: 3600, y: 2300, width: 1200, height: 900 },
} as const;

const VIDEO_BYTES = 3_145_371;
const MAX_PIXELS = 10_066_329;
const NOISE_SEED = 0x50172026;

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

export const V7_HELDOUT: readonly FixtureSpec[] = [
  spec('fresh7-gray', 'held-out', 'grayscale', 521, 317),
  spec('fresh7-gradient', 'held-out', 'gradient', 409, 277),
  spec('fresh7-chroma-edge', 'held-out', 'chroma', 379, 269),
  spec('fresh7-text', 'held-out', 'text', 443, 311),
  spec('fresh7-noise', 'held-out', 'noise', 313, 223),
  spec('fresh7-tiny-2x9', 'held-out', 'tiny', 2, 9),
  spec('fresh7-tiny-5x1', 'held-out', 'tiny', 5, 1),
  spec('fresh7-tiny-1x11', 'held-out', 'tiny', 1, 11),
  spec('fresh7-one-column', 'held-out', 'odd', 1, 353),
  spec('fresh7-one-row', 'held-out', 'odd', 359, 1),
  spec('fresh7-large-admitted', 'held-out', 'large', 4110, 2449),
  spec('fresh7-bgra', 'held-out', 'layout', 283, 163, 'BGRA'),
  spec('fresh7-rgbx', 'held-out', 'layout', 283, 163, 'RGBX'),
  spec('fresh7-photo', 'held-out', 'photograph', 559, 401, 'RGBA', 'photo'),
  spec('fresh7-photo-detail', 'held-out', 'photograph-detail', 337, 247, 'RGBA', 'photo'),
  spec('fresh7-video-47', 'held-out', 'video', 528, 296, 'RGBA', 'video', 47),
  spec('fresh7-video-184', 'held-out', 'video', 528, 296, 'RGBA', 'video', 184),
  spec(
    'fresh7-duplicate-hold',
    'held-out',
    'duplicate-hold',
    528,
    296,
    'RGBA',
    'video',
    47,
    'fresh7-video-47'
  ),
];

const GLYPHS: Record<string, readonly string[]> = {
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function textPixel(x: number, y: number): boolean {
  const scale = 8;
  const col = Math.floor((x - 51) / scale);
  const row = Math.floor((y - 107) / scale);
  if (col < 0 || row < 0 || row >= 7) return false;
  const letter = Math.floor(col / 6);
  const within = col % 6;
  const glyph = GLYPHS['FRESH 7'[letter] ?? ' '];
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
        case 'fresh7-gray': {
          const value = (41 * x + 17 * y + ((3 * x * y) % 71)) & 255;
          rgb = [value, value, value];
          break;
        }
        case 'fresh7-gradient':
          rgb = [
            Math.floor((255 * (5 * x + y)) / (5 * (width - 1) + height - 1)),
            Math.floor((255 * (width - 1 - x + 4 * y)) / (width - 1 + 4 * (height - 1))),
            Math.floor(
              (255 * (4 * (height - 1 - y) + 3 * x)) / (4 * (height - 1) + 3 * (width - 1))
            ),
          ];
          break;
        case 'fresh7-chroma-edge':
          rgb = Math.floor((11 * x + 7 * y) / 17) & 1 ? [237, 31, 192] : [29, 219, 63];
          break;
        case 'fresh7-text':
          rgb = textPixel(x, y) ? [253, 194, 37] : [31 + ((x >> 3) & 31), 43 + ((y >> 5) & 15), 73];
          break;
        case 'fresh7-noise':
          rgb = [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255];
          break;
        case 'fresh7-tiny-2x9':
          rgb = [
            (53 + 37 * x + 79 * y) & 255,
            (211 + 67 * x + 31 * y) & 255,
            (39 + 19 * x + 97 * y) & 255,
          ];
          break;
        case 'fresh7-tiny-5x1':
          rgb =
            (3 * x + y) % 4 === 0
              ? [244, 29, 171]
              : (2 * x + y) & 1
                ? [35, 227, 91]
                : [89, 61, 239];
          break;
        case 'fresh7-tiny-1x11':
          rgb = [
            (19 + 61 * x + 41 * y + 7 * x * y) & 255,
            (173 + 29 * x + 89 * y) & 255,
            (67 + 83 * x + 53 * y) & 255,
          ];
          break;
        case 'fresh7-one-column':
          rgb = [(43 * y + 13) & 255, (47 * y + 29) & 255, (17 * y + 11) & 255];
          break;
        case 'fresh7-one-row':
          rgb = [(37 * x + 23) & 255, (31 * x + 43) & 255, (71 * x + 17) & 255];
          break;
        case 'fresh7-large-admitted':
          rgb = [
            (((3 * x) >> 5) + ((7 * y) >> 6)) & 255,
            ((5 * x + 3 * y) >> 7) & 255,
            (((7 * x) ^ (5 * y)) >> 6) & 255,
          ];
          break;
        case 'fresh7-bgra':
        case 'fresh7-rgbx':
          rgb = [(43 * x + 29 * y) & 255, (23 * x + 47 * y) & 255, (61 * x + 13 * y) & 255];
          break;
        default:
          throw new Error(`Unknown corrected-v7 generator: ${id}`);
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

export function generateV7Fixture(id: string, paths: V7SourcePaths = {}): PixelFixture {
  const item = V7_HELDOUT.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown corrected-v7 fixture: ${id}`);
  let pixels: Uint8Array;
  if (item.source === 'generated') pixels = generated(item);
  else {
    const photo = item.source === 'photo';
    const path = photo ? paths.freshPhoto : paths.video;
    if (!path) throw new Error(`Missing ${photo ? 'fresh photo' : 'video'} source for ${id}`);
    checkedSource(
      path,
      photo ? V7_PHOTO.bytes : VIDEO_BYTES,
      photo ? V7_PHOTO.sha256 : EXTERNAL_SOURCES.video.sha256,
      photo ? 'fresh photo' : 'video'
    );
    const region =
      item.id === 'fresh7-photo-detail' ? V7_PHOTO_REGIONS.detail : V7_PHOTO_REGIONS.primary;
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

export function v7Manifest(paths: V7SourcePaths): object {
  const entries = V7_HELDOUT;
  assert.equal(V7_HELDOUT.length, 18);
  assert.equal(new Set(entries.map((item) => item.id)).size, entries.length);
  const [primary, detail] = [V7_PHOTO_REGIONS.primary, V7_PHOTO_REGIONS.detail];
  for (const region of [primary, detail]) {
    assert.ok(region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0);
    assert.ok(region.x + region.width <= V7_PHOTO.originalWidth);
    assert.ok(region.y + region.height <= V7_PHOTO.originalHeight);
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
    cohort: 'corrected-v7',
    purpose:
      'Prospective source-only fresh held-out inputs; v1-v6 remain exposed regression evidence',
    tuningBasis: 'No new tuning entries; the existing 15 tuning fixtures stay exposed controls',
    pixelConvention: {
      stride: 'width * 4 tightly packed bytes per visible row',
      rgba: 'R,G,B,A with A=255',
      bgra: 'B,G,R,A with A=255',
      rgbx: 'R,G,B,X with deterministic seeded X bytes ignored by RGB comparison',
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
      photoBytes: V7_PHOTO.bytes,
      videoBytes: VIDEO_BYTES,
    },
    sources: {
      photo: V7_PHOTO,
      photoRegions: V7_PHOTO_REGIONS,
      video: { ...EXTERNAL_SOURCES.video, bytes: VIDEO_BYTES },
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
    },
    generator: 'scripts/test/owned-vp8-v7-fixtures.ts; source-only generation, no codec outputs',
    generatorSha256: sha256(fileURLToPath(import.meta.url)),
    externalDecode: {
      ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
      command:
        'ffmpeg -v error -noautorotate -i SOURCE -vf FILTER -frames:v 1 -f rawvideo -pix_fmt rgba pipe:1',
      photoFilter: 'crop=2736:1824:0:0,scale=559:401:flags=bicubic',
      photoDetailFilter: 'crop=1200:900:3600:2300,scale=337:247:flags=bicubic',
      videoFilter: 'select=eq(n\\,FRAME),scale=528:296:flags=bicubic',
    },
    fixtures: entries.map((item) => {
      const { pixels, ...details } = generateV7Fixture(item.id, paths);
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
      v7Manifest({
        ...(value('--fresh-photo') ? { freshPhoto: value('--fresh-photo')! } : {}),
        ...(value('--video') ? { video: value('--video')! } : {}),
      }),
      null,
      2
    )}\n`
  );
}
