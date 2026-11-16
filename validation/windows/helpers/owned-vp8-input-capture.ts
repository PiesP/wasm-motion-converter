// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, open, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

export const V8_RGB_BYTES = 1920 * 1080 * 3;
export const V8_LEGACY_COPY_BYTES = 8 * 1024 * 1024;
export const V8_CAPTURE_INDICES = [0, 19, 38, 57, 76] as const;
export const V8_CAPTURE_BUDGET = 32 * 1024 * 1024;
export const V8_CAPTURE_CHUNK = 64 * 1024;
const EXPECTED_ENCODES = 77;
const V8_MAX_BASE64_CHARS = 4 * Math.ceil(V8_CAPTURE_CHUNK / 3);
export const V8_CAPTURE_LOCK_PATH = 'dist-validation/owned-vp8-v8-input-capture-lock.json';
export const V8_PRIOR_SOURCE_SHA = 'be35f5fa89a60189475fe2ef7fd446e9fa18cef4';
export const V8_PRIOR_LEGACY_WASM_SHA256 =
  '4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22';
export const V8_COMBINED_MODULE_SHA256 =
  'bd170496ba1f2574bd095effdc55b7cd102b203dcc347a472141fcfbd9284b0e';
const ALLOWED_CAPTURE_MODULES = new Set([
  'f962b9e803a014febc96d9a59bbab8faeb032866e837136c6afd8dd972fc4186',
  V8_COMBINED_MODULE_SHA256,
]);

// The prior asset SHA is pinned. The candidate needle came from the 4272
// reference; its actual asset SHA is frozen after the final source-bound build.
export const V8_MAIN_ASSETS = {
  prior: {
    sha256: 'f8745266b663b98aad72ede8ef7b4a440c5c920183173264fee8ee9be8b9cfb5',
    needle:
      'onFrameAvailable:async(n,i,a,c,u)=>{if(r?.aborted)throw T.release(n),new DOMException(`Cancelled`,`AbortError`);if(_.shouldSkip(a))T.release(n);else return gt(n,async()=>{',
    insertion: 'await globalThis.__wmcV8HashCallback(n,a,u);',
  },
  candidate: {
    needle:
      'onFrameAvailable:async(n,a,u,d,f)=>{if(r?.aborted)throw E.release(n),new DOMException(`Cancelled`,`AbortError`);if(T.shouldSkip(u))E.release(n);else return $t(n,async()=>{',
    insertion: 'await globalThis.__wmcV8HashCallback(n,u,f);',
  },
} as const;

export type V8CaptureBuild = 'prior' | 'candidate';
export type V8StreamedHashRow = {
  index: number;
  frameNum: number;
  startUs: number;
  endUs: number;
  logicalRgbBytes: number;
  chunks: number;
  sha256: string;
};
export type V8HashMessage =
  | {
      kind: 'begin';
      index: number;
      frameNum: number;
      startUs: number;
      endUs: number;
    }
  | { kind: 'chunk'; index: number; offset: number; base64: string }
  | { kind: 'end'; index: number };

export type V8CaptureBuildSource = {
  manifestSha256: string;
  state: {
    sourceSha: string;
    treeSha: string;
    coreSha: string;
    files: { path: string; size: number; sha256: string }[];
  };
};

