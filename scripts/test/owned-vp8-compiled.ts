/** Execute the actual owned VP8 WASM and independently decode its narrow output. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const wasmPath = resolve('crates/owned-vp8/target/wasm32-unknown-unknown/release/owned_vp8.wasm');
const wasm = readFileSync(wasmPath);
const wasmSha256 = createHash('sha256').update(wasm).digest('hex');
const wasmApi = (
  globalThis as unknown as {
    WebAssembly: {
      instantiate(bytes: Uint8Array): Promise<{ instance: { exports: Record<string, unknown> } }>;
    };
  }
).WebAssembly;
const { instance } = await wasmApi.instantiate(wasm);
const exports = instance.exports as unknown as {
  memory: { buffer: ArrayBuffer };
  vp8_abi_version(): number;
  vp8_reserve_input(length: number): number;
  vp8_encode(
    width: number,
    height: number,
    stride: number,
    format: number,
    quality: number,
    length: number
  ): number;
  vp8_output_ptr(): number;
  vp8_output_len(): number;
  vp8_reset(): void;
};
assert.equal(exports.vp8_abi_version(), 1);
const ffmpeg = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0];
const root = mkdtempSync(join(tmpdir(), 'owned-vp8-'));
const results: unknown[] = [];

function keyframe(
  width: number,
  height: number,
  stride: number,
  format: number,
  quality: number
): Uint8Array {
  const input = new Uint8Array(stride * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      input.set([128, 128, 128, 255], row * stride + column * 4);
    }
  }
  const inputPtr = exports.vp8_reserve_input(input.length);
  assert.ok(inputPtr > 0);
  // The reservation may grow linear memory. Construct the view after it returns.
  new Uint8Array(exports.memory.buffer, inputPtr, input.length).set(input);
  assert.equal(exports.vp8_encode(width, height, stride, format, quality, input.length), 0);
  const outputLength = exports.vp8_output_len();
  assert.ok(outputLength > 10 && outputLength < 4 * 1024 * 1024);
  const outputPtr = exports.vp8_output_ptr();
  const output = new Uint8Array(exports.memory.buffer, outputPtr, outputLength).slice();
  assert.equal(output[0]! & 1, 0);
  assert.deepEqual([...output.subarray(3, 6)], [0x9d, 0x01, 0x2a]);
  const view = new DataView(output.buffer);
  assert.equal(view.getUint16(6, true) & 0x3fff, width);
  assert.equal(view.getUint16(8, true) & 0x3fff, height);
  return output;
}

function asIvf(frame: Uint8Array, width: number, height: number): Buffer {
  const ivf = Buffer.alloc(44 + frame.length);
  ivf.write('DKIF');
  ivf.writeUInt16LE(32, 6);
  ivf.write('VP80', 8);
  ivf.writeUInt16LE(width, 12);
  ivf.writeUInt16LE(height, 14);
  ivf.writeUInt32LE(1, 16);
  ivf.writeUInt32LE(1, 20);
  ivf.writeUInt32LE(1, 24);
  ivf.writeUInt32LE(frame.length, 32);
  Buffer.from(frame).copy(ivf, 44);
  return ivf;
}

try {
  for (const [width, height, format] of [
    [16, 16, 0],
    [17, 13, 1],
  ] as const) {
    for (const quality of [60, 75, 85]) {
      const frame = keyframe(width, height, width * 4 + 8, format, quality);
      const stem = `${width}x${height}-q${quality}-f${format}`;
      const ivf = join(root, `${stem}.ivf`);
      const rgba = join(root, `${stem}.rgba`);
      writeFileSync(ivf, asIvf(frame, width, height));
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        ivf,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        '-y',
        rgba,
      ]);
      const decoded = readFileSync(rgba);
      assert.equal(decoded.length, width * height * 4);
      for (let index = 0; index < decoded.length; index += 4) {
        assert.ok(Math.abs(decoded[index]! - 128) <= 6);
        assert.ok(Math.abs(decoded[index + 1]! - 128) <= 6);
        assert.ok(Math.abs(decoded[index + 2]! - 128) <= 6);
        assert.equal(decoded[index + 3], 255);
      }
      results.push({
        width,
        height,
        format,
        quality,
        rawBytes: frame.length,
        sha256: createHash('sha256').update(frame).digest('hex'),
        decodedSha256: createHash('sha256').update(decoded).digest('hex'),
      });
    }
  }
  for (const pattern of ['flat', 'text', 'gradient', 'chroma', 'noise'] as const) {
    const width = 64;
    const height = 48;
    const stride = width * 4;
    const input = new Uint8Array(stride * height);
    let seed = 0x497;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const color =
          pattern === 'flat'
            ? [160, 64, 32]
            : pattern === 'text'
              ? x % 9 < 2 || y % 11 < 2
                ? [250, 250, 250]
                : [8, 8, 8]
              : pattern === 'gradient'
                ? [(x * 4) & 255, (y * 5) & 255, ((x + y) * 2) & 255]
                : pattern === 'chroma'
                  ? x % 8 < 4
                    ? [255, 0, 0]
                    : [0, 0, 255]
                  : [seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255];
        input.set([...color, 255], y * stride + x * 4);
      }
    }
    const inputSha256 = createHash('sha256').update(input).digest('hex');
    for (const quality of [60, 75, 85]) {
      const inputPtr = exports.vp8_reserve_input(input.length);
      assert.ok(inputPtr > 0);
      new Uint8Array(exports.memory.buffer, inputPtr, input.length).set(input);
      assert.equal(exports.vp8_encode(width, height, stride, 0, quality, input.length), 0);
      const frame = new Uint8Array(
        exports.memory.buffer,
        exports.vp8_output_ptr(),
        exports.vp8_output_len()
      ).slice();
      const stem = `${pattern}-q${quality}`;
      const ivf = join(root, `${stem}.ivf`);
      const rgba = join(root, `${stem}.rgba`);
      writeFileSync(ivf, asIvf(frame, width, height));
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        ivf,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        '-y',
        rgba,
      ]);
      const decoded = readFileSync(rgba);
      assert.equal(decoded.length, input.length);
      let squared = 0;
      for (let index = 0; index < input.length; index += 4) {
        for (let channel = 0; channel < 3; channel++) {
          const difference = input[index + channel]! - decoded[index + channel]!;
          squared += difference * difference;
        }
        assert.equal(decoded[index + 3], 255);
      }
      const mse = squared / (width * height * 3);
      const psnr = 10 * Math.log10((255 * 255) / mse);
      results.push({
        pattern,
        width,
        height,
        quality,
        inputSha256,
        rawBytes: frame.length,
        sha256: createHash('sha256').update(frame).digest('hex'),
        decodedSha256: createHash('sha256').update(decoded).digest('hex'),
        psnr,
      });
    }
  }
  assert.equal(exports.vp8_encode(16, 16, 64, 0, 75, 1), 1); // Length mismatch.
  assert.equal(exports.vp8_output_len(), 0);
  assert.equal(exports.vp8_reserve_input(0), 0);
  assert.equal(exports.vp8_output_len(), 0);
  assert.equal(exports.vp8_reserve_input(16 * 1024 * 1024 + 1), 0);
  const one = keyframe(16, 16, 64, 0, 75);
  assert.equal(exports.vp8_encode(0, 16, 64, 0, 75, 1024), 1);
  assert.equal(exports.vp8_encode(16, 16, 63, 0, 75, 1024), 1);
  assert.equal(exports.vp8_encode(16, 16, 64, 0, 55, 1024), 1);
  assert.equal(exports.vp8_encode(16, 16, 64, 3, 75, 1024), 1);
  const changed = new Uint8Array(exports.memory.buffer, exports.vp8_reserve_input(1024), 1024);
  for (let index = 0; index < changed.length; index += 4) changed.set([127, 127, 127, 255], index);
  assert.equal(exports.vp8_encode(16, 16, 64, 0, 75, 1024), 0); // Generic opaque path.
  assert.ok(exports.vp8_output_len() > 10);
  changed[3] = 127;
  assert.equal(exports.vp8_encode(16, 16, 64, 0, 75, 1024), 2);
  assert.equal(exports.vp8_output_len(), 0);
  exports.vp8_reset();
  assert.equal(exports.vp8_output_len(), 0);
  assert.deepEqual(keyframe(16, 16, 64, 0, 75), one); // Same instance recovery.
  console.log(
    JSON.stringify(
      { status: 'compiled-textured-slice-passed', wasmSha256, ffmpeg, results },
      null,
      2
    )
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
