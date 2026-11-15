/** Prospective corrected-v12 source-only fixtures. Never read codec output here. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXTERNAL_SOURCES, QUALITIES, type FixtureSpec } from './owned-vp8-v2-fixtures.ts';
import type { V4SourcePaths } from './owned-vp8-v4-fixtures.ts';

export type V12SourcePaths = V4SourcePaths & { forestPhoto?: string; nightPhoto?: string };
export type V12FixtureSpec = Omit<FixtureSpec, 'layout' | 'source'> & {
  layout: FixtureSpec['layout'] | 'RGB24';
  source: 'generated' | 'forest-photo' | 'night-photo' | 'video';
};
export type V12PixelFixture = V12FixtureSpec & { stride: number; pixels: Uint8Array };

export const V12_PHOTOS = {
  forest: {
    name: 'Image of a forest.jpg',
    page: 'https://commons.wikimedia.org/wiki/File:Image_of_a_forest.jpg',
    revision:
      'https://commons.wikimedia.org/w/index.php?title=File:Image_of_a_forest.jpg&oldid=1270624296',
    download: 'https://upload.wikimedia.org/wikipedia/commons/a/af/Image_of_a_forest.jpg',
    license: 'CC0-1.0',
    author: 'Akum20',
    originalWidth: 4160,
    originalHeight: 3120,
    bytes: 3_384_891,
    sha1: 'f89d802d8f72eebd30f31487d96c374ec4a7fb95',
    sha256: 'fad0d6b48507ac4d6792430a01470b60f926aae1ab8097ae85d8bea55d036819',
  },
  night: {
    name: 'Long exposure of urban cityscape at night.jpg',
    page: 'https://commons.wikimedia.org/wiki/File:Long_exposure_of_urban_cityscape_at_night.jpg',
    revision:
      'https://commons.wikimedia.org/w/index.php?title=File:Long_exposure_of_urban_cityscape_at_night.jpg&oldid=701678803',
    download:
      'https://upload.wikimedia.org/wikipedia/commons/c/c8/Long_exposure_of_urban_cityscape_at_night.jpg',
    license: 'CC0-1.0',
    author: 'Peng LIU',
    originalWidth: 1734,
    originalHeight: 1158,
    bytes: 996_324,
    sha1: 'b9d846e178a22fdae4de8f3e9cf0e1fd1b2919b3',
    sha256: '38dbe09d4a50885a7a824d6a07fc0a455d67a311128f410a05cf8b5702e65eda',
  },
} as const;

export const V12_PHOTO_REGIONS = {
  forest: {
    primary: { x: 240, y: 180, width: 1500, height: 1250 },
    detail: { x: 2200, y: 1000, width: 1300, height: 1600 },
  },
  night: {
    primary: { x: 100, y: 100, width: 650, height: 900 },
    detail: { x: 950, y: 100, width: 650, height: 900 },
  },
} as const;

const VIDEO_BYTES = 3_145_371;
const MAX_PIXELS = 10_066_329;
const NOISE_SEED = 0x501c912b;

function spec(
  id: string,
  split: 'tuning' | 'held-out',
  kind: string,
  width: number,
  height: number,
  layout: V12FixtureSpec['layout'] = 'RGBA',
  source: 'generated' | 'forest-photo' | 'night-photo' | 'video' = 'generated',
  frame?: number,
  repeatOf?: string
): V12FixtureSpec {
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

export const V12_HELDOUT: readonly V12FixtureSpec[] = [
  spec('fresh12-gray', 'held-out', 'grayscale', 587, 341),
  spec('fresh12-gradient', 'held-out', 'gradient', 459, 319),
  spec('fresh12-chroma-edge', 'held-out', 'chroma', 447, 311),
  spec('fresh12-text', 'held-out', 'text', 503, 347),
  spec('fresh12-noise', 'held-out', 'noise', 367, 269),
  spec('fresh12-tiny-7x3', 'held-out', 'tiny', 7, 3),
  spec('fresh12-tiny-2x15', 'held-out', 'tiny', 2, 15),
  spec('fresh12-one-column', 'held-out', 'odd', 1, 401),
  spec('fresh12-one-row', 'held-out', 'odd', 397, 1),
  spec('fresh12-large-admitted', 'held-out', 'large', 3997, 2517),
  spec('fresh12-bgra', 'held-out', 'layout', 331, 211, 'BGRA'),
  spec('fresh12-padded-rgba', 'held-out', 'padded-stride', 339, 207),
  spec('fresh12-packed-rgb24', 'held-out', 'packed-layout', 343, 213, 'RGB24'),
  spec('fresh12-forest', 'held-out', 'photograph-forest', 463, 587, 'RGBA', 'forest-photo'),
  spec(
    'fresh12-forest-detail',
    'held-out',
    'photograph-forest-detail',
    307,
    391,
    'RGBA',
    'forest-photo'
  ),
  spec('fresh12-night', 'held-out', 'photograph-night', 421, 281, 'RGBA', 'night-photo'),
  spec(
    'fresh12-night-detail',
    'held-out',
    'photograph-night-detail',
    389,
    263,
    'RGBA',
    'night-photo'
  ),
  spec('fresh12-video-37', 'held-out', 'video', 548, 308, 'RGBA', 'video', 37),
  spec('fresh12-video-157', 'held-out', 'video', 548, 308, 'RGBA', 'video', 157),
  spec(
    'fresh12-duplicate-hold',
    'held-out',
    'duplicate-hold',
    548,
    308,
    'RGBA',
    'video',
    37,
    'fresh12-video-37'
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
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '10001', '01110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function textPixel(x: number, y: number): boolean {
  const scale = 8;
  const col = Math.floor((x - 73) / scale);
  const row = Math.floor((y - 117) / scale);
  if (col < 0 || row < 0 || row >= 7) return false;
  const letter = Math.floor(col / 6);
  const within = col % 6;
  const glyph = GLYPHS['FRESH 12'[letter] ?? ' '];
  return within < 5 && glyph?.[row]?.[within] === '1';
}

function generated(item: V12FixtureSpec): Uint8Array {
  const { id, width, height, layout } = item;
  const stride = width * (layout === 'RGB24' ? 3 : 4) + (id === 'fresh12-padded-rgba' ? 44 : 0);
  const bytes = new Uint8Array(stride * height);
  if (id === 'fresh12-padded-rgba') bytes.fill(0x73);
  let seed = NOISE_SEED;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      let rgb: readonly number[];
      switch (id) {
        case 'fresh12-gray': {
          const value = (31 * x + 53 * y + ((13 * x * y) % 101)) & 255;
          rgb = [value, value, value];
          break;
        }
        case 'fresh12-gradient':
          rgb = [
            Math.floor((255 * (11 * x + 3 * y)) / (11 * (width - 1) + 3 * (height - 1))),
            Math.floor(
              (255 * (7 * (width - 1 - x) + 11 * y)) / (7 * (width - 1) + 11 * (height - 1))
            ),
            Math.floor(
              (255 * (5 * (height - 1 - y) + 13 * x)) / (5 * (height - 1) + 13 * (width - 1))
            ),
          ];
          break;
        case 'fresh12-chroma-edge':
          rgb = Math.floor((17 * x + 23 * y) / 31) & 1 ? [237, 51, 163] : [43, 211, 91];
          break;
        case 'fresh12-text':
          rgb = textPixel(x, y)
            ? [231, 173, 107]
            : [43 + ((x >> 3) & 47), 61 + ((y >> 3) & 39), 83];
          break;
        case 'fresh12-noise':
          rgb = [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255];
          break;
        case 'fresh12-tiny-7x3':
          rgb = [
            (59 + 41 * x + 79 * y) & 255,
            (173 + 71 * x + 37 * y) & 255,
            (83 + 29 * x + 97 * y) & 255,
          ];
          break;
        case 'fresh12-tiny-2x15':
          rgb =
            (13 * x + 5 * y) % 4 === 0
              ? [211, 73, 157]
              : (5 * x + y) & 1
                ? [77, 223, 139]
                : [127, 101, 193];
          break;
        case 'fresh12-one-column':
          rgb = [(43 * y + 31) & 255, (71 * y + 47) & 255, (37 * y + 17) & 255];
          break;
        case 'fresh12-one-row':
          rgb = [(47 * x + 23) & 255, (59 * x + 53) & 255, (83 * x + 19) & 255];
          break;
        case 'fresh12-large-admitted':
          rgb = [
            (((13 * x) >> 7) + ((19 * y) >> 6)) & 255,
            ((17 * x + 7 * y) >> 6) & 255,
            (((23 * x) ^ (11 * y)) >> 7) & 255,
          ];
          break;
        case 'fresh12-bgra':
        case 'fresh12-padded-rgba':
        case 'fresh12-packed-rgb24':
          rgb = [(53 * x + 37 * y) & 255, (41 * x + 47 * y) & 255, (71 * x + 29 * y) & 255];
          break;
        default:
          throw new Error(`Unknown corrected-v12 generator: ${id}`);
      }
      const at = y * stride + x * (layout === 'RGB24' ? 3 : 4);
      bytes.set(
        layout === 'RGB24'
          ? [rgb[0]!, rgb[1]!, rgb[2]!]
          : layout === 'BGRA' || layout === 'BGRX'
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

export function generateV12Fixture(id: string, paths: V12SourcePaths = {}): V12PixelFixture {
  const item = V12_HELDOUT.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown corrected-v12 fixture: ${id}`);
  let pixels: Uint8Array;
  if (item.source === 'generated') pixels = generated(item);
  else {
    const forest = item.source === 'forest-photo';
    const night = item.source === 'night-photo';
    const photo = forest || night;
    const photoSource = forest ? V12_PHOTOS.forest : V12_PHOTOS.night;
    const path = forest ? paths.forestPhoto : night ? paths.nightPhoto : paths.video;
    if (!path)
      throw new Error(
        `Missing ${forest ? 'forest photo' : night ? 'night photo' : 'video'} source for ${id}`
      );
    checkedSource(
      path,
      photo ? photoSource.bytes : VIDEO_BYTES,
      photo ? photoSource.sha256 : EXTERNAL_SOURCES.video.sha256,
      photo ? item.source : 'video',
      photo ? photoSource.sha1 : undefined
    );
    const region = forest
      ? item.id === 'fresh12-forest-detail'
        ? V12_PHOTO_REGIONS.forest.detail
        : V12_PHOTO_REGIONS.forest.primary
      : item.id === 'fresh12-night-detail'
        ? V12_PHOTO_REGIONS.night.detail
        : V12_PHOTO_REGIONS.night.primary;
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
  const stride =
    item.width * (item.layout === 'RGB24' ? 3 : 4) + (item.id === 'fresh12-padded-rgba' ? 44 : 0);
  if (item.layout === 'RGBA' || item.layout === 'BGRA') {
    for (let y = 0; y < item.height; y++)
      for (let x = 0; x < item.width; x++)
        assert.equal(pixels[y * stride + x * 4 + 3], 255, `${id} has nonopaque visible alpha`);
  }
  return { ...item, stride, pixels };
}

export function v12Manifest(paths: V12SourcePaths): object {
  const entries = V12_HELDOUT;
  assert.equal(V12_HELDOUT.length, 20);
  assert.equal(new Set(entries.map((item) => item.id)).size, entries.length);
  for (const name of ['forest', 'night'] as const) {
    const photo = V12_PHOTOS[name];
    const { primary, detail } = V12_PHOTO_REGIONS[name];
    for (const region of [primary, detail]) {
      assert.ok(region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0);
      assert.ok(region.x + region.width <= photo.originalWidth);
      assert.ok(region.y + region.height <= photo.originalHeight);
    }
    assert.ok(
      primary.x + primary.width <= detail.x ||
        detail.x + detail.width <= primary.x ||
        primary.y + primary.height <= detail.y ||
        detail.y + detail.height <= primary.y,
      'Photograph source regions must not overlap'
    );
  }
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
    cohort: 'corrected-v12',
    purpose:
      'Prospective source-only fresh held-out inputs; v1-v11 remain exposed regression evidence',
    tuningBasis: 'No new tuning entries; the existing 15 tuning fixtures stay exposed controls',
    pixelConvention: {
      stride:
        'width * 4, except packed RGB24 uses width * 3 and fresh12-padded-rgba uses width * 4 + 44 with 0x73 padding',
      rgba: 'R,G,B,A with A=255',
      bgra: 'B,G,R,A with A=255',
      rgb24: 'packed R,G,B bytes with no alpha or row padding',
      visibleOpaque: 'RGBA and BGRA visible alpha bytes equal 255',
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
      forestPhotoBytes: V12_PHOTOS.forest.bytes,
      nightPhotoBytes: V12_PHOTOS.night.bytes,
      videoBytes: VIDEO_BYTES,
    },
    sources: {
      photos: V12_PHOTOS,
      photoRegions: V12_PHOTO_REGIONS,
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
      correctedV10: sha256(resolve(root, 'docs/experiments/501-owned-vp8-v10-fixtures.json')),
      correctedV11: sha256(resolve(root, 'docs/experiments/501-owned-vp8-v11-fixtures.json')),
    },
    generator: 'scripts/test/owned-vp8-v12-fixtures.ts; source-only generation, no codec outputs',
    generatorSha256: sha256(fileURLToPath(import.meta.url)),
    externalDecode: {
      ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
      command:
        'ffmpeg -v error -noautorotate -i SOURCE -vf FILTER -frames:v 1 -f rawvideo -pix_fmt rgba pipe:1',
      forestFilter: 'crop=1500:1250:240:180,scale=463:587:flags=bicubic',
      forestDetailFilter: 'crop=1300:1600:2200:1000,scale=307:391:flags=bicubic',
      nightFilter: 'crop=650:900:100:100,scale=421:281:flags=bicubic',
      nightDetailFilter: 'crop=650:900:950:100,scale=389:263:flags=bicubic',
      videoFilter: 'select=eq(n\\,FRAME),scale=548:308:flags=bicubic',
    },
    fixtures: entries.map((item) => {
      const { pixels, ...details } = generateV12Fixture(item.id, paths);
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
      v12Manifest({
        ...(value('--forest-photo') ? { forestPhoto: value('--forest-photo')! } : {}),
        ...(value('--night-photo') ? { nightPhoto: value('--night-photo')! } : {}),
        ...(value('--video') ? { video: value('--video')! } : {}),
      }),
      null,
      2
    )}\n`
  );
}
