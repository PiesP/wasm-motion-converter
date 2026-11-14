/** Frozen fixed-pixel cohorts for issue #501. No candidate output is read here. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type FixtureSplit = 'tuning' | 'held-out';
export type PixelLayout = 'RGBA' | 'RGBX' | 'BGRA' | 'BGRX';
export type SourcePaths = { photo?: string; video?: string };
export type FixtureSpec = {
  id: string;
  split: FixtureSplit;
  class: string;
  width: number;
  height: number;
  layout: PixelLayout;
  source: 'generated' | 'photo' | 'video';
  frame?: number;
  repeatOf?: string;
};
export type PixelFixture = FixtureSpec & { stride: number; pixels: Uint8Array };

export const QUALITIES = [60, 75, 85] as const;
export const EXTERNAL_SOURCES = {
  photo: {
    name: 'A lush verdant landscape.jpg',
    page: 'https://commons.wikimedia.org/wiki/File:A_lush_verdant_landscape.jpg',
    download: 'https://upload.wikimedia.org/wikipedia/commons/2/24/A_lush_verdant_landscape.jpg',
    license: 'CC0-1.0',
    author: 'Ayyuha Sideeq',
    sha256: '026fe604c8f51d1c3fcc5c3699f800156daec4f47a6f0c5d304f8b1d95003b9e',
  },
  video: {
    name: 'V8.webm',
    page: 'https://commons.wikimedia.org/wiki/File:V8.webm',
    download: 'https://upload.wikimedia.org/wikipedia/commons/a/a7/V8.webm',
    license: 'CC0-1.0',
    author: 'BMKME',
    sha256: 'c6a21a3a7619ca7fbcbc1b4d012d7098d18f599f0200f735d31cae15a4772dd1',
  },
} as const;

// The first five names and their pixel formulas reproduce the fifteen controls
// in scripts/test/owned-vp8-compare.ts at be35f5fa (five patterns x three q).
export const FIXTURES: readonly FixtureSpec[] = [
  {
    id: 'legacy-flat',
    split: 'tuning',
    class: 'flat',
    width: 64,
    height: 48,
    layout: 'RGBA',
    source: 'generated',
  },
  {
    id: 'legacy-text',
    split: 'tuning',
    class: 'edge',
    width: 64,
    height: 48,
    layout: 'RGBA',
    source: 'generated',
  },
  {
    id: 'legacy-gradient',
    split: 'tuning',
    class: 'gradient',
    width: 64,
    height: 48,
    layout: 'RGBA',
    source: 'generated',
  },
  {
    id: 'legacy-chroma',
    split: 'tuning',
    class: 'chroma',
    width: 64,
    height: 48,
    layout: 'RGBA',
    source: 'generated',
  },
  {
    id: 'legacy-noise',
    split: 'tuning',
    class: 'noise',
    width: 64,
    height: 48,
    layout: 'RGBA',
    source: 'generated',
  },
  {
    id: 'tune-gray-sweep',
    split: 'tuning',
    class: 'grayscale',
    width: 257,
    height: 33,
    layout: 'RGBA',
    source: 'generated',
  },
  {
    id: 'tune-colored-text',
    split: 'tuning',
    class: 'text',
    width: 256,
    height: 128,
    layout: 'RGBA',
    source: 'generated',
  },
  {
    id: 'tune-chroma-edge',
    split: 'tuning',
    class: 'chroma',
    width: 128,
    height: 96,
    layout: 'RGBA',
    source: 'generated',
  },
  {
    id: 'held-gray',
    split: 'held-out',
    class: 'grayscale',
    width: 511,
    height: 257,
    layout: 'RGBA',
    source: 'generated',
  },
  {
    id: 'held-gradient',
    split: 'held-out',
    class: 'gradient',
    width: 321,
    height: 239,
    layout: 'RGBA',
    source: 'generated',
  },
  {
    id: 'held-chroma',
    split: 'held-out',
    class: 'chroma',
    width: 320,
    height: 241,
    layout: 'RGBA',
    source: 'generated',
  },
  {
    id: 'held-colored-text',
    split: 'held-out',
    class: 'text',
    width: 448,
    height: 256,
    layout: 'RGBA',
    source: 'generated',
  },
  {
    id: 'held-noise',
    split: 'held-out',
    class: 'noise',
    width: 257,
    height: 193,
    layout: 'RGBA',
    source: 'generated',
  },
  {
    id: 'held-tiny',
    split: 'held-out',
    class: 'tiny',
    width: 1,
    height: 1,
    layout: 'RGBA',
    source: 'generated',
  },
  {
    id: 'held-one-column',
    split: 'held-out',
    class: 'odd',
    width: 1,
    height: 257,
    layout: 'RGBA',
    source: 'generated',
  },
  {
    id: 'held-one-row',
    split: 'held-out',
    class: 'odd',
    width: 257,
    height: 1,
    layout: 'RGBA',
    source: 'generated',
  },
  {
    id: 'held-large-admitted',
    split: 'held-out',
    class: 'large',
    width: 4096,
    height: 2457,
    layout: 'RGBA',
    source: 'generated',
  },
  {
    id: 'held-bgra-opaque',
    split: 'held-out',
    class: 'layout',
    width: 253,
    height: 129,
    layout: 'BGRA',
    source: 'generated',
  },
  {
    id: 'held-rgbx-ignored-x',
    split: 'held-out',
    class: 'layout',
    width: 253,
    height: 129,
    layout: 'RGBX',
    source: 'generated',
  },
  {
    id: 'held-photo',
    split: 'held-out',
    class: 'photograph',
    width: 512,
    height: 384,
    layout: 'RGBA',
    source: 'photo',
  },
  {
    id: 'held-video-frame-10',
    split: 'held-out',
    class: 'video',
    width: 512,
    height: 288,
    layout: 'RGBA',
    source: 'video',
    frame: 10,
  },
  {
    id: 'held-video-frame-60',
    split: 'held-out',
    class: 'video',
    width: 512,
    height: 288,
    layout: 'RGBA',
    source: 'video',
    frame: 60,
  },
  {
    id: 'held-video-duplicate-hold',
    split: 'held-out',
    class: 'duplicate-hold',
    width: 512,
    height: 288,
    layout: 'RGBA',
    source: 'video',
    frame: 10,
    repeatOf: 'held-video-frame-10',
  },
];

const GLYPHS: Record<string, readonly string[]> = {
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function glyphPixel(text: string, x: number, y: number, scale: number): boolean {
  const char = Math.floor(x / (6 * scale));
  const column = Math.floor((x % (6 * scale)) / scale);
  const row = Math.floor(y / scale);
  return column < 5 && row < 7 && GLYPHS[text[char] ?? ' ']?.[row]?.[column] === '1';
}

function fillGenerated(spec: FixtureSpec): Uint8Array {
  const { width, height, id } = spec;
  const pixels = new Uint8Array(width * height * 4);
  let seed = id.startsWith('legacy-') ? 0x497 : id === 'held-noise' ? 0x9e3779b9 : 0x501a11ce;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      let rgb: readonly number[];
      switch (id) {
        case 'legacy-flat':
          rgb = [160, 64, 32];
          break;
        case 'legacy-text':
          rgb = x % 9 < 2 || y % 11 < 2 ? [250, 250, 250] : [8, 8, 8];
          break;
        case 'legacy-gradient':
          rgb = [(x * 4) & 255, (y * 5) & 255, ((x + y) * 2) & 255];
          break;
        case 'legacy-chroma':
          rgb = x % 8 < 4 ? [255, 0, 0] : [0, 0, 255];
          break;
        case 'legacy-noise':
          rgb = [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255];
          break;
        case 'tune-gray-sweep': {
          const v = x & 255;
          rgb = [v, v, v];
          break;
        }
        case 'held-gray': {
          const v = (x * 37 + y * 19 + ((x ^ y) & 31)) & 255;
          rgb = [v, v, v];
          break;
        }
        case 'tune-chroma-edge':
          rgb = (Math.floor(x / 3) + Math.floor(y / 5)) % 2 ? [0, 220, 245] : [252, 26, 12];
          break;
        case 'held-chroma':
          rgb = (Math.floor(x / 2) ^ Math.floor(y / 7)) & 1 ? [255, 8, 124] : [5, 245, 32];
          break;
        case 'held-gradient':
          rgb = [
            ((x * 255) / (width - 1)) | 0,
            ((y * 255) / (height - 1)) | 0,
            ((((x + y) * 127) / (width + height - 2)) | 0) + 44,
          ];
          break;
        case 'tune-colored-text':
          rgb = glyphPixel('VP8 TEST', x - 10, y - 40, 4) ? [242, 94, 27] : [18, 27, 42];
          break;
        case 'held-colored-text':
          rgb = glyphPixel('VP8 501', x - 12, y - 72, 8) ? [33, 237, 251] : [30, 13, 48];
          break;
        case 'held-noise':
          rgb = [seed & 255, (seed >>> 10) & 255, (seed >>> 20) & 255];
          break;
        case 'held-tiny':
          rgb = [37, 181, 240];
          break;
        case 'held-one-column':
          rgb = [x, (y * 7) & 255, (y * 29) & 255];
          break;
        case 'held-one-row':
          rgb = [(x * 13) & 255, (x * 7) & 255, x & 255];
          break;
        case 'held-large-admitted':
          rgb = [(x >> 4) & 255, (y >> 3) & 255, ((x ^ y) >> 2) & 255];
          break;
        case 'held-bgra-opaque':
        case 'held-rgbx-ignored-x':
          rgb = [(x * 23 + y * 7) & 255, (x * 3 + y * 17) & 255, (x * 11 + y * 31) & 255];
          break;
        default:
          throw new Error(`No generator for ${id}`);
      }
      const at = (y * width + x) * 4;
      if (spec.layout === 'BGRA' || spec.layout === 'BGRX') {
        pixels.set([rgb[2]!, rgb[1]!, rgb[0]!, spec.layout === 'BGRX' ? seed & 255 : 255], at);
      } else {
        pixels.set([rgb[0]!, rgb[1]!, rgb[2]!, spec.layout === 'RGBX' ? seed & 255 : 255], at);
      }
    }
  }
  return pixels;
}

function decodeExternal(spec: FixtureSpec, paths: SourcePaths): Uint8Array {
  const key = spec.source as 'photo' | 'video';
  const path = paths[key];
  if (!path) throw new Error(`Missing ${key} input for ${spec.id}`);
  const expected = EXTERNAL_SOURCES[key];
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actual !== expected.sha256) throw new Error(`${key} source SHA256 mismatch: ${actual}`);
  const filter =
    key === 'photo'
      ? `scale=${spec.width}:${spec.height}:flags=bicubic`
      : `select=eq(n\\,${spec.frame}),scale=${spec.width}:${spec.height}:flags=bicubic`;
  const bytes = execFileSync(
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
    { maxBuffer: spec.width * spec.height * 4 + 4096 }
  );
  const length = spec.width * spec.height * 4;
  if (bytes.length !== length)
    throw new Error(`Unexpected decoded length for ${spec.id}: ${bytes.length}`);
  return new Uint8Array(bytes);
}

export function generateFixture(id: string, paths: SourcePaths = {}): PixelFixture {
  const spec = FIXTURES.find((fixture) => fixture.id === id);
  if (!spec) throw new Error(`Unknown fixture: ${id}`);
  const pixels = spec.source === 'generated' ? fillGenerated(spec) : decodeExternal(spec, paths);
  return { ...spec, stride: spec.width * 4, pixels };
}

export function manifest(paths: SourcePaths): object {
  const ids = new Set(FIXTURES.map((spec) => spec.id));
  assert.equal(ids.size, FIXTURES.length, 'fixture IDs must be unique');
  for (const spec of FIXTURES) {
    assert.ok(spec.width > 0 && spec.height > 0 && spec.width <= 16383 && spec.height <= 16383);
    assert.ok(spec.width * spec.height <= 10066329, `${spec.id} exceeds current frame cap`);
    if (spec.repeatOf) {
      const first = FIXTURES.find((other) => other.id === spec.repeatOf);
      assert.ok(first && first.source === spec.source && first.frame === spec.frame);
    }
  }
  const fixtures = FIXTURES.map((spec) => {
    const pixel = generateFixture(spec.id, paths);
    const { pixels, ...details } = pixel;
    return {
      ...details,
      qualities: QUALITIES,
      sha256: createHash('sha256').update(pixels).digest('hex'),
    };
  });
  return {
    schemaVersion: 1,
    baselineRevision: 'be35f5fa89a60189475fe2ef7fd446e9fa18cef4',
    generator: 'scripts/test/owned-vp8-v2-fixtures.ts',
    generatorSha256: createHash('sha256')
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest('hex'),
    colorContract:
      'Packed opaque 8-bit code values; no alpha compression, premultiplication or ICC transform',
    externalDecode: {
      ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
      command:
        'ffmpeg -v error -noautorotate -i SOURCE -vf FILTER -frames:v 1 -f rawvideo -pix_fmt rgba pipe:1',
      photoFilter: 'scale=512:384:flags=bicubic',
      videoFilter: 'select=eq(n\\,FRAME),scale=512:288:flags=bicubic',
    },
    sources: EXTERNAL_SOURCES,
    fixtures,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--photo' || args[2] !== '--video') {
    throw new Error(
      'Usage: node --experimental-strip-types scripts/test/owned-vp8-v2-fixtures.ts --photo PATH --video PATH'
    );
  }
  process.stdout.write(
    `${JSON.stringify(manifest({ photo: args[1]!, video: args[3]! }), null, 2)}\n`
  );
}
