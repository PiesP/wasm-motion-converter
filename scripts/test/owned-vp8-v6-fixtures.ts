/** Prospective corrected-v6 source-only fixtures. Never read codec output here. */
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

export type V6SourcePaths = V4SourcePaths;

export const V6_PHOTO = {
  name: 'New York City street.JPG',
  page: 'https://commons.wikimedia.org/wiki/File:New_York_City_street.JPG',
  revision:
    'https://commons.wikimedia.org/w/index.php?title=File:New_York_City_street.JPG&oldid=1171437687',
  download: 'https://upload.wikimedia.org/wikipedia/commons/4/4c/New_York_City_street.JPG',
  license: 'CC0-1.0',
  author: 'Alanthebox',
  originalWidth: 4976,
  originalHeight: 2800,
  bytes: 2_027_520,
  sha1: '9f5318f50ba66e8476e5ebb7e2757c19f6abaebd',
  sha256: 'e5a22baa15ee2502af013a0974550d27885044d481e2dff6088018392e840e55',
} as const;

export const V6_PHOTO_REGIONS = {
  primary: { x: 0, y: 0, width: 2488, height: 1400 },
  detail: { x: 3500, y: 1700, width: 1200, height: 800 },
} as const;

const VIDEO_BYTES = 3_145_371;
const MAX_PIXELS = 10_066_329;
const NOISE_SEED = 0x50162026;

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

export const V6_HELDOUT: readonly FixtureSpec[] = [
  spec('fresh6-gray', 'held-out', 'grayscale', 509, 307),
  spec('fresh6-gradient', 'held-out', 'gradient', 401, 281),
  spec('fresh6-chroma-edge', 'held-out', 'chroma', 373, 263),
  spec('fresh6-text', 'held-out', 'text', 431, 293),
  spec('fresh6-noise', 'held-out', 'noise', 307, 211),
  spec('fresh6-tiny-1x9', 'held-out', 'tiny', 1, 9),
  spec('fresh6-tiny-3x7', 'held-out', 'tiny', 3, 7),
  spec('fresh6-tiny-9x1', 'held-out', 'tiny', 9, 1),
  spec('fresh6-one-column', 'held-out', 'odd', 1, 337),
  spec('fresh6-one-row', 'held-out', 'odd', 347, 1),
  spec('fresh6-large-admitted', 'held-out', 'large', 4080, 2467),
  spec('fresh6-bgra', 'held-out', 'layout', 281, 157, 'BGRA'),
  spec('fresh6-rgbx', 'held-out', 'layout', 281, 157, 'RGBX'),
  spec('fresh6-photo', 'held-out', 'photograph', 547, 389, 'RGBA', 'photo'),
  spec('fresh6-photo-detail', 'held-out', 'photograph-detail', 331, 241, 'RGBA', 'photo'),
  spec('fresh6-video-32', 'held-out', 'video', 512, 288, 'RGBA', 'video', 32),
  spec('fresh6-video-181', 'held-out', 'video', 512, 288, 'RGBA', 'video', 181),
  spec(
    'fresh6-duplicate-hold',
    'held-out',
    'duplicate-hold',
    512,
    288,
    'RGBA',
    'video',
    32,
    'fresh6-video-32'
  ),
];

