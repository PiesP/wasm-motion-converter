/** Compare the bounded owned VP8 candidate with installed wasm-webp on fixed controls. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const moduleUrl = new URL('../../node_modules/wasm-webp/dist/esm/webp-wasm.js', import.meta.url);
const { default: instantiateOracle } = await import(moduleUrl.href) as {
  default: () => Promise<{ encodeRGB(rgb: Uint8Array, width: number, height: number, quality: number): Uint8Array | null; encoder_version(): string }>;
};
const oracle = await instantiateOracle();
const wasm = readFileSync(resolve('crates/owned-vp8/target/wasm32-unknown-unknown/release/owned_vp8.wasm'));
const { instance } = await WebAssembly.instantiate(wasm);
const candidate = instance.exports as unknown as {
  memory: WebAssembly.Memory;
  vp8_reserve_input(length: number): number;
  vp8_encode(width: number, height: number, stride: number, format: number, quality: number, length: number): number;
  vp8_output_ptr(): number;
  vp8_output_len(): number;
};
const root = mkdtempSync(join(tmpdir(), 'owned-vp8-compare-'));
const results = [];

function extractVp8(webp: Uint8Array): Uint8Array {
  const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);
  assert.equal(new TextDecoder().decode(webp.subarray(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(webp.subarray(8, 12)), 'WEBP');
  for (let offset = 12; offset + 8 <= webp.length;) {
    const size = view.getUint32(offset + 4, true);
    const fourcc = new TextDecoder().decode(webp.subarray(offset, offset + 4));
    const end = offset + 8 + size;
    assert.ok(end <= webp.length);
    if (fourcc === 'VP8 ') return webp.slice(offset + 8, end);
    offset = end + (size & 1);
  }
  throw new Error('Oracle output has no VP8 keyframe');
}

function toWebp(frame: Uint8Array): Uint8Array {
  const file = new Uint8Array(20 + frame.length + (frame.length & 1));
  const view = new DataView(file.buffer);
  file.set([82, 73, 70, 70], 0);
  view.setUint32(4, file.length - 8, true);
  file.set([87, 69, 66, 80, 86, 80, 56, 32], 8);
  view.setUint32(16, frame.length, true);
  file.set(frame, 20);
  return file;
}

function decodedRgba(webp: Uint8Array, stem: string, width: number, height: number): Buffer {
  const file = join(root, `${stem}.webp`);
  const pixels = join(root, `${stem}.rgba`);
  writeFileSync(file, webp);
  execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-y', pixels]);
  const result = readFileSync(pixels);
  assert.equal(result.length, width * height * 4);
  return result;
}

function psnr(input: Uint8Array, actual: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < input.length; index += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const difference = input[index + channel]! - actual[index + channel]!;
      sum += difference * difference;
    }
    assert.equal(actual[index + 3], 255);
  }
  return 10 * Math.log10(255 * 255 / (sum / (input.length / 4 * 3)));
}

try {
  const width = 64;
  const height = 48;
  for (const pattern of ['flat', 'text', 'gradient', 'chroma', 'noise'] as const) {
    const rgba = new Uint8Array(width * height * 4);
    const rgb = new Uint8Array(width * height * 3);
    let seed = 0x497;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const color = pattern === 'flat' ? [160, 64, 32]
          : pattern === 'text' ? ((x % 9 < 2 || y % 11 < 2) ? [250, 250, 250] : [8, 8, 8])
            : pattern === 'gradient' ? [(x * 4) & 255, (y * 5) & 255, ((x + y) * 2) & 255]
              : pattern === 'chroma' ? (x % 8 < 4 ? [255, 0, 0] : [0, 0, 255])
                : [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255];
        rgba.set([...color, 255], (y * width + x) * 4);
        rgb.set(color, (y * width + x) * 3);
      }
    }
    const inputSha256 = createHash('sha256').update(rgba).digest('hex');
    for (const quality of [60, 75, 85]) {
      const oracleWebp = oracle.encodeRGB(rgb, width, height, quality)?.slice();
      assert.ok(oracleWebp);
      const oracleFrame = extractVp8(oracleWebp);
      const oraclePixels = decodedRgba(oracleWebp, `oracle-${pattern}-q${quality}`, width, height);
      const pointer = candidate.vp8_reserve_input(rgba.length);
      assert.ok(pointer > 0);
      new Uint8Array(candidate.memory.buffer, pointer, rgba.length).set(rgba);
      assert.equal(candidate.vp8_encode(width, height, width * 4, 0, quality, rgba.length), 0);
      const candidateFrame = new Uint8Array(candidate.memory.buffer, candidate.vp8_output_ptr(), candidate.vp8_output_len()).slice();
      const candidatePixels = decodedRgba(toWebp(candidateFrame), `candidate-${pattern}-q${quality}`, width, height);
      const oraclePsnr = psnr(rgba, oraclePixels);
      const candidatePsnr = psnr(rgba, candidatePixels);
      results.push({ pattern, inputSha256, width, height, quality,
        oracleRawBytes: oracleFrame.length, candidateRawBytes: candidateFrame.length,
        oraclePsnr, candidatePsnr, deltaPsnr: candidatePsnr - oraclePsnr,
        oracleSha256: createHash('sha256').update(oracleFrame).digest('hex'),
        candidateSha256: createHash('sha256').update(candidateFrame).digest('hex'),
      });
    }
  }
  console.log(JSON.stringify({ status: 'compared', oracleVersion: oracle.encoder_version(),
    oracleWasmSha256: createHash('sha256').update(readFileSync(new URL('../../node_modules/wasm-webp/dist/esm/webp-wasm.wasm', import.meta.url))).digest('hex'),
    candidateWasmSha256: createHash('sha256').update(wasm).digest('hex'),
    ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0], results }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