/** Assemble only source-bound fields already checked by readBuild's exact inventory. */
export function createV8CaptureLock(prior: V8CaptureBuildSource, candidate: V8CaptureBuildSource) {
  const identity = (build: V8CaptureBuild, source: V8CaptureBuildSource) => {
    for (const value of [source.state.sourceSha, source.state.treeSha, source.state.coreSha])
      assert.match(value, /^[0-9a-f]{40}$/, `V8 ${build} source identity differs`);
    assert.match(source.manifestSha256, /^[0-9a-f]{64}$/, `V8 ${build} inventory digest differs`);
    const select = (pattern: RegExp, role: string) => {
      const matches = source.state.files.filter((file) => pattern.test(file.path));
      assert.equal(matches.length, 1, `V8 ${build} ${role} is not unique`);
      const file = matches[0]!;
      assert(
        Number.isSafeInteger(file.size) && file.size > 0 && /^[0-9a-f]{64}$/.test(file.sha256),
        `V8 ${build} ${role} identity differs`
      );
      return { path: file.path, size: file.size, sha256: file.sha256 };
    };
    const module = select(
      build === 'prior'
        ? /^assets\/webp-wasm[-.][\w-]{8}\.wasm$/
        : /^assets\/owned-vp8[-.][\w-]{8}\.wasm$/,
      'WASM module'
    );
    const callbackAsset = select(
      /^assets\/conversion-pipeline\.[\w-]{8}\.js$/,
      'main callback asset'
    );
    if (build === 'prior') {
      assert.equal(source.state.sourceSha, V8_PRIOR_SOURCE_SHA, 'V8 prior source pin differs');
      assert.equal(module.sha256, V8_PRIOR_LEGACY_WASM_SHA256, 'V8 prior WASM pin differs');
      assert.equal(
        callbackAsset.sha256,
        V8_MAIN_ASSETS.prior.sha256,
        'V8 prior main asset pin differs'
      );
    } else {
      assertV8CaptureBuild(source.state.sourceSha, module.sha256);
      assert.equal(module.sha256, V8_COMBINED_MODULE_SHA256, 'V8 combined WASM pin differs');
    }
    return {
      sourceSha: source.state.sourceSha,
      treeSha: source.state.treeSha,
      coreSha: source.state.coreSha,
      manifestSha256: source.manifestSha256,
      module,
      callbackAsset,
      callbackNeedleSha256: createHash('sha256').update(V8_MAIN_ASSETS[build].needle).digest('hex'),
    };
  };
  return {
    schemaVersion: 1 as const,
    scenario: 'owned-vp8-product-v8-low-inputs' as const,
    prior: identity('prior', prior),
    candidate: identity('candidate', candidate),
  };
}

export type V8CaptureLock = ReturnType<typeof createV8CaptureLock>;

export function assertV8CaptureLock(
  value: unknown,
  prior: V8CaptureBuildSource,
  candidate: V8CaptureBuildSource
): asserts value is V8CaptureLock {
  assert.deepEqual(
    value,
    createV8CaptureLock(prior, candidate),
    'V8 capture lock differs from built source'
  );
}

/** Patch only the retained main-software callback, after its pooled owner begins. */
export function patchV8MainEncoderCallback(
  original: Uint8Array,
  build: V8CaptureBuild,
  expectedBytes: number,
  expectedSha256: string
): { bytes: Uint8Array; originalSha256: string; patchedSha256: string } {
  const contract = V8_MAIN_ASSETS[build];
  if (build === 'prior')
    assert.equal(expectedSha256, V8_MAIN_ASSETS.prior.sha256, 'V8 prior main asset pin differs');
  assert.match(expectedSha256, /^[0-9a-f]{64}$/, 'V8 main asset digest is invalid');
  return patchV8ExactCallback(original, { ...contract, expectedBytes, sha256: expectedSha256 });
}

