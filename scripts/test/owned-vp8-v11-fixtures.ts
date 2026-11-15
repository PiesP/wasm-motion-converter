/** Prospective corrected-v11 source-only fixtures. Never read codec output here. */
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

export type V11SourcePaths = V4SourcePaths;

export const V11_PHOTO = {
  name: '20190831 Montagne.jpg',
  page: 'https://commons.wikimedia.org/wiki/File:20190831_Montagne.jpg',
  revision:
    'https://commons.wikimedia.org/w/index.php?title=File:20190831_Montagne.jpg&oldid=850548619',
  download: 'https://upload.wikimedia.org/wikipedia/commons/2/28/20190831_Montagne.jpg',
  license: 'CC0-1.0',
  author: 'Gb89.2',
  originalWidth: 5152,
  originalHeight: 3864,
  bytes: 3_797_100,
  sha1: '0d8423320e903f65d44bb1c93746a2bd9bdd2719',
  sha256: '7e3d85269a6d4178c6af24b30c6132b2b3744aed50d8737658fa29e680c156a8',
} as const;

export const V11_PHOTO_REGIONS = {
  primary: { x: 300, y: 250, width: 1500, height: 1300 },
  detail: { x: 2500, y: 700, width: 1250, height: 1600 },
} as const;

const VIDEO_BYTES = 3_145_371;
const MAX_PIXELS = 10_066_329;
const NOISE_SEED = 0x501b7d29;

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

