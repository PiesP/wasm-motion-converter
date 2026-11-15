/** Prospective corrected-v4 source-only fixtures. Never read codec output here. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CorrectionSourcePaths } from './owned-vp8-v2-correction-fixtures.ts';
import {
  EXTERNAL_SOURCES,
  QUALITIES,
  type FixtureSpec,
  type PixelFixture,
} from './owned-vp8-v2-fixtures.ts';

export type V4SourcePaths = CorrectionSourcePaths & { freshPhoto?: string };

export const V4_PHOTO = {
  name: 'Landscape with clouds.jpg',
  page: 'https://commons.wikimedia.org/wiki/File:Landscape_with_clouds.jpg',
  revision:
    'https://commons.wikimedia.org/w/index.php?title=File:Landscape_with_clouds.jpg&oldid=1048543422',
  download: 'https://upload.wikimedia.org/wikipedia/commons/8/83/Landscape_with_clouds.jpg',
  license: 'CC0-1.0',
  author: 'Aammell',
  originalWidth: 4000,
  originalHeight: 3000,
  bytes: 399_226,
  sha256: 'd266b5bfa1179a6298f1c084e8c539ef81698643f7c45d9adb34d43a30ed2758',
} as const;

const VIDEO_BYTES = 3_145_371;
const MAX_PIXELS = 10_066_329;
const NOISE_SEED = 0x50142026;

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

export const V4_HELDOUT: readonly FixtureSpec[] = [
  spec('fresh4-gray', 'held-out', 'grayscale', 491, 307),
  spec('fresh4-gradient', 'held-out', 'gradient', 383, 271),
  spec('fresh4-chroma-edge', 'held-out', 'chroma', 359, 251),
  spec('fresh4-text', 'held-out', 'text', 409, 293),
  spec('fresh4-noise', 'held-out', 'noise', 307, 191),
  spec('fresh4-tiny', 'held-out', 'tiny', 2, 5),
  spec('fresh4-one-column', 'held-out', 'odd', 1, 307),
  spec('fresh4-one-row', 'held-out', 'odd', 313, 1),
  spec('fresh4-large-admitted', 'held-out', 'large', 4032, 2496),
  spec('fresh4-bgrx', 'held-out', 'layout', 281, 149, 'BGRX'),
  spec('fresh4-rgbx', 'held-out', 'layout', 281, 149, 'RGBX'),
  spec('fresh4-photo', 'held-out', 'photograph', 521, 347, 'RGBA', 'photo'),
  spec('fresh4-video-73', 'held-out', 'video', 504, 282, 'RGBA', 'video', 73),
  spec('fresh4-video-169', 'held-out', 'video', 504, 282, 'RGBA', 'video', 169),
  spec(
    'fresh4-duplicate-hold',
    'held-out',
    'duplicate-hold',
    504,
    282,
    'RGBA',
    'video',
    73,
    'fresh4-video-73'
  ),
];

const GLYPHS: Record<string, readonly string[]> = {
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  '4': ['10010', '00001', '00001', '01110', '00001', '00001', '11110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function textPixel(x: number, y: number): boolean {
  const scale = 5;
  const col = Math.floor((x - 27) / scale);
  const row = Math.floor((y - 103) / scale);
  if (col < 0 || row < 0 || row >= 7) return false;
  const letter = Math.floor(col / 6);
  const within = col % 6;
  const glyph = GLYPHS['FRESH 4'[letter] ?? ' '];
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
        case 'fresh4-gray': {
          const value = (17 * x + 31 * y + ((x * y) % 53)) & 255;
          rgb = [value, value, value];
          break;
        }
        case 'fresh4-gradient':
          rgb = [
            Math.floor((255 * (width - 1 - x)) / (width - 1)),
            Math.floor((255 * y) / (height - 1)),
            Math.floor((255 * (7 * x + 4 * y)) / (7 * (width - 1) + 4 * (height - 1))),
          ];
          break;
        case 'fresh4-chroma-edge':
          rgb = Math.floor((5 * x + 2 * y) / 9) & 1 ? [244, 36, 73] : [17, 210, 231];
          break;
        case 'fresh4-text':
          rgb = textPixel(x, y) ? [251, 192, 41] : [18 + ((x >> 4) & 15), 30 + ((y >> 5) & 15), 63];
          break;
        case 'fresh4-noise':
          rgb = [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255];
          break;
        case 'fresh4-tiny':
          rgb = [
            (53 + 71 * x + 19 * y) & 255,
            (178 + 23 * x + 37 * y) & 255,
            (89 + 61 * x + 17 * y) & 255,
          ];
          break;
        case 'fresh4-one-column':
          rgb = [(13 * y) & 255, (41 * y) & 255, (7 * y) & 255];
          break;
        case 'fresh4-one-row':
          rgb = [(29 * x) & 255, (11 * x) & 255, (47 * x) & 255];
          break;
        case 'fresh4-large-admitted':
          rgb = [((x >> 4) + (y >> 3)) & 255, ((5 * x + y) >> 7) & 255, ((x ^ (5 * y)) >> 5) & 255];
          break;
        case 'fresh4-bgrx':
        case 'fresh4-rgbx':
          rgb = [(23 * x + 13 * y) & 255, (11 * x + 29 * y) & 255, (37 * x + 5 * y) & 255];
          break;
        default:
          throw new Error(`Unknown corrected-v4 generator: ${id}`);
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

export function generateV4Fixture(id: string, paths: V4SourcePaths = {}): PixelFixture {
  const item = V4_HELDOUT.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown corrected-v4 fixture: ${id}`);
  let pixels: Uint8Array;
  if (item.source === 'generated') pixels = generated(item);
  else {
    const photo = item.source === 'photo';
    const path = photo ? paths.freshPhoto : paths.video;
    if (!path) throw new Error(`Missing ${photo ? 'fresh photo' : 'video'} source for ${id}`);
    checkedSource(
      path,
      photo ? V4_PHOTO.bytes : VIDEO_BYTES,
      photo ? V4_PHOTO.sha256 : EXTERNAL_SOURCES.video.sha256,
      photo ? 'fresh photo' : 'video'
    );
    const filter = `${photo ? '' : `select=eq(n\\,${item.frame}),`}scale=${item.width}:${item.height}:flags=bicubic`;
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

export function v4Manifest(paths: V4SourcePaths): object {
  const entries = V4_HELDOUT;
  assert.equal(V4_HELDOUT.length, 15);
  assert.equal(new Set(entries.map((item) => item.id)).size, entries.length);
  for (const item of entries) {
    assert.ok(item.width > 0 && item.height > 0 && item.width <= 16383 && item.height <= 16383);
    assert.ok(item.width * item.height <= MAX_PIXELS, `${item.id} exceeds the frame cap`);
    if (item.repeatOf) {
      const first = entries.find((other) => other.id === item.repeatOf);
      assert.ok(first && first.source === item.source && first.frame === item.frame);
    }
  }
  const root = resolve(import.meta.dirname, '../..');
  const sha256 = (file: string): string =>
    createHash('sha256').update(readFileSync(file)).digest('hex');
  return {
    schemaVersion: 1,
    cohort: 'corrected-v4',
    purpose:
      'Prospective source-only fresh held-out inputs after corrected-v3 43/45 rejection; all earlier cohorts remain exposed regression evidence',
    tuningBasis: 'No new tuning entries; the existing 15 tuning fixtures stay exposed controls',
    rejectedCandidate: 'c880a6dab6fc38311109968295ac56fa5ca3fecc',
    rejectedWasmSha256: '9c5247dc251aaabf79807c930c6300379d7c9e662ddcca08e363f5a9e578167f',
    previousOutcome: {
      jointPasses: 43,
      conditions: 45,
      failed: [
        {
          fixture: 'fresh3-large-admitted',
          quality: 60,
          gate: 'size',
          baseline: 66660,
          candidate: 92420,
          maximum: 83325,
        },
        {
          fixture: 'fresh3-large-admitted',
          quality: 85,
          gate: 'size',
          baseline: 106326,
          candidate: 138466,
          maximum: 132907.5,
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
      photoBytes: V4_PHOTO.bytes,
      videoBytes: VIDEO_BYTES,
    },
    sources: { photo: V4_PHOTO, video: { ...EXTERNAL_SOURCES.video, bytes: VIDEO_BYTES } },
    priorManifestSha256: {
      initialV1: sha256(resolve(root, 'docs/experiments/501-owned-vp8-v2-fixtures.json')),
      correctedV2: sha256(
        resolve(root, 'docs/experiments/501-owned-vp8-v2-correction-fixtures.json')
      ),
      correctedV3: sha256(resolve(root, 'docs/experiments/501-owned-vp8-v3-fixtures.json')),
    },
    generator: 'scripts/test/owned-vp8-v4-fixtures.ts; source-only generation, no codec outputs',
    generatorSha256: sha256(fileURLToPath(import.meta.url)),
    externalDecode: {
      ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
      command:
        'ffmpeg -v error -noautorotate -i SOURCE -vf FILTER -frames:v 1 -f rawvideo -pix_fmt rgba pipe:1',
      photoFilter: 'scale=521:347:flags=bicubic',
      videoFilter: 'select=eq(n\\,FRAME),scale=504:282:flags=bicubic',
    },
    fixtures: entries.map((item) => {
      const { pixels, ...details } = generateV4Fixture(item.id, paths);
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
      v4Manifest({
        ...(value('--fresh-photo') ? { freshPhoto: value('--fresh-photo')! } : {}),
        ...(value('--video') ? { video: value('--video')! } : {}),
      }),
      null,
      2
    )}\n`
  );
}