/** Exact-text boundary shared by the two pinned main assets and pure contract tests. */
export function patchV8ExactCallback(
  original: Uint8Array,
  contract: { sha256: string; expectedBytes: number; needle: string; insertion: string }
): { bytes: Uint8Array; originalSha256: string; patchedSha256: string } {
  assert.equal(original.byteLength, contract.expectedBytes, 'V8 main asset size differs');
  const originalSha256 = createHash('sha256').update(original).digest('hex');
  assert.equal(originalSha256, contract.sha256, 'V8 main asset digest differs');
  const source = Buffer.from(original).toString('utf8');
  assert.equal(source.split(contract.needle).length, 2, 'V8 main callback is not unique');
  const bytes = Buffer.from(source.replace(contract.needle, contract.needle + contract.insertion));
  return {
    bytes,
    originalSha256,
    patchedSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** Self-contained browser hook; the borrowed RGB view remains in its pooled owner. */
export function installV8AllInputHashCapture(): void {
  const logicalBytes = 1920 * 1080 * 3;
  const chunkBytes = 64 * 1024;
  let nextIndex = 0;
  let active = false;
  Reflect.set(
    globalThis,
    '__wmcV8HashCallback',
    async (pixels: Uint8Array, frameNum: number, timing: { startUs: number; endUs: number }) => {
      if (active || nextIndex >= 77) throw new Error('V8 streamed callback overlap or excess');
      if (!(pixels instanceof Uint8Array) || pixels.byteLength < logicalBytes)
        throw new Error('V8 streamed RGB extent differs');
      if (
        !Number.isSafeInteger(frameNum) ||
        frameNum < 0 ||
        !Number.isSafeInteger(timing?.startUs) ||
        !Number.isSafeInteger(timing?.endUs) ||
        timing.startUs < 0 ||
        timing.endUs <= timing.startUs
      )
        throw new Error('V8 streamed callback presentation differs');
      const send = Reflect.get(globalThis, '__wmcV8HashStream') as
        | ((message: V8HashMessage) => Promise<void>)
        | undefined;
      if (typeof send !== 'function') throw new Error('V8 streamed hash binding is absent');
      active = true;
      const index = nextIndex++;
      try {
        await send({
          kind: 'begin',
          index,
          frameNum,
          startUs: timing.startUs,
          endUs: timing.endUs,
        });
        for (let offset = 0; offset < logicalBytes; offset += chunkBytes) {
          const length = Math.min(chunkBytes, logicalBytes - offset);
          const view = pixels.subarray(offset, offset + length);
          let binary = '';
          for (let at = 0; at < view.length; at += 8192)
            binary += String.fromCharCode(...view.subarray(at, at + 8192));
          await send({ kind: 'chunk', index, offset, base64: btoa(binary) });
        }
        await send({ kind: 'end', index });
      } finally {
        active = false;
      }
    }
  );
}

/** Node-side bounded stream. Each completed row is durable before the next frame. */
export class V8IncrementalHashReceiver {
  private readonly rows: V8StreamedHashRow[] = [];
  private receiving = false;
  private active: {
    index: number;
    frameNum: number;
    startUs: number;
    endUs: number;
    offset: number;
    chunks: number;
    hash: ReturnType<typeof createHash>;
  } | null = null;

  constructor(
    private readonly output: string,
    private readonly build: V8CaptureBuild
  ) {}

  async consume(message: V8HashMessage): Promise<void> {
    assert(!this.receiving, 'V8 streamed binding calls overlap');
    this.receiving = true;
    try {
      await this.consumeOne(message);
    } finally {
      this.receiving = false;
    }
  }

  private async consumeOne(message: V8HashMessage): Promise<void> {
    if (message.kind === 'begin') {
      assert.equal(this.active, null, 'V8 streamed callback overlap');
      assert.equal(message.index, this.rows.length, 'V8 streamed callback ordinal differs');
      assert(message.index < EXPECTED_ENCODES, 'V8 streamed callback count exceeds bound');
      assert(
        Number.isSafeInteger(message.frameNum) && message.frameNum >= 0,
        'V8 streamed frame number differs'
      );
      assert(
        Number.isSafeInteger(message.startUs) &&
          Number.isSafeInteger(message.endUs) &&
          message.startUs >= 0 &&
          message.endUs > message.startUs,
        'V8 streamed presentation interval differs'
      );
      const previous = this.rows.at(-1);
      assert(
        previous
          ? message.frameNum > previous.frameNum && message.startUs > previous.startUs
          : message.startUs === 0,
        'V8 streamed presentation order differs'
      );
      this.active = {
        index: message.index,
        frameNum: message.frameNum,
        startUs: message.startUs,
        endUs: message.endUs,
        offset: 0,
        chunks: 0,
        hash: createHash('sha256'),
      };
      return;
    }
    const active = this.active;
    assert(active && message.index === active.index, 'V8 streamed callback ticket differs');
    if (message.kind === 'chunk') {
      assert.equal(message.offset, active.offset, 'V8 streamed chunk offset differs');
      const expected = Math.min(V8_CAPTURE_CHUNK, V8_RGB_BYTES - active.offset);
      assert(expected > 0, 'V8 streamed chunk exceeds logical RGB');
      const padding = '='.repeat((3 - (expected % 3)) % 3);
      assert(
        typeof message.base64 === 'string' &&
          message.base64.length === 4 * Math.ceil(expected / 3) &&
          message.base64.length <= V8_MAX_BASE64_CHARS &&
          /^[A-Za-z0-9+/]*={0,2}$/.test(message.base64) &&
          message.base64.endsWith(padding) &&
          (padding !== '' || !message.base64.includes('=')),
        'V8 streamed base64 shape differs before decode'
      );
      const bytes = Buffer.from(message.base64, 'base64');
      assert.equal(bytes.byteLength, expected, 'V8 streamed chunk length differs');
      assert.equal(bytes.toString('base64'), message.base64, 'V8 streamed base64 is noncanonical');
      active.hash.update(bytes);
      active.offset += bytes.byteLength;
      active.chunks++;
      return;
    }
    assert.equal(message.kind, 'end', 'V8 streamed message kind differs');
    assert.equal(active.offset, V8_RGB_BYTES, 'V8 streamed RGB is truncated');
    const row: V8StreamedHashRow = {
      index: active.index,
      frameNum: active.frameNum,
      startUs: active.startUs,
      endUs: active.endUs,
      logicalRgbBytes: active.offset,
      chunks: active.chunks,
      sha256: active.hash.digest('hex'),
    };
    const path = join(this.output, `owned-vp8-v8-all-input-${this.build}.jsonl`);
    const line = `${JSON.stringify(row)}\n`;
    if (row.index === 0) await writeFile(path, line, { flag: 'wx' });
    else await appendFile(path, line);
    this.rows.push(row);
    this.active = null;
  }

  snapshot(): {
    rows: readonly V8StreamedHashRow[];
    active: { index: number; offset: number } | null;
  } {
    return {
      rows: [...this.rows],
      active: this.active ? { index: this.active.index, offset: this.active.offset } : null,
    };
  }

  complete(): readonly V8StreamedHashRow[] {
    assert.equal(this.active, null, 'V8 streamed callback remains active');
    assert.equal(this.rows.length, EXPECTED_ENCODES, 'V8 streamed callback count differs');
    return [...this.rows];
  }
}

export function compareV8StreamedHashes(
  prior: readonly V8StreamedHashRow[],
  candidate: readonly V8StreamedHashRow[]
) {
  assert.equal(prior.length, EXPECTED_ENCODES);
  assert.equal(candidate.length, EXPECTED_ENCODES);
  return prior.map((row, index) => {
    const other = candidate[index]!;
    assert.equal(row.index, index);
    assert.equal(other.index, index);
    return {
      index,
      priorSha256: row.sha256,
      candidateSha256: other.sha256,
      samePixels: row.sha256 === other.sha256,
      sameFrameNum: row.frameNum === other.frameNum,
      samePresentation: row.startUs === other.startUs && row.endUs === other.endUs,
    };
  });
}

/** Git provenance and compiled module identity are distinct build fields. */
export function assertV8CaptureBuild(sourceSha: string, moduleSha256: string): void {
  assert.match(sourceSha, /^[0-9a-f]{40}$/, 'Candidate Git source SHA is invalid');
  assert.match(moduleSha256, /^[0-9a-f]{64}$/, 'Candidate owned WASM digest differs');
  assert(ALLOWED_CAPTURE_MODULES.has(moduleSha256), 'Candidate owned WASM digest differs');
}

export function captureIndex(ordinal: number): boolean {
  return V8_CAPTURE_INDICES.includes(ordinal as (typeof V8_CAPTURE_INDICES)[number]);
}

/** Pure contract for the complete observed-input stream, independent of ANMF coalescing. */
export function assertCaptureInventory(snapshot: {
  observedInputs: number;
  selected: Array<{ index: number; ticket: number; bytes: number }>;
  retainedBytes: number;
  error: string | null;
}): void {
  assert.equal(snapshot.error, null, `Pixel capture failed: ${snapshot.error}`);
  assert.equal(snapshot.observedInputs, EXPECTED_ENCODES, 'V8 observed input count differs');
  assert.deepEqual(
    snapshot.selected.map((entry) => entry.index),
    V8_CAPTURE_INDICES,
    'Selected observed input ordinals differ'
  );
  for (const entry of snapshot.selected) {
    assert.equal(entry.ticket, entry.index + 1, 'Selected frame ticket is stale');
    assert.equal(entry.bytes, V8_RGB_BYTES, 'Selected packed RGB extent differs');
  }
  assert(snapshot.retainedBytes <= V8_CAPTURE_BUDGET, 'Page copy budget exceeded');
  assert.equal(snapshot.retainedBytes, V8_CAPTURE_INDICES.length * V8_RGB_BYTES);
}

/** Installed before app code. It owns only five new host ArrayBuffers, never a WASM view. */
export function installV8PixelCapture(mode: 'prior' | 'candidate') {
  const width = 1920;
  const height = 1080;
  const stride = width * 3;
  const pixelBytes = stride * height;
  const legacyCopyBytes = 8 * 1024 * 1024;
  const selected = [0, 19, 38, 57, 76];
  const budget = 32 * 1024 * 1024;
  const frames = new Map<number, { ticket: number; bytes: Uint8Array }>();
  let observedInputs = 0;
  let retainedBytes = 0;
  let error: string | null = null;
  let generation: number | null = null;
  const fail = (reason: string): never => {
    error = reason;
    throw new Error(`V8 pixel capture: ${reason}`);
  };
  const validWord = (word: number) => Number.isSafeInteger(word) && word > 0;
  const save = (index: number, ticket: number, source: Uint8Array, alreadyOwned = false) => {
    if (!selected.includes(index)) return;
    if (ticket !== index + 1) fail('stale selected frame ticket');
    if (source.byteLength !== pixelBytes || retainedBytes + pixelBytes > budget)
      fail('selected pixel extent or copy budget differs');
    if (frames.has(index)) fail('duplicate selected frame');
    const copy = alreadyOwned ? source : new Uint8Array(source);
    frames.set(index, { ticket, bytes: copy });
    retainedBytes += copy.byteLength;
  };
  const state = {
    snapshot() {
      return {
        mode,
        observedInputs,
        selected: [...frames]
          .sort(([a], [b]) => a - b)
          .map(([index, frame]) => ({
            index,
            ticket: frame.ticket,
            bytes: frame.bytes.byteLength,
          })),
        retainedBytes,
        error,
      };
    },
    chunk(index: number, offset: number, length: number) {
      const frame = frames.get(index);
      if (
        !frame ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length <= 0 ||
        length > 64 * 1024 ||
        offset + length > frame.bytes.byteLength
      )
        return fail('invalid pixel stream extent');
      // At most 64 KiB raw becomes 87,384 base64 characters, plus the RPC envelope.
      const bytes = frame.bytes.subarray(offset, offset + length);
      let binary = '';
      for (let at = 0; at < bytes.length; at += 8192)
        binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
      return btoa(binary);
    },
    release(index: number) {
      const frame = frames.get(index);
      if (!frame) return fail('pixel frame already released');
      retainedBytes -= frame.bytes.byteLength;
      frames.delete(index);
    },
  };
  Reflect.set(globalThis, '__wmcV8PixelCapture', state);
  if (mode === 'prior') {
    Reflect.set(
      globalThis,
      '__wmcVp8LegacyCopy',
      (heap: Uint8Array, _unused: unknown, offset: number, count: number, source: Uint8Array) => {
        // The pinned main loader calls this *after* its actual indexed copy loop.
        // be35 passes its full power-of-two RGB pool view through std::string.
        if (
          !(heap instanceof Uint8Array) ||
          !(source instanceof Uint8Array) ||
          source.byteLength !== legacyCopyBytes ||
          count !== legacyCopyBytes ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset + count > heap.byteLength
        )
          fail('legacy RGB destination is invalid');
        const index = observedInputs++;
        save(index, index + 1, heap.subarray(offset, offset + pixelBytes));
      }
    );
    return;
  }
  const NativeInstance = WebAssembly.Instance;
  WebAssembly.Instance = new Proxy(NativeInstance, {
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget);
      const exported = instance.exports as Record<string, unknown>;
      if (typeof exported.vp8_v2_begin !== 'function') return instance;
      const memory = exported.memory;
      const responsePointer = exported.vp8_v2_response_ptr;
      const requestPointer = exported.vp8_v2_request_ptr;
      if (
        !(memory instanceof WebAssembly.Memory) ||
        typeof responsePointer !== 'function' ||
        typeof requestPointer !== 'function'
      )
        return fail('owned ABI exports are absent');
      const wrapped = Object.fromEntries(
        Object.entries(exported).map(([key, value]) => [
          key,
          key === 'vp8_v2_begin' && typeof value === 'function'
            ? (...parameters: unknown[]) => {
                const buffer = memory.buffer;
                const responseAt = Reflect.apply(responsePointer, exported, []) as number;
                const requestAt = Reflect.apply(requestPointer, exported, []) as number;
                if (
                  !validWord(responseAt) ||
                  !validWord(requestAt) ||
                  responseAt + 96 > buffer.byteLength ||
                  requestAt + 48 > buffer.byteLength
                )
                  return fail('owned ABI record extent is invalid');
                const response = new DataView(buffer, responseAt, 96);
                const request = new DataView(buffer, requestAt, 48);
                const rw = (index: number) => response.getUint32(index * 4, true);
                const qw = (index: number) => request.getUint32(index * 4, true);
                const ticket = observedInputs + 1;
                if (
                  rw(0) !== 2 ||
                  rw(1) !== 0 ||
                  rw(2) !== 3 ||
                  rw(3) !== parameters[0] ||
                  rw(4) !== parameters[1] ||
                  !validWord(rw(3)) ||
                  rw(4) !== ticket ||
                  qw(0) !== 2 ||
                  qw(1) !== width ||
                  qw(2) !== height ||
                  qw(3) !== stride ||
                  qw(4) !== 4 ||
                  qw(5) !== 60 ||
                  qw(6) !== pixelBytes ||
                  qw(8) !== rw(3) ||
                  qw(9) !== ticket ||
                  rw(6) !== pixelBytes ||
                  !validWord(rw(5)) ||
                  rw(5) + rw(6) > buffer.byteLength ||
                  rw(9) !== buffer.byteLength
                )
                  return fail(
                    'owned input lease, request or ticket differs from frozen RGB contract'
                  );
                if (generation === null) generation = rw(3);
                else if (generation !== rw(3)) return fail('owned generation changed');
                const index = observedInputs;
                // Copy before begin mutates phase/lease. Publish only after success.
                const pending = selected.includes(index)
                  ? new Uint8Array(new Uint8Array(buffer, rw(5), pixelBytes))
                  : null;
                const status = Reflect.apply(value, exported, parameters) as number;
                if (status !== 10) return status;
                observedInputs++;
                if (pending) save(index, ticket, pending, true);
                return status;
              }
            : value,
        ])
      );
      return new Proxy(instance, {
        get(source, key) {
          return key === 'exports' ? wrapped : Reflect.get(source, key);
        },
      });
    },
  });
}