export const V11_HELDOUT: readonly FixtureSpec[] = [
  spec('fresh11-gray', 'held-out', 'grayscale', 571, 323),
  spec('fresh11-gradient', 'held-out', 'gradient', 443, 307),
  spec('fresh11-chroma-edge', 'held-out', 'chroma', 433, 293),
  spec('fresh11-text', 'held-out', 'text', 491, 331),
  spec('fresh11-noise', 'held-out', 'noise', 353, 257),
  spec('fresh11-tiny-5x9', 'held-out', 'tiny', 5, 9),
  spec('fresh11-tiny-13x2', 'held-out', 'tiny', 13, 2),
  spec('fresh11-one-column', 'held-out', 'odd', 1, 389),
  spec('fresh11-one-row', 'held-out', 'odd', 383, 1),
  spec('fresh11-large-admitted', 'held-out', 'large', 4001, 2515),
  spec('fresh11-bgra', 'held-out', 'layout', 317, 197, 'BGRA'),
  spec('fresh11-rgbx', 'held-out', 'layout', 317, 197, 'RGBX'),
  spec('fresh11-bgrx', 'held-out', 'layout', 317, 197, 'BGRX'),
  spec('fresh11-padded-rgba', 'held-out', 'padded-stride', 325, 191),
  spec('fresh11-packed-rgb24', 'held-out', 'packed-layout', 329, 199, 'RGB24'),
  spec('fresh11-photo', 'held-out', 'photograph', 463, 587, 'RGBA', 'photo'),
  spec('fresh11-photo-detail', 'held-out', 'photograph-detail', 307, 391, 'RGBA', 'photo'),
  spec('fresh11-video-111', 'held-out', 'video', 536, 302, 'RGBA', 'video', 111),
  spec('fresh11-video-171', 'held-out', 'video', 536, 302, 'RGBA', 'video', 171),
  spec(
    'fresh11-duplicate-hold',
    'held-out',
    'duplicate-hold',
    536,
    302,
    'RGBA',
    'video',
    111,
    'fresh11-video-111'
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
  const glyph = GLYPHS['FRESH 11'[letter] ?? ' '];
  return within < 5 && glyph?.[row]?.[within] === '1';
}

function generated(item: FixtureSpec): Uint8Array {
  const { id, width, height, layout } = item;
  const stride = width * (layout === 'RGB24' ? 3 : 4) + (id === 'fresh11-padded-rgba' ? 36 : 0);
  const bytes = new Uint8Array(stride * height);
  if (id === 'fresh11-padded-rgba') bytes.fill(0x6d);
  let seed = NOISE_SEED;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      let rgb: readonly number[];
      switch (id) {
        case 'fresh11-gray': {
          const value = (29 * x + 47 * y + ((11 * x * y) % 97)) & 255;
          rgb = [value, value, value];
          break;
        }
        case 'fresh11-gradient':
          rgb = [
            Math.floor((255 * (7 * x + 5 * y)) / (7 * (width - 1) + 5 * (height - 1))),
            Math.floor(
              (255 * (3 * (width - 1 - x) + 5 * y)) / (3 * (width - 1) + 5 * (height - 1))
            ),
            Math.floor(
              (255 * (9 * (height - 1 - y) + 4 * x)) / (9 * (height - 1) + 4 * (width - 1))
            ),
          ];
          break;
        case 'fresh11-chroma-edge':
          rgb = Math.floor((13 * x + 19 * y) / 29) & 1 ? [219, 42, 177] : [57, 203, 71];
          break;
        case 'fresh11-text':
          rgb = textPixel(x, y) ? [226, 188, 91] : [37 + ((x >> 2) & 39), 55 + ((y >> 4) & 31), 79];
          break;
        case 'fresh11-noise':
          rgb = [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255];
          break;
        case 'fresh11-tiny-5x9':
          rgb = [
            (53 + 37 * x + 71 * y) & 255,
            (167 + 67 * x + 31 * y) & 255,
            (71 + 23 * x + 89 * y) & 255,
          ];
          break;
        case 'fresh11-tiny-13x2':
          rgb =
            (11 * x + 3 * y) % 4 === 0
              ? [223, 67, 149]
              : (3 * x + y) & 1
                ? [69, 211, 127]
                : [119, 91, 201];
          break;
        case 'fresh11-one-column':
          rgb = [(37 * y + 29) & 255, (67 * y + 41) & 255, (31 * y + 11) & 255];
          break;
        case 'fresh11-one-row':
          rgb = [(41 * x + 19) & 255, (53 * x + 47) & 255, (79 * x + 13) & 255];
          break;
        case 'fresh11-large-admitted':
          rgb = [
            (((11 * x) >> 7) + ((17 * y) >> 6)) & 255,
            ((13 * x + 5 * y) >> 6) & 255,
            (((19 * x) ^ (7 * y)) >> 7) & 255,
          ];
          break;
        case 'fresh11-bgra':
        case 'fresh11-rgbx':
        case 'fresh11-bgrx':
        case 'fresh11-padded-rgba':
        case 'fresh11-packed-rgb24':
          rgb = [(47 * x + 31 * y) & 255, (37 * x + 43 * y) & 255, (67 * x + 23 * y) & 255];
          break;
        default:
          throw new Error(`Unknown corrected-v11 generator: ${id}`);
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

export function generateV11Fixture(id: string, paths: V11SourcePaths = {}): PixelFixture {
  const item = V11_HELDOUT.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown corrected-v11 fixture: ${id}`);
  let pixels: Uint8Array;
  if (item.source === 'generated') pixels = generated(item);
  else {
    const photo = item.source === 'photo';
    const path = photo ? paths.freshPhoto : paths.video;
    if (!path) throw new Error(`Missing ${photo ? 'fresh photo' : 'video'} source for ${id}`);
    checkedSource(
      path,
      photo ? V11_PHOTO.bytes : VIDEO_BYTES,
      photo ? V11_PHOTO.sha256 : EXTERNAL_SOURCES.video.sha256,
      photo ? 'fresh photo' : 'video',
      photo ? V11_PHOTO.sha1 : undefined
    );
    const region =
      item.id === 'fresh11-photo-detail' ? V11_PHOTO_REGIONS.detail : V11_PHOTO_REGIONS.primary;
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
    item.width * (item.layout === 'RGB24' ? 3 : 4) + (item.id === 'fresh11-padded-rgba' ? 36 : 0);
  if (item.layout === 'RGBA' || item.layout === 'BGRA') {
    for (let y = 0; y < item.height; y++)
      for (let x = 0; x < item.width; x++)
        assert.equal(pixels[y * stride + x * 4 + 3], 255, `${id} has nonopaque visible alpha`);
  }
  return { ...item, stride, pixels };
}

export function v11Manifest(paths: V11SourcePaths): object {
  const entries = V11_HELDOUT;
  assert.equal(V11_HELDOUT.length, 20);
  assert.equal(new Set(entries.map((item) => item.id)).size, entries.length);
  const [primary, detail] = [V11_PHOTO_REGIONS.primary, V11_PHOTO_REGIONS.detail];
  for (const region of [primary, detail]) {
    assert.ok(region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0);
    assert.ok(region.x + region.width <= V11_PHOTO.originalWidth);
    assert.ok(region.y + region.height <= V11_PHOTO.originalHeight);
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
    cohort: 'corrected-v11',
    purpose:
      'Prospective source-only fresh held-out inputs; v1-v10 remain exposed regression evidence',
    tuningBasis: 'No new tuning entries; the existing 15 tuning fixtures stay exposed controls',
    pixelConvention: {
      stride:
        'width * 4, except packed RGB24 uses width * 3 and fresh11-padded-rgba uses width * 4 + 36 with 0x6d padding',
      rgba: 'R,G,B,A with A=255',
      bgra: 'B,G,R,A with A=255',
      rgbx: 'R,G,B,X with deterministic seeded X bytes ignored by RGB comparison',
      bgrx: 'B,G,R,X with deterministic seeded X bytes ignored by RGB comparison',
      rgb24: 'packed R,G,B bytes with no alpha or row padding',
      visibleOpaque:
        'RGBA and BGRA visible alpha bytes equal 255; RGBX and BGRX X bytes are ignored',
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
      photoBytes: V11_PHOTO.bytes,
      videoBytes: VIDEO_BYTES,
    },
    sources: {
      photo: V11_PHOTO,
      photoRegions: V11_PHOTO_REGIONS,
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
    },
    generator: 'scripts/test/owned-vp8-v11-fixtures.ts; source-only generation, no codec outputs',
    generatorSha256: sha256(fileURLToPath(import.meta.url)),
    externalDecode: {
      ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
      command:
        'ffmpeg -v error -noautorotate -i SOURCE -vf FILTER -frames:v 1 -f rawvideo -pix_fmt rgba pipe:1',
      photoFilter: 'crop=1500:1300:300:250,scale=463:587:flags=bicubic',
      photoDetailFilter: 'crop=1250:1600:2500:700,scale=307:391:flags=bicubic',
      videoFilter: 'select=eq(n\\,FRAME),scale=536:302:flags=bicubic',
    },
    fixtures: entries.map((item) => {
      const { pixels, ...details } = generateV11Fixture(item.id, paths);
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
      v11Manifest({
        ...(value('--fresh-photo') ? { freshPhoto: value('--fresh-photo')! } : {}),
        ...(value('--video') ? { video: value('--video')! } : {}),
      }),
      null,
      2
    )}\n`
  );
}
