/** Prospective corrected-v3 source-only fixtures. Never read codec output here. */
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

export type V3SourcePaths = CorrectionSourcePaths & { freshPhoto?: string };

export const V3_PHOTO = {
  name: 'Flower , photography.jpg',
  page: 'https://commons.wikimedia.org/wiki/File:Flower_,_photography.jpg',
  revision:
    'https://commons.wikimedia.org/w/index.php?title=File:Flower_,_photography.jpg&oldid=1255273783',
  download: 'https://upload.wikimedia.org/wikipedia/commons/6/66/Flower_%2C_photography.jpg',
  license: 'CC0-1.0',
  author: 'Obusaranya sekar',
  originalWidth: 4000,
  originalHeight: 2992,
  bytes: 2_579_282,
  sha1: '0c048fb0b7fc81a38227ca26eae2741ece19770c',
  sha256: 'f98721a4d3398a8a317dca93c5c609f655526cab1b81af68c5ab4d68f500fc09',
} as const;

const VIDEO_BYTES = 3_145_371;
const MAX_PIXELS = 10_066_329;
const NOISE_SEED = 0x50132027;

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

// These three controls are derived from the exposed chroma-edge class, and
// are tuning-only. They do not become fresh held-out evidence.
export const V3_TUNING: readonly FixtureSpec[] = [
  spec('tune3-chroma-diagonal-3', 'tuning', 'chroma', 192, 128),
  spec('tune3-chroma-stripe-5', 'tuning', 'chroma', 224, 144),
  spec('tune3-chroma-diagonal-7', 'tuning', 'chroma', 256, 160),
];

export const V3_HELDOUT: readonly FixtureSpec[] = [
  spec('fresh3-gray', 'held-out', 'grayscale', 487, 281),
  spec('fresh3-gradient', 'held-out', 'gradient', 373, 257),
  spec('fresh3-chroma-edge', 'held-out', 'chroma', 347, 239),
  spec('fresh3-text', 'held-out', 'text', 397, 283),
  spec('fresh3-noise', 'held-out', 'noise', 293, 181),
  spec('fresh3-tiny', 'held-out', 'tiny', 3, 2),
  spec('fresh3-one-column', 'held-out', 'odd', 1, 271),
  spec('fresh3-one-row', 'held-out', 'odd', 277, 1),
  spec('fresh3-large-admitted', 'held-out', 'large', 4160, 2419),
  spec('fresh3-bgra', 'held-out', 'layout', 269, 137, 'BGRA'),
  spec('fresh3-rgbx', 'held-out', 'layout', 269, 137, 'RGBX'),
  spec('fresh3-photo', 'held-out', 'photograph', 509, 381, 'RGBA', 'photo'),
  spec('fresh3-video-40', 'held-out', 'video', 480, 270, 'RGBA', 'video', 40),
  spec('fresh3-video-120', 'held-out', 'video', 480, 270, 'RGBA', 'video', 120),
  spec(
    'fresh3-duplicate-hold',
    'held-out',
    'duplicate-hold',
    480,
    270,
    'RGBA',
    'video',
    40,
    'fresh3-video-40'
  ),
];