export type CapturedPixel = {
  index: number;
  ticket: number;
  file: string;
  bytes: number;
  sha256: string;
};

export function compareCapturedPixels(
  prior: readonly CapturedPixel[],
  candidate: readonly CapturedPixel[]
) {
  assert.deepEqual(
    prior.map((pixel) => pixel.index),
    V8_CAPTURE_INDICES,
    'Prior selected pixel indices differ'
  );
  assert.deepEqual(
    candidate.map((pixel) => pixel.index),
    V8_CAPTURE_INDICES,
    'Candidate selected pixel indices differ'
  );
  return prior.map((pixel, at) => ({
    index: pixel.index,
    priorSha256: pixel.sha256,
    candidateSha256: candidate[at]!.sha256,
    same: pixel.sha256 === candidate[at]!.sha256,
  }));
}

export async function streamCapturedRgb(
  page: Page,
  output: string,
  build: 'prior' | 'candidate'
): Promise<CapturedPixel[]> {
  const snapshot = (await page.evaluate(() => {
    const state = Reflect.get(globalThis, '__wmcV8PixelCapture') as {
      snapshot: () => Parameters<typeof assertCaptureInventory>[0];
    };
    return state.snapshot();
  })) as Parameters<typeof assertCaptureInventory>[0];
  assertCaptureInventory(snapshot);
  const result: CapturedPixel[] = [];
  for (const index of V8_CAPTURE_INDICES) {
    const file = `owned-vp8-v8-low-input-${build}-${String(index).padStart(2, '0')}.rgb`;
    const handle = await open(join(output, file), 'wx');
    const hash = createHash('sha256');
    try {
      for (let offset = 0; offset < V8_RGB_BYTES; offset += V8_CAPTURE_CHUNK) {
        const length = Math.min(V8_CAPTURE_CHUNK, V8_RGB_BYTES - offset);
        const base64 = await page.evaluate(
          ({ index, offset, length }) => {
            const state = Reflect.get(globalThis, '__wmcV8PixelCapture') as {
              chunk: (index: number, offset: number, length: number) => string;
            };
            return state.chunk(index, offset, length);
          },
          { index, offset, length }
        );
        const bytes = Buffer.from(base64, 'base64');
        assert(
          base64.length <= 4 * Math.ceil(length / 3) && bytes.toString('base64') === base64,
          'Pixel stream encoding is noncanonical or exceeds its encoded bound'
        );
        assert.equal(bytes.length, length, 'Pixel stream chunk changed size');
        const written = await handle.write(bytes, 0, bytes.length, offset);
        assert.equal(written.bytesWritten, length, 'Pixel stream write was short');
        hash.update(bytes);
      }
    } finally {
      await handle.close();
    }
    const expectedSha256 = hash.digest('hex');
    assert.equal((await stat(join(output, file))).size, V8_RGB_BYTES, 'Saved RGB size differs');
    const savedHash = createHash('sha256');
    for await (const bytes of createReadStream(join(output, file), {
      highWaterMark: V8_CAPTURE_CHUNK,
    }))
      savedHash.update(bytes);
    assert.equal(
      savedHash.digest('hex'),
      expectedSha256,
      'Saved RGB digest differs from page stream'
    );
    result.push({ index, ticket: index + 1, file, bytes: V8_RGB_BYTES, sha256: expectedSha256 });
    await page.evaluate((index) => {
      const state = Reflect.get(globalThis, '__wmcV8PixelCapture') as {
        release: (index: number) => void;
      };
      state.release(index);
    }, index);
  }
  const remaining = await page.evaluate(() => {
    const state = Reflect.get(globalThis, '__wmcV8PixelCapture') as {
      snapshot: () => { retainedBytes: number; selected: unknown[] };
    };
    return state.snapshot();
  });
  assert.equal(remaining.retainedBytes, 0, 'Pixel copies remained in page');
  assert.deepEqual(remaining.selected, [], 'Pixel frame references remained in page');
  return result;
}
