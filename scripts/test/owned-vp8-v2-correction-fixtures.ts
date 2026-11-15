/** Frozen prospective correction cohorts; candidate outputs are never read here. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXTERNAL_SOURCES,
  QUALITIES,
  TUNING_PHOTO,
  type FixtureSpec,
  type PixelFixture,
  type SourcePaths,
} from './owned-vp8-v2-fixtures.ts';

export type CorrectionSourcePaths = SourcePaths & { tuningPhoto?: string };
export const CORRECTION_PHOTO = {
  page: 'https://commons.wikimedia.org/wiki/File:Random_landscape_photo_I_took.jpg',
  revision:
    'https://commons.wikimedia.org/w/index.php?title=File:Random_landscape_photo_I_took.jpg&oldid=1200107837',
  download: 'https://upload.wikimedia.org/wikipedia/commons/f/f0/Random_landscape_photo_I_took.jpg',
  license: 'CC0-1.0',
  author: 'Philsacor',
  sha256: '65d727e89ee6aae0ae1ce9e1b79429495c3a7b993cc53333fffb76e176ffecf8',
} as const;

function spec(
  id: string,
  split: 'tuning' | 'held-out',
  kind: string,
  width: number,
  height: number,
  layout: FixtureSpec['layout'] = 'RGBA',
  source: FixtureSpec['source'] = 'generated',
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

export const CORRECTION_TUNING: readonly FixtureSpec[] = [
  spec('tune-broad-gradient', 'tuning', 'gradient', 256, 160),
  spec('tune-diagonal-strokes', 'tuning', 'text', 192, 128),
  spec('tune-photo-detail', 'tuning', 'photograph', 384, 288, 'RGBA', 'photo'),
];
export const CORRECTION_HELDOUT: readonly FixtureSpec[] = [
  spec('fresh2-gray', 'held-out', 'grayscale', 509, 263),
  spec('fresh2-gradient', 'held-out', 'gradient', 389, 251),
  spec('fresh2-chroma-edge', 'held-out', 'chroma', 337, 247),
  spec('fresh2-text', 'held-out', 'text', 421, 269),
  spec('fresh2-noise', 'held-out', 'noise', 271, 197),
  spec('fresh2-tiny', 'held-out', 'tiny', 2, 3),
  spec('fresh2-one-column', 'held-out', 'odd', 1, 263),
  spec('fresh2-one-row', 'held-out', 'odd', 263, 1),
  spec('fresh2-large-admitted', 'held-out', 'large', 4080, 2467),
  spec('fresh2-bgra', 'held-out', 'layout', 263, 131, 'BGRA'),
  spec('fresh2-rgbx', 'held-out', 'layout', 263, 131, 'RGBX'),
  spec('fresh2-photo', 'held-out', 'photograph', 503, 377, 'RGBA', 'photo'),
  spec('fresh2-video-90', 'held-out', 'video', 496, 280, 'RGBA', 'video', 90),
  spec('fresh2-video-150', 'held-out', 'video', 496, 280, 'RGBA', 'video', 150),
  spec(
    'fresh2-duplicate-hold',
    'held-out',
    'duplicate-hold',
    496,
    280,
    'RGBA',
    'video',
    90,
    'fresh2-video-90'
  ),
];

const GLYPHS = [
  '10001100011000110101010100101001010',
  '11110100011000111110100001000010000',
  '01110100011000101110100011000101110',
];
function glyph(x: number, y: number): boolean {
  const col = Math.floor((x - 31) / 7),
    row = Math.floor((y - 83) / 7);
  if (row < 0 || row >= 7 || col < 0 || col >= 18) return false;
  const letter = Math.floor(col / 6),
    within = col % 6;
  return within < 5 && GLYPHS[letter]![row * 5 + within] === '1';
}

function generated(item: FixtureSpec): Uint8Array {
  const { id, width, height, layout } = item;
  const bytes = new Uint8Array(width * height * 4);
  let seed = 0x5012026;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      let rgb: readonly number[];
      switch (id) {
        case 'tune-broad-gradient':
          rgb = [
            Math.floor((x * 255) / (width - 1)),
            Math.floor((y * 255) / (height - 1)),
            Math.floor(((x + y) * 255) / (width + height - 2)),
          ];
          break;
        case 'tune-diagonal-strokes':
          rgb = ((x + 2 * y) >> 3) % 3 === 0 ? [244, 241, 17] : [13, 21, 39];
          break;
        case 'fresh2-gray': {
          const v = (x * 11 + y * 47 + ((x * y) % 73)) & 255;
          rgb = [v, v, v];
          break;
        }
        case 'fresh2-gradient':
          rgb = [
            Math.floor((x * 255) / (width - 1)),
            Math.floor(((height - 1 - y) * 255) / (height - 1)),
            Math.floor(((3 * x + 7 * y) * 255) / (3 * (width - 1) + 7 * (height - 1))),
          ];
          break;
        case 'fresh2-chroma-edge':
          rgb = Math.floor((x + 2 * y) / 5) % 2 ? [248, 18, 184] : [7, 239, 117];
          break;
        case 'fresh2-text':
          rgb = glyph(x, y) ? [247, 116, 35] : [11, 23, 51];
          break;
        case 'fresh2-noise':
          rgb = [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255];
          break;
        case 'fresh2-tiny':
          rgb = [(37 + x * 97 + y * 13) & 255, (211 + y * 31) & 255, (53 + x * 29 + y * 73) & 255];
          break;
        case 'fresh2-one-column':
          rgb = [(y * 17) & 255, (y * 41) & 255, (y * 3) & 255];
          break;
        case 'fresh2-one-row':
          rgb = [(x * 19) & 255, (x * 5) & 255, (x * 31) & 255];
          break;
        case 'fresh2-large-admitted':
          rgb = [
            Math.floor((5 * x + y) / 23) & 255,
            Math.floor((x + 3 * y) / 17) & 255,
            Math.floor((x ^ (y << 1)) / 11) & 255,
          ];
          break;
        case 'fresh2-bgra':
        case 'fresh2-rgbx':
          rgb = [(x * 13 + y * 29) & 255, (x * 31 + y * 5) & 255, (x * 7 + y * 19) & 255];
          break;
        default:
          throw new Error('Unknown correction generator: ' + id);
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

export function generateCorrectionFixture(id: string, paths: CorrectionSourcePaths): PixelFixture {
  const item = [...CORRECTION_TUNING, ...CORRECTION_HELDOUT].find((entry) => entry.id === id);
  if (!item) throw new Error('Unknown correction fixture: ' + id);
  let pixels: Uint8Array;
  if (item.source === 'generated') pixels = generated(item);
  else {
    const tuning = item.id === 'tune-photo-detail';
    const path = tuning ? paths.tuningPhoto : paths[item.source === 'video' ? 'video' : 'photo'];
    if (!path) throw new Error('Missing source for ' + id);
    const expected = tuning
      ? TUNING_PHOTO.originalSha256
      : item.source === 'video'
        ? EXTERNAL_SOURCES.video.sha256
        : CORRECTION_PHOTO.sha256;
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), expected);
    const filter =
      (item.source === 'video' ? 'select=eq(n\\,' + item.frame + '),' : '') +
      'scale=' +
      item.width +
      ':' +
      item.height +
      ':flags=bicubic';
    pixels = new Uint8Array(
      execFileSync(
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
      )
    );
    assert.equal(pixels.length, item.width * item.height * 4);
  }
  return { ...item, stride: item.width * 4, pixels };
}

export function correctionManifest(paths: CorrectionSourcePaths): object {
  const entries = [...CORRECTION_TUNING, ...CORRECTION_HELDOUT];
  assert.equal(new Set(entries.map((item) => item.id)).size, entries.length);
  for (const item of entries) {
    assert.ok(item.width <= 16383 && item.height <= 16383 && item.width * item.height <= 10066329);
  }
  return {
    schemaVersion: 1,
    cohort: 'corrected-v2',
    purpose:
      'Fresh held-out acceptance after initial-v1 candidate rejection; initial-v1 remains exposed regression evidence',
    rejectedCandidate: '7e4bcb4ce96579072da4887aaa93f8ae48a8215d',
    rejectedWasmSha256: 'e48c2e1be8f2b20bdda9c9d18c755063f872db344681c9a776c191cb27cc4f15',
    initialOutcome: { jointPasses: 31, conditions: 45 },
    thresholds: {
      psnrBaselineDeltaDb: -1,
      ssimBaselineDelta: -0.01,
      sizeRatio: 1.25,
      sizeAdditiveBytes: 128,
    },
    sources: { photo: CORRECTION_PHOTO, video: EXTERNAL_SOURCES.video, tuningPhoto: TUNING_PHOTO },
    generator: 'Source-only generation; no candidate or comparator outputs are read',
    generatorSha256: createHash('sha256')
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest('hex'),
    fixtures: entries.map((item) => {
      const { pixels, ...details } = generateCorrectionFixture(item.id, paths);
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
  console.log(
    JSON.stringify(
      correctionManifest({
        ...(value('--photo') ? { photo: value('--photo')! } : {}),
        ...(value('--video') ? { video: value('--video')! } : {}),
        ...(value('--tuning-photo') ? { tuningPhoto: value('--tuning-photo')! } : {}),
      }),
      null,
      2
    )
  );
}