const GLYPHS: Record<string, readonly string[]> = {
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function textPixel(x: number, y: number): boolean {
  const scale = 5;
  const col = Math.floor((x - 21) / scale);
  const row = Math.floor((y - 91) / scale);
  if (col < 0 || row < 0 || row >= 7) return false;
  const letter = Math.floor(col / 6);
  const within = col % 6;
  const glyph = GLYPHS['FRESH 3'[letter] ?? ' '];
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
        case 'tune3-chroma-diagonal-3':
          rgb = Math.floor((x + 2 * y) / 3) & 1 ? [238, 47, 28] : [22, 172, 244];
          break;
        case 'tune3-chroma-stripe-5':
          rgb = Math.floor(x / 5) & 1 ? [35, 229, 77] : [227, 26, 191];
          break;
        case 'tune3-chroma-diagonal-7':
          rgb = Math.floor((2 * x + y) / 7) & 1 ? [247, 214, 29] : [28, 46, 220];
          break;
        case 'fresh3-gray': {
          const value = (13 * x + 29 * y + ((x * y) % 47)) & 255;
          rgb = [value, value, value];
          break;
        }
        case 'fresh3-gradient':
          rgb = [
            Math.floor((255 * x) / (width - 1)),
            Math.floor((255 * (height - 1 - y)) / (height - 1)),
            Math.floor((255 * (5 * x + 3 * y)) / (5 * (width - 1) + 3 * (height - 1))),
          ];
          break;
        case 'fresh3-chroma-edge':
          rgb = Math.floor((3 * x + y) / 7) & 1 ? [239, 41, 31] : [19, 177, 247];
          break;
        case 'fresh3-text':
          rgb = textPixel(x, y) ? [248, 215, 52] : [12 + ((x >> 5) & 15), 24 + ((y >> 4) & 15), 51];
          break;
        case 'fresh3-noise':
          rgb = [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255];
          break;
        case 'fresh3-tiny':
          rgb = [
            (41 + 67 * x + 17 * y) & 255,
            (198 + 19 * x + 31 * y) & 255,
            (73 + 59 * x + 13 * y) & 255,
          ];
          break;
        case 'fresh3-one-column':
          rgb = [(11 * y) & 255, (37 * y) & 255, (5 * y) & 255];
          break;
        case 'fresh3-one-row':
          rgb = [(23 * x) & 255, (9 * x) & 255, (43 * x) & 255];
          break;
        case 'fresh3-large-admitted':
          rgb = [((x >> 3) + (y >> 5)) & 255, ((3 * x + y) >> 6) & 255, ((x ^ (3 * y)) >> 4) & 255];
          break;
        case 'fresh3-bgra':
        case 'fresh3-rgbx':
          rgb = [(19 * x + 11 * y) & 255, (7 * x + 23 * y) & 255, (31 * x + 3 * y) & 255];
          break;
        default:
          throw new Error(`Unknown corrected-v3 generator: ${id}`);
      }
      const at = (y * width + x) * 4;
      bytes.set(
        layout === 'BGRA'
          ? [rgb[2]!, rgb[1]!, rgb[0]!, 255]
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

export function generateV3Fixture(id: string, paths: V3SourcePaths = {}): PixelFixture {
  const item = [...V3_TUNING, ...V3_HELDOUT].find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown corrected-v3 fixture: ${id}`);
  let pixels: Uint8Array;
  if (item.source === 'generated') pixels = generated(item);
  else {
    const photo = item.source === 'photo';
    const path = photo ? paths.freshPhoto : paths.video;
    if (!path) throw new Error(`Missing ${photo ? 'fresh photo' : 'video'} source for ${id}`);
    checkedSource(
      path,
      photo ? V3_PHOTO.bytes : VIDEO_BYTES,
      photo ? V3_PHOTO.sha256 : EXTERNAL_SOURCES.video.sha256,
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

export function v3Manifest(paths: V3SourcePaths): object {
  const entries = [...V3_TUNING, ...V3_HELDOUT];
  assert.equal(V3_TUNING.length, 3);
  assert.equal(V3_HELDOUT.length, 15);
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
    cohort: 'corrected-v3',
    purpose:
      'Fresh held-out acceptance after corrected-v2 44/45 rejection; initial-v1 and corrected-v2 remain exposed regression evidence',
    tuningBasis:
      'Three new broad chroma-edge controls derive from the exposed fresh2-chroma-edge class; tuning-only, never held-out acceptance',
    rejectedCandidate: 'c49ecb80005aa28d9d0f45bf67947ccb8656c582',
    rejectedWasmSha256: '8d82889c45a9ed6e65639e767b7ea11cd75235b8ffcdc792332cf91952cb8ce2',
    previousOutcome: {
      jointPasses: 44,
      conditions: 45,
      failed: {
        fixture: 'fresh2-chroma-edge',
        quality: 75,
        gate: 'ssim',
        baseline: 0.198264,
        candidate: 0.186469,
        required: 0.188264,
      },
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
      photoBytes: V3_PHOTO.bytes,
      videoBytes: VIDEO_BYTES,
    },
    sources: { photo: V3_PHOTO, video: { ...EXTERNAL_SOURCES.video, bytes: VIDEO_BYTES } },
    priorManifestSha256: {
      initialV1: sha256(resolve(root, 'docs/experiments/501-owned-vp8-v2-fixtures.json')),
      correctedV2: sha256(
        resolve(root, 'docs/experiments/501-owned-vp8-v2-correction-fixtures.json')
      ),
    },
    generator: 'scripts/test/owned-vp8-v3-fixtures.ts; source-only generation, no codec outputs',
    generatorSha256: sha256(fileURLToPath(import.meta.url)),
    externalDecode: {
      ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
      command:
        'ffmpeg -v error -noautorotate -i SOURCE -vf FILTER -frames:v 1 -f rawvideo -pix_fmt rgba pipe:1',
      photoFilter: 'scale=509:381:flags=bicubic',
      videoFilter: 'select=eq(n\\,FRAME),scale=480:270:flags=bicubic',
    },
    fixtures: entries.map((item) => {
      const { pixels, ...details } = generateV3Fixture(item.id, paths);
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
      v3Manifest({
        ...(value('--fresh-photo') ? { freshPhoto: value('--fresh-photo')! } : {}),
        ...(value('--video') ? { video: value('--video')! } : {}),
      }),
      null,
      2
    )}\n`
  );
}