const GLYPHS: Record<string, readonly string[]> = {
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  '6': ['01111', '10000', '10000', '11110', '10001', '10001', '01110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function textPixel(x: number, y: number): boolean {
  const scale = 7;
  const col = Math.floor((x - 41) / scale);
  const row = Math.floor((y - 83) / scale);
  if (col < 0 || row < 0 || row >= 7) return false;
  const letter = Math.floor(col / 6);
  const within = col % 6;
  const glyph = GLYPHS['FRESH 6'[letter] ?? ' '];
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
        case 'fresh6-gray': {
          const value = (23 * x + 31 * y + ((x * y) % 67)) & 255;
          rgb = [value, value, value];
          break;
        }
        case 'fresh6-gradient':
          rgb = [
            Math.floor((255 * (3 * x + 2 * y)) / (3 * (width - 1) + 2 * (height - 1))),
            Math.floor((255 * (2 * (width - 1 - x) + y)) / (2 * (width - 1) + height - 1)),
            Math.floor(
              (255 * (3 * (height - 1 - y) + 2 * x)) / (3 * (height - 1) + 2 * (width - 1))
            ),
          ];
          break;
        case 'fresh6-chroma-edge':
          rgb = Math.floor((5 * x + 9 * y) / 13) & 1 ? [225, 42, 201] : [18, 231, 57];
          break;
        case 'fresh6-text':
          rgb = textPixel(x, y) ? [252, 176, 48] : [21 + ((x >> 4) & 31), 49 + ((y >> 4) & 15), 81];
          break;
        case 'fresh6-noise':
          rgb = [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255];
          break;
        case 'fresh6-tiny-1x9':
          rgb = [
            (43 + 59 * x + 73 * y) & 255,
            (197 + 61 * x + 29 * y) & 255,
            (27 + 17 * x + 83 * y) & 255,
          ];
          break;
        case 'fresh6-tiny-3x7':
          rgb =
            (2 * x + y) % 3 === 0
              ? [232, 34, 184]
              : (x + 3 * y) & 1
                ? [42, 201, 97]
                : [81, 53, 226];
          break;
        case 'fresh6-tiny-9x1':
          rgb = [
            (31 + 47 * x + 37 * y + 13 * x * y) & 255,
            (181 + 23 * x + 71 * y) & 255,
            (53 + 67 * x + 43 * y) & 255,
          ];
          break;
        case 'fresh6-one-column':
          rgb = [(29 * y + 11) & 255, (37 * y + 19) & 255, (13 * y + 7) & 255];
          break;
        case 'fresh6-one-row':
          rgb = [(41 * x + 17) & 255, (19 * x + 31) & 255, (59 * x + 5) & 255];
          break;
        case 'fresh6-large-admitted':
          rgb = [
            ((x >> 3) + ((5 * y) >> 6)) & 255,
            ((3 * x + 7 * y) >> 7) & 255,
            (((5 * x) ^ (3 * y)) >> 6) & 255,
          ];
          break;
        case 'fresh6-bgra':
        case 'fresh6-rgbx':
          rgb = [(37 * x + 23 * y) & 255, (17 * x + 43 * y) & 255, (53 * x + 11 * y) & 255];
          break;
        default:
          throw new Error(`Unknown corrected-v6 generator: ${id}`);
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

export function generateV6Fixture(id: string, paths: V6SourcePaths = {}): PixelFixture {
  const item = V6_HELDOUT.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown corrected-v6 fixture: ${id}`);
  let pixels: Uint8Array;
  if (item.source === 'generated') pixels = generated(item);
  else {
    const photo = item.source === 'photo';
    const path = photo ? paths.freshPhoto : paths.video;
    if (!path) throw new Error(`Missing ${photo ? 'fresh photo' : 'video'} source for ${id}`);
    checkedSource(
      path,
      photo ? V6_PHOTO.bytes : VIDEO_BYTES,
      photo ? V6_PHOTO.sha256 : EXTERNAL_SOURCES.video.sha256,
      photo ? 'fresh photo' : 'video'
    );
    const region =
      item.id === 'fresh6-photo-detail' ? V6_PHOTO_REGIONS.detail : V6_PHOTO_REGIONS.primary;
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

export function v6Manifest(paths: V6SourcePaths): object {
  const entries = V6_HELDOUT;
  assert.equal(V6_HELDOUT.length, 18);
  assert.equal(new Set(entries.map((item) => item.id)).size, entries.length);
  const [primary, detail] = [V6_PHOTO_REGIONS.primary, V6_PHOTO_REGIONS.detail];
  for (const region of [primary, detail]) {
    assert.ok(region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0);
    assert.ok(region.x + region.width <= V6_PHOTO.originalWidth);
    assert.ok(region.y + region.height <= V6_PHOTO.originalHeight);
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
    cohort: 'corrected-v6',
    purpose:
      'Prospective source-only fresh held-out inputs; v1-v5 remain exposed regression evidence',
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
      photoBytes: V6_PHOTO.bytes,
      videoBytes: VIDEO_BYTES,
    },
    sources: {
      photo: V6_PHOTO,
      photoRegions: V6_PHOTO_REGIONS,
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
    },
    generator: 'scripts/test/owned-vp8-v6-fixtures.ts; source-only generation, no codec outputs',
    generatorSha256: sha256(fileURLToPath(import.meta.url)),
    externalDecode: {
      ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
      command:
        'ffmpeg -v error -noautorotate -i SOURCE -vf FILTER -frames:v 1 -f rawvideo -pix_fmt rgba pipe:1',
      photoFilter: 'crop=2488:1400:0:0,scale=547:389:flags=bicubic',
      photoDetailFilter: 'crop=1200:800:3500:1700,scale=331:241:flags=bicubic',
      videoFilter: 'select=eq(n\\,FRAME),scale=512:288:flags=bicubic',
    },
    fixtures: entries.map((item) => {
      const { pixels, ...details } = generateV6Fixture(item.id, paths);
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
      v6Manifest({
        ...(value('--fresh-photo') ? { freshPhoto: value('--fresh-photo')! } : {}),
        ...(value('--video') ? { video: value('--video')! } : {}),
      }),
      null,
      2
    )}\n`
  );
}
