// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Browser, BrowserContext, ConsoleMessage, Page } from '@playwright/test';

import { installMotionObserver } from '../motion-signature.ts';
import { installVp8TimingProbe } from '../vp8-timing-probe.ts';
import {
  collectGarbageCheckpoint,
  installRetainedWorkerProbe,
  installWorkerLifecycleObserver,
  verifyOwnerRetention,
} from './owned-vp8-owner-retention.ts';

type Build = {
  relativePath: string;
  manifestSha256: string;
  state: {
    sourceSha: string;
    treeSha: string;
    coreSha: string;
    files: { path: string; size: number; sha256: string }[];
  };
};
type Server = {
  url: string;
  setDistribution: (path: string) => Promise<void>;
};
type Fixture = {
  id: string;
  path: string;
  mime: string;
  width: number;
  height: number;
  durationMs: number;
};
export const CLUSTER_SCENE_TIMELINE = [
  { scene: 'red', startMs: 0, endMs: 1_000 },
  { scene: 'lime', startMs: 1_000, endMs: 2_000 },
  { scene: 'blue', startMs: 2_000, endMs: 3_000 },
  { scene: 'yellow', startMs: 3_000, endMs: 4_000 },
] as const;
const NEAR_CAP_SCENE_TIMELINE = [
  { scene: 'red', startMs: 0, endMs: 500 },
  { scene: 'blue', startMs: 500, endMs: 1_000 },
] as const;
type Quality = 'low' | 'medium' | 'high';
type Sample = {
  build: 'prior' | 'candidate';
  fixture: string;
  quality: Quality;
  condition: string;
  [key: string]: unknown;
};

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 96 * 1024 * 1024;
const MAX_FRAMES = 400;
const CONVERSION_TIMEOUT_MS = 180_000;
const CADENCE: Readonly<Record<Quality, number>> = { low: 12, medium: 18, high: 30 };
const FIXTURES: readonly Fixture[] = [
  {
    id: 'h264-ci',
    path: 'public/test-video-ci-h264.mp4',
    mime: 'video/mp4',
    width: 160,
    height: 90,
    durationMs: 1_000,
  },
  {
    id: 'clusters',
    path: 'public/test-video-contract-clusters.webm',
    mime: 'video/webm',
    width: 96,
    height: 64,
    durationMs: 4_000,
  },
];
const V8_FIXTURE: Fixture = {
  id: 'v8-full',
  path: 'validation/windows/owned-vp8-inputs/v8.webm',
  mime: 'video/webm',
  width: 1920,
  height: 1080,
  durationMs: 6_400,
};
const V8_SHA256 = 'c6a21a3a7619ca7fbcbc1b4d012d7098d18f599f0200f735d31cae15a4772dd1';
const NEAR_CAP_FIXTURE: Fixture = {
  id: 'near-cap',
  path: 'dist-validation/owned-vp8-near-cap.webm',
  mime: 'video/webm',
  width: 4096,
  height: 2457,
  durationMs: 1_000,
};
const LARGE_ADMITTED_FIXTURE: Fixture = {
  id: 'large-admitted',
  path: 'dist-validation/owned-vp8-large-admitted.webm',
  mime: 'video/webm',
  width: 4032,
  height: 2457,
  durationMs: 1_000,
};
const MAX_ADMITTED_FRAME_PIXELS = 10_066_329;
const PINNED_PRIOR_LEGACY_WASM_SHA256 =
  '4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22';
const PINNED_PRIOR_LEGACY_LOADER_SHA256 =
  '15cd582651f78831babe9b54012388f22614c48b39c899fa2772e62b037dae47';
const LEGACY_COPY_LOOP = 'else for(var s=0;s<r;++s)b[o+s]=t[s];return e!==null';
const LEGACY_OBSERVED_COPY_LOOP =
  'else{for(var s=0;s<r;++s)b[o+s]=t[s];globalThis.__wmcVp8LegacyCopy?.(b,oe,o,s,t)}return e!==null';

export function patchPinnedLegacyLoader(original: Uint8Array) {
  assert.equal(
    digest(original),
    PINNED_PRIOR_LEGACY_LOADER_SHA256,
    'Prior loader is not the frozen compiled source'
  );
  const source = Buffer.from(original).toString('utf8');
  assert.equal(source.split(LEGACY_COPY_LOOP).length, 2, 'Prior loader copy loop is not unique');
  const patched = Buffer.from(source.replace(LEGACY_COPY_LOOP, LEGACY_OBSERVED_COPY_LOOP));
  return { bytes: patched, sha256: digest(patched) };
}
const STOP_FIXTURE = 'public/test-video-ci-high-motion-120fps.mp4';
/** Frozen owned-demux oracle for the generated 96x64 clustered VP9 fixture. */
export const DIRECT_WORKER_CLUSTER_CONFIG = {
  codec: 'vp09.00.10.08.01.02.02.02.00',
  codedWidth: 96,
  codedHeight: 64,
  colorSpace: { fullRange: false },
} as const;
export const DIRECT_WORKER_OPTIONS = {
  format: 'webp',
  quality: 'medium',
  fps: 4,
  scale: 1,
  trimStart: 0,
  trimEnd: 4,
  maxFrames: MAX_FRAMES,
  maxOutputBytes: MAX_OUTPUT_BYTES,
  smartFrameSkip: 'off',
  maxMemoryMB: 512,
} as const;
const OWNED_FIELDS = [
  'ownedVp8Frames',
  'ownedVp8Steps',
  'ownedVp8HostTaskYields',
  'ownedVp8PeakActualLinearCapacityBytes',
  'ownedVp8PeakReservedLinearCapacityBytes',
] as const;
const MAX_FAILURE_CONSOLE_LINES = 64;
const MAX_FAILURE_CONSOLE_CHARS = 2_048;

export function captureNearCapConsole(page: Page) {
  const lines: Array<{ level: 'warning' | 'error'; text: string }> = [];
  const onConsole = (message: ConsoleMessage) => {
    try {
      const level = message.type();
      if (level !== 'warning' && level !== 'error') return;
      const text = message.text().slice(0, MAX_FAILURE_CONSOLE_CHARS);
      if (lines.length === MAX_FAILURE_CONSOLE_LINES) lines.shift();
      lines.push({ level, text });
    } catch {
      // A failed diagnostic listener cannot interrupt the conversion.
    }
  };
  page.on('console', onConsole);
  return {
    snapshot: () => lines.map((line) => ({ ...line })),
    detach: () => {
      try {
        page.off('console', onConsole);
      } catch {
        // Page teardown must not replace the original conversion failure.
      }
    },
  };
}

export function instrumentNearCapDecodedFrames() {
  const state = {
    installed: false,
    outputCount: 0,
    records: [] as Array<{
      codedWidth: number;
      codedHeight: number;
      displayWidth: number;
      displayHeight: number;
      format: string | null;
      allocationSizeBytes: number | null;
      allocationSizeStatus: 'available' | 'unavailable' | 'threw' | 'invalid';
    }>,
  };
  Reflect.set(globalThis, '__wmcNearCapDecodedFrames', state);
  const NativeDecoder = globalThis.VideoDecoder;
  if (typeof NativeDecoder !== 'function') return;
  state.installed = Reflect.set(
    globalThis,
    'VideoDecoder',
    new Proxy(NativeDecoder, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        return key === 'isConfigSupported' && typeof value === 'function'
          ? value.bind(target)
          : value;
      },
      construct(target, args, newTarget) {
        const init = args[0] as VideoDecoderInit | undefined;
        let observedInit: VideoDecoderInit | undefined;
        try {
          const output = init?.output;
          if (typeof output === 'function') {
            observedInit = Object.create(init!) as VideoDecoderInit;
            Object.defineProperty(observedInit, 'output', {
              value: function (this: unknown, ...outputArgs: unknown[]) {
                try {
                  state.outputCount++;
                  const frame = outputArgs[0] as VideoFrame;
                  const frameFormat = frame.format;
                  const format = frameFormat == null ? null : String(frameFormat).slice(0, 32);
                  const record = {
                    codedWidth: frame.codedWidth,
                    codedHeight: frame.codedHeight,
                    displayWidth: frame.displayWidth,
                    displayHeight: frame.displayHeight,
                    format,
                    allocationSizeBytes: null as number | null,
                    allocationSizeStatus: 'unavailable' as
                      | 'available'
                      | 'unavailable'
                      | 'threw'
                      | 'invalid',
                  };
                  const allocationSize = frame.allocationSize;
                  if (format !== null && typeof allocationSize === 'function') {
                    try {
                      const size = Reflect.apply(allocationSize, frame, []) as number;
                      if (Number.isSafeInteger(size) && size >= 0) {
                        record.allocationSizeBytes = size;
                        record.allocationSizeStatus = 'available';
                      } else record.allocationSizeStatus = 'invalid';
                    } catch {
                      record.allocationSizeStatus = 'threw';
                    }
                  }
                  if (state.records.length === 8) state.records.shift();
                  state.records.push(record);
                } catch {
                  // Frame metadata observation must not replace the native output callback.
                }
                return Reflect.apply(output, this, outputArgs);
              },
            });
          }
        } catch {
          // Constructor observation must not replace the native construction outcome.
          return Reflect.construct(target, args, newTarget);
        }
        return Reflect.construct(
          target,
          observedInit ? [observedInit, ...args.slice(1)] : args,
          newTarget
        );
      },
    })
  );
}

export function assertLargeAdmittedDecodedFrames(value: {
  installed: boolean;
  outputCount: number;
  records: Array<{
    codedWidth: number;
    codedHeight: number;
    displayWidth: number;
    displayHeight: number;
  }>;
}): void {
  assert(value?.installed, 'Large admitted decoder output observer is absent');
  assert(
    Number.isSafeInteger(value.outputCount) && value.outputCount > 0 && value.outputCount <= 8,
    'Large admitted decoder output count is absent or exceeds capture bound'
  );
  assert.equal(value.records.length, value.outputCount, 'Decoded frame metadata is incomplete');
  for (const frame of value.records) {
    for (const [width, height] of [
      [frame.codedWidth, frame.codedHeight],
      [frame.displayWidth, frame.displayHeight],
    ] as const) {
      assert(
        Number.isSafeInteger(width) &&
          Number.isSafeInteger(height) &&
          width > 0 &&
          height > 0 &&
          width <= MAX_ADMITTED_FRAME_PIXELS / height,
        'Large admitted decoded frame exceeds the existing per-frame pixel limit'
      );
    }
    assert.equal(frame.displayWidth, LARGE_ADMITTED_FIXTURE.width);
    assert.equal(frame.displayHeight, LARGE_ADMITTED_FIXTURE.height);
  }
}

type FunctionalAbiProbe = {
  instances: number;
  successfulBeginCalls: number;
  stepCalls: number;
  records: Array<{
    stepCalls: number;
    retireCalls: number;
    retireStatus: number | null;
    peakCapacityBytes: number;
    retainedCapacityBytes: number | null;
  }>;
};
type FetchedWasm = { path: string; bytes: number; sha256: string };
type WasmInventoryEntry = { path: string; size: number; sha256: string };

export function assertFunctionalBackendEvidence(
  build: 'prior' | 'candidate',
  probe: FunctionalAbiProbe,
  fetched: readonly FetchedWasm[],
  inventory: readonly WasmInventoryEntry[]
): WasmInventoryEntry {
  if (build === 'prior') {
    assert(
      probe.instances === 0 &&
        probe.successfulBeginCalls === 0 &&
        probe.stepCalls === 0 &&
        probe.records.length === 0,
      'Prior unexpectedly executed owned VP8 ABI'
    );
    const legacy = inventory.filter((entry) =>
      /^assets\/webp-wasm[-.][\w-]{8}\.wasm$/.test(entry.path)
    );
    assert.equal(legacy.length, 1, 'Prior legacy WebP WASM inventory is not unique');
    const asset = legacy[0]!;
    assert.equal(
      asset.sha256,
      PINNED_PRIOR_LEGACY_WASM_SHA256,
      'Prior legacy WebP WASM is not pinned'
    );
    assert(
      fetched.some(
        (entry) =>
          entry.path === asset.path && entry.bytes === asset.size && entry.sha256 === asset.sha256
      ),
      'Prior did not fetch the pinned legacy WebP WASM bytes'
    );
    return asset;
  }
  assert(
    probe.instances > 0 && probe.successfulBeginCalls > 0 && probe.stepCalls > 0,
    'Candidate conversion missed owned WASM begin/step'
  );
  assert(
    probe.records.some(
      (entry) =>
        entry.stepCalls > 0 &&
        entry.retireCalls > 0 &&
        entry.retireStatus === 0 &&
        entry.peakCapacityBytes > 0 &&
        entry.peakCapacityBytes <= 192 * 1024 * 1024 &&
        entry.retainedCapacityBytes !== null &&
        entry.retainedCapacityBytes >= entry.peakCapacityBytes &&
        entry.retainedCapacityBytes <= 192 * 1024 * 1024
    ),
    'Candidate retained owned linear capacity is absent or exceeds admission'
  );
  const owned = inventory.filter((entry) =>
    /^assets\/owned-vp8[-.][\w-]{8}\.wasm$/.test(entry.path)
  );
  assert.equal(owned.length, 1, 'Candidate owned WASM inventory is not unique');
  const asset = owned[0]!;
  assert(
    fetched.some(
      (entry) =>
        entry.path === asset.path && entry.bytes === asset.size && entry.sha256 === asset.sha256
    ),
    'Candidate fetched owned WASM differs from inventory'
  );
  assert(
    !fetched.some((entry) => /^assets\/webp-wasm[-.][\w-]{8}\.wasm$/.test(entry.path)),
    'Candidate fetched legacy WebP WASM'
  );
  return asset;
}

export function functionalFailureRecord(
  build: 'prior' | 'candidate',
  error: unknown,
  evidence: {
    checked?:
      | Pick<
          Awaited<ReturnType<typeof measureJob>>,
          'fixture' | 'inputSha256' | 'saved' | 'parsed' | 'decoded'
        >
      | undefined;
    probe?: FunctionalAbiProbe | undefined;
    decodedFrameProbe?: unknown;
    fetchedWasm?: FetchedWasm[] | undefined;
  }
) {
  return {
    phase: 'failed' as const,
    build,
    status: 'failed' as const,
    error: failure(error),
    fixture: evidence.checked?.fixture,
    inputSha256: evidence.checked?.inputSha256,
    saved: evidence.checked?.saved,
    parsed: evidence.checked?.parsed,
    decoded: evidence.checked?.decoded,
    probe: evidence.probe,
    decodedFrameProbe: evidence.decodedFrameProbe,
    fetchedWasm: evidence.fetchedWasm,
  };
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function failure(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function captureFailure(
  page: Page,
  output: string,
  caseId: string,
  error: unknown,
  pageErrors: string[],
  nearCapConsole?: Array<{ level: 'warning' | 'error'; text: string }>
): Promise<void> {
  const record: Record<string, unknown> = {
    caseId,
    error: failure(error),
    pageErrors: pageErrors.slice(-32).map((message) => message.slice(0, 512)),
  };
  try {
    record.url = page.url();
  } catch (captureError) {
    record.urlError = failure(captureError);
  }
  if (nearCapConsole) {
    record.consoleWarningsAndErrors = nearCapConsole
      .slice(-MAX_FAILURE_CONSOLE_LINES)
      .map((line) => ({
        level: line.level,
        text: line.text.slice(0, MAX_FAILURE_CONSOLE_CHARS),
      }));
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        record.nearCapState = await Promise.race([
          page.evaluate(() => {
            const abi = Reflect.get(globalThis, '__wmcVp8AbiProbe') as
              | {
                  instances: number;
                  stepCalls: number;
                  successfulBeginCalls: number;
                  beginStatusCounts: Record<string, number>;
                  statusCounts: Record<string, number>;
                  records: Array<{
                    id: number;
                    stepCalls: number;
                    retireCalls: number;
                    retireStatus: number | null;
                    peakCapacityBytes: number;
                    retainedCapacityBytes: number | null;
                  }>;
                }
              | undefined;
            const observed = Reflect.get(globalThis, '__wmcVp8ProductObserver') as
              | { publicationCount: number; publications: Array<{ size: number; atMs: number }> }
              | undefined;
            const decodedFrames = Reflect.get(globalThis, '__wmcNearCapDecodedFrames') as
              | {
                  installed: boolean;
                  outputCount: number;
                  records: Array<{
                    codedWidth: number;
                    codedHeight: number;
                    displayWidth: number;
                    displayHeight: number;
                    format: string | null;
                    allocationSizeBytes: number | null;
                    allocationSizeStatus: string;
                  }>;
                }
              | undefined;
            return {
              abi: abi
                ? {
                    instances: abi.instances,
                    stepCalls: abi.stepCalls,
                    successfulBeginCalls: abi.successfulBeginCalls,
                    beginStatusCounts: { ...abi.beginStatusCounts },
                    statusCounts: { ...abi.statusCounts },
                    records: abi.records.slice(-32).map((entry) => ({ ...entry })),
                  }
                : null,
              publication: observed
                ? {
                    count: observed.publicationCount,
                    recent: observed.publications.slice(-16).map(({ size, atMs }) => ({
                      size,
                      atMs,
                    })),
                  }
                : null,
              decodedFrames: decodedFrames
                ? {
                    outputCount: decodedFrames.outputCount,
                    installed: decodedFrames.installed,
                    records: decodedFrames.records.slice(-8).map((record) => ({ ...record })),
                  }
                : null,
              fallbackResourceCount: performance
                .getEntriesByType('resource')
                .filter((entry) =>
                  /\/(?:webp-wasm|wasm-webp)[\w.-]*\.(?:wasm|js)$/.test(
                    new URL(entry.name).pathname
                  )
                ).length,
            };
          }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Near-cap state snapshot timed out')),
              3_000
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } catch (captureError) {
      record.nearCapStateError = failure(captureError);
    }
  }
  try {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      record.dom = await Promise.race([
        page.evaluate(() => document.documentElement.outerHTML.slice(0, 32_768)),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('DOM snapshot timed out')), 5_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } catch (captureError) {
    record.domError = failure(captureError);
  }
  try {
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 5_000 });
    if (screenshot.byteLength <= 2 * 1024 * 1024) {
      const file = `${caseId}-failure.jpg`;
      await writeFile(join(output, file), screenshot);
      record.screenshot = { file, bytes: screenshot.byteLength, sha256: digest(screenshot) };
    } else {
      record.screenshotError = 'Viewport screenshot exceeded 2 MiB';
    }
  } catch (captureError) {
    record.screenshotError = failure(captureError);
  }
  try {
    await writeFile(join(output, `${caseId}-failure.json`), `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // Preserve the original product or harness failure if diagnostics cannot be written.
  }
}

function u24(bytes: Buffer, offset: number): number {
  assert(offset + 3 <= bytes.length, 'Truncated WebP 24-bit field');
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

export function parseAnimatedWebp(bytes: Buffer) {
  assert(
    bytes.length >= 30 && bytes.length <= MAX_OUTPUT_BYTES,
    'WebP output size is outside bound'
  );
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length, 'WebP RIFF length differs from file');
  let offset = 12;
  let canvas: { width: number; height: number } | null = null;
  let loopCount: number | null = null;
  let iccFlag = false;
  let iccPayload: { bytes: number; sha256: string } | null = null;
  const frames: Array<{
    index: number;
    x: number;
    y: number;
    width: number;
    height: number;
    durationMs: number;
    flags: number;
    vp8Sha256: string;
  }> = [];
  while (offset + 8 <= bytes.length) {
    const tag = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    assert(end + (size & 1) <= bytes.length, `Truncated WebP ${tag} chunk`);
    if (size & 1) assert.equal(bytes[end], 0, `Nonzero WebP ${tag} padding`);
    if (tag === 'VP8X') {
      assert.equal(canvas, null, 'Repeated VP8X chunk');
      assert.equal(size, 10);
      assert(bytes[start]! & 0x02, 'WebP animation flag is absent');
      iccFlag = Boolean(bytes[start]! & 0x20);
      canvas = { width: u24(bytes, start + 4) + 1, height: u24(bytes, start + 7) + 1 };
    } else if (tag === 'ICCP') {
      assert(canvas && loopCount === null && iccPayload === null, 'ICCP is missing or repeated');
      assert(size > 0, 'ICCP payload is empty');
      iccPayload = { bytes: size, sha256: digest(bytes.subarray(start, end)) };
    } else if (tag === 'ANIM') {
      assert(canvas && loopCount === null, 'ANIM is missing or repeated');
      assert.equal(size, 6);
      loopCount = bytes.readUInt16LE(start + 4);
    } else if (tag === 'ANMF') {
      assert(canvas && loopCount !== null, 'ANMF preceded animation header');
      assert(size >= 16, 'ANMF header is truncated');
      const frame = {
        index: frames.length,
        x: 2 * u24(bytes, start),
        y: 2 * u24(bytes, start + 3),
        width: u24(bytes, start + 6) + 1,
        height: u24(bytes, start + 9) + 1,
        durationMs: u24(bytes, start + 12),
        flags: bytes[start + 15]!,
        vp8Sha256: '',
      };
      assert(frame.durationMs > 0, 'ANMF has a zero hold');
      assert(
        frame.x + frame.width <= canvas.width && frame.y + frame.height <= canvas.height,
        'ANMF geometry escapes canvas'
      );
      let child = start + 16;
      let vp8 = 0;
      while (child + 8 <= end) {
        const childTag = bytes.toString('ascii', child, child + 4);
        const childSize = bytes.readUInt32LE(child + 4);
        const childStart = child + 8;
        const childEnd = childStart + childSize;
        assert(childEnd + (childSize & 1) <= end, 'ANMF child escapes frame');
        assert.equal(childTag, 'VP8 ', 'Owned software output must contain opaque VP8 frames');
        assert.equal(vp8++, 0, 'ANMF contains multiple VP8 payloads');
        assert(childSize >= 10, 'VP8 payload is truncated');
        assert.equal(
          bytes.toString('hex', childStart + 3, childStart + 6),
          '9d012a',
          'VP8 keyframe marker differs'
        );
        const codedWidth = bytes.readUInt16LE(childStart + 6) & 0x3fff;
        const codedHeight = bytes.readUInt16LE(childStart + 8) & 0x3fff;
        assert.equal(codedWidth, frame.width, 'VP8 coded width differs from ANMF');
        assert.equal(codedHeight, frame.height, 'VP8 coded height differs from ANMF');
        frame.vp8Sha256 = digest(bytes.subarray(childStart, childEnd));
        child = childEnd + (childSize & 1);
      }
      assert.equal(vp8, 1, 'ANMF has no VP8 payload');
      assert.equal(child, end, 'ANMF child boundary differs');
      frames.push(frame);
      assert(frames.length <= MAX_FRAMES, 'WebP frame count exceeded verification bound');
    }
    offset = end + (size & 1);
  }
  assert.equal(offset, bytes.length, 'WebP trailing bytes differ');
  assert.equal(iccFlag, iccPayload !== null, 'WebP ICC flag and ICCP chunk differ');
  assert(
    canvas && loopCount === 0 && frames.length > 0,
    'WebP animation or infinite loop is missing'
  );
  assert.equal(frames[0]!.x, 0, 'First frame is not anchored at origin');
  assert.equal(frames[0]!.y, 0, 'First frame is not anchored at origin');
  assert.equal(frames[0]!.width, canvas.width, 'First frame does not cover canvas width');
  assert.equal(frames[0]!.height, canvas.height, 'First frame does not cover canvas height');
  return {
    canvas,
    loopCount,
    icc: { flag: iccFlag, payload: iccPayload },
    frames,
    totalDurationMs: frames.reduce((sum, frame) => sum + frame.durationMs, 0),
  };
}

/** Independent installed-browser decode, after the conversion timing interval. */
async function decodeWebp(page: Page, bytes: Buffer, inspectAllPixels = false) {
  return page.evaluate(
    async ({ base64, inspectAllPixels }) => {
      assertDecoder();
      function assertDecoder() {
        if (typeof ImageDecoder !== 'function') throw new Error('ImageDecoder unavailable');
      }
      const data = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const decoder = new ImageDecoder({ data, type: 'image/webp', preferAnimation: true });
      try {
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack;
        if (!track || track.frameCount < 1 || track.frameCount > 400)
          throw new Error('Decoded WebP frame count outside bound');
        if (track.repetitionCount !== Infinity)
          throw new Error(`Animated WebP must repeat indefinitely, got ${track.repetitionCount}`);
        const frames: Array<{
          width: number;
          height: number;
          durationMs: number;
          centerRgb: number[];
          pixelSha256: string;
          scene?: string;
          scenePixelCount?: number;
          totalPixels?: number;
        }> = [];
        const canvas = new OffscreenCanvas(inspectAllPixels ? 96 : 16, inspectAllPixels ? 64 : 16);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('ImageDecoder sample canvas unavailable');
        for (let index = 0; index < track.frameCount; index++) {
          const result = await decoder.decode({ frameIndex: index, completeFramesOnly: true });
          const image = result.image;
          try {
            if (!result.complete) throw new Error(`Incomplete WebP frame ${index}`);
            const width = image.displayWidth;
            const height = image.displayHeight;
            // Decode every frame at native geometry. Hash every pixel for the
            // small cluster source; larger sources use a fixed spatial sample
            // to keep post-conversion verification memory bounded.
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            const center =
              (Math.floor(canvas.height / 2) * canvas.width + Math.floor(canvas.width / 2)) * 4;
            const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', pixels));
            const frame: (typeof frames)[number] = {
              width,
              height,
              durationMs: (image.duration ?? 0) / 1_000,
              centerRgb: Array.from(pixels.subarray(center, center + 3)),
              pixelSha256: Array.from(hash, (value) => value.toString(16).padStart(2, '0')).join(
                ''
              ),
            };
            if (inspectAllPixels) {
              const counts: Record<string, number> = {};
              for (let at = 0; at < pixels.length; at += 4) {
                const name =
                  pixels[at + 3] === 255
                    ? sceneName(pixels[at]!, pixels[at + 1]!, pixels[at + 2]!)
                    : 'unknown';
                counts[name] = (counts[name] ?? 0) + 1;
              }
              const [scene, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
              frame.scene = scene;
              frame.scenePixelCount = count;
              frame.totalPixels = pixels.length / 4;
            }
            frames.push(frame);
          } finally {
            image.close();
          }
        }
        return { repetitionCount: 'infinite' as const, frames };
      } finally {
        decoder.close();
      }
      function sceneName(r: number, g: number, b: number): string {
        if (r > 120 && g < 110 && b < 110) return 'red';
        if (g > 100 && r < 120 && b < 120) return 'lime';
        if (b > 110 && r < 120 && g < 120) return 'blue';
        if (r > 110 && g > 100 && b < 120) return 'yellow';
        return 'unknown';
      }
    },
    { base64: bytes.toString('base64'), inspectAllPixels }
  );
}

type SceneFrame = {
  scene: string;
  durationMs: number;
  scenePixelCount?: number | undefined;
  totalPixels?: number | undefined;
};

function assertSceneTimeline(
  frames: readonly SceneFrame[],
  expectedTimeline: readonly { scene: string; startMs: number; endMs: number }[],
  label: string,
  toleranceMs = 250
): void {
  let elapsedMs = 0;
  const groups: Array<{ scene: string; startMs: number; endMs: number }> = [];
  for (const frame of frames) {
    assert(frame.durationMs > 0, `${label} decoded hold is zero`);
    if (frame.totalPixels !== undefined) {
      assert.equal(
        frame.scenePixelCount,
        frame.totalPixels,
        `${label} has unexpected pixels outside its source scene`
      );
    }
    const group = groups.at(-1);
    if (!group || group.scene !== frame.scene)
      groups.push({ scene: frame.scene, startMs: elapsedMs, endMs: elapsedMs + frame.durationMs });
    else group.endMs += frame.durationMs;
    elapsedMs += frame.durationMs;
  }
  assert.equal(groups.length, expectedTimeline.length, `${label} transition count differs`);
  for (const [index, expected] of expectedTimeline.entries()) {
    const actual = groups[index]!;
    assert.equal(actual.scene, expected.scene, `${label} scene ${index} differs`);
    assert(
      Math.abs(actual.startMs - expected.startMs) <= toleranceMs,
      `${label} transition ${index} differs by over ${toleranceMs}ms`
    );
    assert(
      Math.abs(actual.endMs - expected.endMs) <= toleranceMs,
      `${label} hold ${index} differs by over ${toleranceMs}ms`
    );
  }
}

export function assertClusterTimeline(frames: readonly SceneFrame[]): void {
  assertSceneTimeline(frames, CLUSTER_SCENE_TIMELINE, 'Cluster');
}

export function assertNearCapTimeline(frames: readonly SceneFrame[]): void {
  assertSceneTimeline(frames, NEAR_CAP_SCENE_TIMELINE, 'Near-cap');
}

export function assertLargeAdmittedTimeline(frames: readonly SceneFrame[]): void {
  assertSceneTimeline(frames, NEAR_CAP_SCENE_TIMELINE, 'Large admitted', 50);
}

function assertClusterSequence(
  frames: readonly {
    centerRgb: number[];
    durationMs: number;
    scene?: string;
    scenePixelCount?: number;
    totalPixels?: number;
  }[]
): void {
  const color = (rgb: number[]) => {
    const [r, g, b] = rgb;
    if (r! > 120 && g! < 110 && b! < 110) return 'red';
    if (g! > 100 && r! < 120 && b! < 120) return 'lime';
    if (b! > 110 && r! < 120 && g! < 120) return 'blue';
    if (r! > 110 && g! > 100 && b! < 120) return 'yellow';
    return 'unknown';
  };
  const sequence = frames.map((frame) => color(frame.centerRgb));
  assertClusterTimeline(
    frames.map((frame, index) => ({
      scene: frame.scene ?? sequence[index]!,
      durationMs: frame.durationMs,
      scenePixelCount: frame.scenePixelCount,
      totalPixels: frame.totalPixels,
    }))
  );
}

async function downloadWebp(page: Page): Promise<Buffer> {
  const pending = page.waitForEvent('download', { timeout: 30_000 });
  await page.locator('[data-testid="download-result-button"]').click();
  const stream = await (await pending).createReadStream();
  assert(stream, 'Browser WebP download has no readable stream');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of stream) {
    const bytes = Buffer.from(part);
    size += bytes.length;
    assert(size <= MAX_OUTPUT_BYTES, 'WebP download exceeded bound');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function installProductObserver() {
  const observed = {
    clickMs: null as number | null,
    readyMs: null as number | null,
    stopMs: null as number | null,
    idleMs: null as number | null,
    publications: [] as Array<{ url: string; size: number; atMs: number }>,
    publicationCount: 0,
    reset() {
      this.clickMs = null;
      this.readyMs = null;
      this.stopMs = null;
      this.idleMs = null;
      this.publications = [];
      this.publicationCount = 0;
    },
  };
  Reflect.set(globalThis, '__wmcVp8ProductObserver', observed);
  const original = URL.createObjectURL;
  URL.createObjectURL = function (object: Blob | MediaSource) {
    const url = original.call(URL, object);
    if (object instanceof Blob && object.type === 'image/webp') {
      observed.publicationCount++;
      if (observed.publications.length === 16) observed.publications.shift();
      observed.publications.push({ url, size: object.size, atMs: performance.now() });
      check();
    }
    return url;
  };
  function check() {
    const button = document.querySelector<HTMLAnchorElement>(
      '[data-testid="download-result-button"]'
    );
    const last = observed.publications.at(-1);
    if (
      observed.clickMs !== null &&
      observed.readyMs === null &&
      last &&
      button?.getAttribute('href') === last.url &&
      button.getClientRects().length
    )
      observed.readyMs = performance.now();
    const convert = document.querySelector<HTMLButtonElement>('[data-testid="convert-button"]');
    const stop = document.querySelector('[data-testid="stop-conversion-button"]');
    if (
      observed.stopMs !== null &&
      observed.idleMs === null &&
      convert &&
      !convert.disabled &&
      convert.getClientRects().length &&
      !stop
    )
      observed.idleMs = performance.now();
  }
  new MutationObserver(check).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
  });
  document.addEventListener(
    'click',
    (event) => {
      if (!(event.target instanceof Element)) return;
      if (
        event.target.closest('[data-testid="convert-button"], [data-testid="error-retry-button"]')
      )
        observed.clickMs = performance.now();
      if (event.target.closest('[data-testid="stop-conversion-button"]'))
        observed.stopMs = performance.now();
    },
    true
  );
}

function disableCanvasWebp() {
  if (typeof OffscreenCanvas !== 'undefined')
    Object.defineProperty(OffscreenCanvas.prototype, 'convertToBlob', {
      configurable: true,
      value: undefined,
    });
}

export function instrumentOwnedInstance() {
  const NativeInstance = WebAssembly.Instance;
  const weakRecords: Array<{
    id: number;
    instance: WeakRef<WebAssembly.Instance>;
    wrapper: WeakRef<WebAssembly.Instance>;
    memory: WeakRef<WebAssembly.Memory>;
  }> = [];
  const beginCounts: number[] = [];
  let controlHold: { instance: WebAssembly.Instance; memory: WebAssembly.Memory } | null = null;
  let retainNextForControl = false;
  const state = {
    instances: 0,
    stepCalls: 0,
    statusCounts: {} as Record<string, number>,
    successfulBeginCalls: 0,
    beginStatusCounts: {} as Record<string, number>,
    injectNextStepTrap: false,
    injectedErrorCount: 0,
    records: [] as Array<{
      id: number;
      stepCalls: number;
      retireCalls: number;
      retireStatus: number | null;
      peakCapacityBytes: number;
      retainedCapacityBytes: number | null;
    }>,
    retainNextForControl() {
      if (controlHold || retainNextForControl) throw new Error('Negative control already armed');
      retainNextForControl = true;
    },
    releaseControl() {
      controlHold = null;
    },
    inventory() {
      return weakRecords.map((entry) => {
        // Each dereference is consumed in this expression, never across a GC turn.
        const instanceLive = entry.instance.deref() !== undefined;
        const wrapperLive = entry.wrapper.deref() !== undefined;
        const memoryLive = entry.memory.deref() !== undefined;
        const record = state.records.find((item) => item.id === entry.id)!;
        return {
          id: entry.id,
          instanceLive,
          wrapperLive,
          memoryLive,
          successfulBeginCalls: beginCounts[entry.id] ?? 0,
          stepCalls: record.stepCalls,
          retireCalls: record.retireCalls,
          retireStatus: record.retireStatus,
          peakCapacityBytes: record.peakCapacityBytes,
          retirementTimeCapacityBytes: record.retainedCapacityBytes,
        };
      });
    },
  };
  Reflect.set(globalThis, '__wmcVp8AbiProbe', state);
  WebAssembly.Instance = new Proxy(NativeInstance, {
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget);
      const exported = instance.exports as Record<string, unknown>;
      if (typeof exported.vp8_v2_step !== 'function') return instance;
      state.instances++;
      if (state.records.length >= 32) throw new Error('Owned ABI probe instance bound exceeded');
      const record = {
        id: state.instances,
        stepCalls: 0,
        retireCalls: 0,
        retireStatus: null as number | null,
        peakCapacityBytes: 0,
        retainedCapacityBytes: null as number | null,
      };
      state.records.push(record);
      beginCounts[record.id] = 0;
      const memory = exported.memory as WebAssembly.Memory | undefined;
      if (!memory || !(memory.buffer instanceof ArrayBuffer))
        throw new Error('Owned ABI probe has no exported Memory');
      // WASM export properties are nonconfigurable and nonwritable; a Proxy
      // cannot substitute one of their values. Copy the namespace instead.
      const wrapped = Object.fromEntries(
        Object.entries(exported).map(([key, value]) => [
          key,
          key === 'vp8_v2_begin' && typeof value === 'function'
            ? (...parameters: unknown[]) => {
                const status = Reflect.apply(value, exported, parameters) as number;
                state.beginStatusCounts[String(status)] =
                  (state.beginStatusCounts[String(status)] ?? 0) + 1;
                if (status === 10) {
                  state.successfulBeginCalls++;
                  beginCounts[record.id] = (beginCounts[record.id] ?? 0) + 1;
                }
                return status;
              }
            : key === 'vp8_v2_step' && typeof value === 'function'
              ? (...parameters: unknown[]) => {
                  state.stepCalls++;
                  record.stepCalls++;
                  const status = Reflect.apply(value, exported, parameters) as number;
                  record.peakCapacityBytes = Math.max(
                    record.peakCapacityBytes,
                    (exported.memory as WebAssembly.Memory).buffer.byteLength
                  );
                  state.statusCounts[String(status)] =
                    (state.statusCounts[String(status)] ?? 0) + 1;
                  if (state.injectNextStepTrap) {
                    state.injectNextStepTrap = false;
                    state.injectedErrorCount++;
                    throw new WebAssembly.RuntimeError('Controlled post-step ABI2 trap injection');
                  }
                  return status;
                }
              : key === 'vp8_v2_retire' && typeof value === 'function'
                ? (...parameters: unknown[]) => {
                    const status = Reflect.apply(value, exported, parameters) as number;
                    record.retireCalls++;
                    record.retireStatus = status;
                    record.retainedCapacityBytes = (
                      exported.memory as WebAssembly.Memory
                    ).buffer.byteLength;
                    return status;
                  }
                : value,
        ])
      );
      const wrapper = new Proxy(instance, {
        get(source, key) {
          return key === 'exports' ? wrapped : Reflect.get(source, key);
        },
      });
      weakRecords.push({
        id: record.id,
        instance: new WeakRef(instance),
        wrapper: new WeakRef(wrapper),
        memory: new WeakRef(memory),
      });
      if (retainNextForControl) {
        controlHold = { instance, memory };
        retainNextForControl = false;
      }
      return wrapper;
    },
  });
}

async function configurePage(page: Page, fixturePath: string, fixture: Fixture, quality: Quality) {
  await page.locator('[data-testid="file-input"]').setInputFiles(fixturePath);
  await page
    .locator('[data-testid="convert-button"]')
    .waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="convert-button"]');
    return button && !button.disabled;
  });
  assert(
    (await page.locator('[data-testid="video-metadata"]').textContent())?.includes(
      fixturePath.split(/[\\/]/).at(-1)!
    ),
    `${fixture.id} fixture name is absent from metadata`
  );
  for (const [group, value] of [
    ['format', 'webp'],
    ['quality', quality],
    ['scale', '1'],
    ['smart-frame-skip', 'off'],
  ] as const) {
    const option = page.locator(`[data-testid="option-${group}-${value}"]`);
    if (!(await option.isVisible()))
      await page.locator('[data-testid="advanced-settings"] summary').click();
    await option.click();
    assert.equal(await option.locator('input').isChecked(), true);
  }
}

async function measureJob(
  page: Page,
  fixture: Fixture,
  fixtureDigest: string,
  quality: Quality,
  build: 'prior' | 'candidate',
  condition: 'first-in-document' | 'same-document-warm',
  output: string,
  caseId: string,
  action: 'convert' | 'retry' = 'convert',
  timingInvocationId?: string
) {
  const timingEpoch = timingInvocationId ? `${timingInvocationId}:${caseId}` : caseId;
  const before = await page.evaluate(() => {
    const observed = Reflect.get(globalThis, '__wmcVp8ProductObserver') as { reset: () => void };
    observed.reset();
    return {
      timeOrigin: performance.timeOrigin,
      navigation: performance.getEntriesByType('navigation').length,
    };
  });
  const timingProbeInstalled = timingInvocationId
    ? await page.evaluate((epoch) => {
        const probe = Reflect.get(globalThis, '__wmcVp8TimingProbe') as
          | { begin: (value: string) => void }
          | undefined;
        probe?.begin(epoch);
        return probe !== undefined;
      }, timingEpoch)
    : false;
  const wallStart = new Date().toISOString();
  await page
    .locator(
      action === 'retry' ? '[data-testid="error-retry-button"]' : '[data-testid="convert-button"]'
    )
    .click();
  if (action === 'retry')
    await page
      .locator('[data-testid="error-display"]')
      .waitFor({ state: 'hidden', timeout: 30_000 });
  const prompt = page.locator('[data-testid="modal-confirm-button"]');
  if (await prompt.isVisible()) await prompt.click();
  await page.waitForFunction(
    () => {
      const observed = Reflect.get(globalThis, '__wmcVp8ProductObserver') as {
        readyMs: number | null;
      };
      return (
        observed.readyMs !== null ||
        !!document.querySelector('[data-testid="error-display"]')?.getClientRects().length
      );
    },
    undefined,
    { timeout: CONVERSION_TIMEOUT_MS }
  );
  const visibleError = await page.evaluate(() => {
    const error = document.querySelector<HTMLElement>('[data-testid="error-display"]');
    return error?.getClientRects().length && getComputedStyle(error).visibility === 'visible'
      ? (error.textContent?.trim() ?? '')
      : null;
  });
  assert.equal(visibleError, null, `WebP conversion failed: ${visibleError}`);
  const timing = await page.evaluate(() => {
    const observed = Reflect.get(globalThis, '__wmcVp8ProductObserver') as {
      clickMs: number | null;
      readyMs: number | null;
      publications: Array<{ url: string; size: number; atMs: number }>;
    };
    return {
      timeOrigin: performance.timeOrigin,
      clickMs: observed.clickMs,
      readyMs: observed.readyMs,
      publications: observed.publications,
      resourceEntries: performance
        .getEntriesByType('resource')
        .filter((entry) => entry.name.endsWith('.wasm'))
        .map((entry) => ({
          name: entry.name,
          transferSize: (entry as PerformanceResourceTiming).transferSize,
          encodedBodySize: (entry as PerformanceResourceTiming).encodedBodySize,
        })),
    };
  });
  assert.equal(timing.timeOrigin, before.timeOrigin, 'Conversion changed document');
  assert(timing.clickMs !== null && timing.readyMs !== null && timing.readyMs > timing.clickMs);
  assert.equal(timing.publications.length, 1, 'WebP job did not publish exactly one Blob');
  assert(
    timing.publications[0]!.atMs >= timing.clickMs && timing.publications[0]!.atMs <= timing.readyMs
  );
  // Timing is sealed before browser transfer, filesystem writes, parsing or decoding.
  const timingAttestation = timingProbeInstalled
    ? await page.evaluate((epoch) => {
        const probe = Reflect.get(globalThis, '__wmcVp8TimingProbe') as {
          snapshot: (value: string) => Record<string, unknown>;
        };
        return { epoch, scope: 'main-observed-worker-route-only', ...probe.snapshot(epoch) };
      }, timingEpoch)
    : undefined;
  const bytes = await downloadWebp(page);
  assert.equal(
    bytes.length,
    timing.publications[0]!.size,
    'Downloaded bytes differ from published Blob'
  );
  const file = `${caseId}.webp`;
  await writeFile(join(output, file), bytes);
  const parsed = parseAnimatedWebp(bytes);
  assert.deepEqual(parsed.canvas, { width: fixture.width, height: fixture.height });
  assert(
    Math.abs(parsed.totalDurationMs - fixture.durationMs) <= 250,
    'WebP timeline differs from source by over 250ms'
  );
  const decoded = await decodeWebp(page, bytes, fixture.id === 'clusters');
  assert.equal(
    decoded.frames.length,
    parsed.frames.length,
    'ImageDecoder frame count differs from RIFF'
  );
  for (let index = 0; index < decoded.frames.length; index++) {
    const frame = decoded.frames[index]!;
    assert.equal(frame.width, fixture.width);
    assert.equal(frame.height, fixture.height);
    assert(
      Math.abs(frame.durationMs - parsed.frames[index]!.durationMs) <= 1,
      `Decoded hold ${index} differs from RIFF`
    );
  }
  if (fixture.id === 'clusters') {
    assertClusterSequence(decoded.frames);
  }
  return {
    build,
    fixture: fixture.id,
    quality,
    condition,
    targetCadenceFps: CADENCE[quality],
    scale: 1,
    smartFrameSkip: 'off',
    wallStart,
    clickClockMs: timing.clickMs,
    readyClockMs: timing.readyMs,
    clickWallUtc: new Date(Math.floor(timing.timeOrigin + timing.clickMs)).toISOString(),
    readyWallUtc: new Date(Math.ceil(timing.timeOrigin + timing.readyMs)).toISOString(),
    inputSha256: fixtureDigest,
    timeOrigin: timing.timeOrigin,
    contextCacheScope:
      'new browser context for this build; first is first-in-document, not proven fresh-profile cold',
    navigationCount: before.navigation,
    requestToDownloadReadyMs: timing.readyMs - timing.clickMs,
    requestToBlobPublicationMs: timing.publications[0]!.atMs - timing.clickMs,
    wasmResources: timing.resourceEntries,
    ...(timingAttestation ? { timingAttestation } : {}),
    emittedAnmfCount: parsed.frames.length,
    saved: { file, bytes: bytes.length, sha256: digest(bytes) },
    parsed,
    decoded,
  };
}

async function createContext(
  browser: Browser,
  build: Build,
  functional: boolean,
  main: boolean,
  workerPatches: Array<{ path: string; originalSha256: string; patchedSha256: string }>,
  timing = false,
  legacyLoaderPatch?: { path: string; bytes: Uint8Array },
  ownerRetentionWorker = false
): Promise<BrowserContext> {
  const context = await browser.newContext({
    locale: 'en-US',
    acceptDownloads: true,
    serviceWorkers: 'block',
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(disableCanvasWebp);
  if (timing) await context.addInitScript(installVp8TimingProbe);
  if (ownerRetentionWorker) await context.addInitScript(installWorkerLifecycleObserver);
  if (functional) {
    if (main)
      await context.addInitScript(() => {
        const NativeWorker = Worker;
        globalThis.Worker = class DisabledConversionWorker extends NativeWorker {
          constructor(url: string | URL, options?: WorkerOptions) {
            if (/^\/assets\/worker-[\w-]+\.js$/.test(new URL(String(url), location.href).pathname))
              throw new DOMException('Controlled conversion Worker failure', 'NotSupportedError');
            super(url, options);
          }
        };
      });
    else await context.addInitScript(installMotionObserver);
    if (main) await context.addInitScript(instrumentOwnedInstance);
  }
  await context.addInitScript(installProductObserver);
  if (legacyLoaderPatch) {
    await context.route(`**/${legacyLoaderPatch.path}`, async (route) => {
      await route.fulfill({
        body: Buffer.from(legacyLoaderPatch.bytes),
        contentType: 'text/javascript',
      });
    });
  }
  await context.route('**/assets/worker-*.js', async (route) => {
    const path = new URL(route.request().url()).pathname.slice(1);
    if (!/^assets\/worker-[\w-]+\.js$/.test(path)) return route.continue();
    const file = build.state.files.find((entry) => entry.path === path);
    assert(file, `Built conversion Worker ${path} is absent from inventory`);
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const original = Buffer.from(await response.body());
    assert.equal(digest(original), file.sha256, 'Served Worker differs from built inventory');
    const patch = Buffer.from(
      "if(typeof OffscreenCanvas!=='undefined')Object.defineProperty(OffscreenCanvas.prototype,'convertToBlob',{configurable:true,value:undefined});\n" +
        (timing ? `(${installVp8TimingProbe.toString()})();\n` : '') +
        (ownerRetentionWorker ? `(${installRetainedWorkerProbe.toString()})();\n` : '')
    );
    const modified = Buffer.concat([patch, original]);
    workerPatches.push({ path, originalSha256: file.sha256, patchedSha256: digest(modified) });
    await route.fulfill({ response, body: modified });
  });
  return context;
}

function ownedCounts(value: unknown) {
  assert(value && typeof value === 'object', 'Owned VP8 counters are absent');
  const record = value as Record<string, unknown>;
  const counts: Record<string, number> = {};
  for (const name of OWNED_FIELDS) {
    const count = record[name];
    assert(Number.isSafeInteger(count) && Number(count) >= 0, `${name} is absent or invalid`);
    counts[name] = Number(count);
  }
  assert(
    counts.ownedVp8Frames! > 0 && counts.ownedVp8Steps! > 0,
    'Owned VP8 did not process frames'
  );
  assert(
    counts.ownedVp8PeakReservedLinearCapacityBytes! >= counts.ownedVp8PeakActualLinearCapacityBytes!
  );
  return counts;
}

async function exerciseDirectWorker(
  page: Page,
  build: Build,
  fixturePath: string,
  fixtureDigest: string,
  output: string
) {
  const fixture = FIXTURES[1]!;
  const workerAssets = build.state.files.filter((entry) =>
    /^assets\/worker-[\w-]+\.js$/.test(entry.path)
  );
  assert.equal(workerAssets.length, 1, 'Candidate has no unique bundled conversion Worker');
  const input = await readFile(fixturePath);
  assert(input.length > 0 && input.length <= MAX_INPUT_BYTES, 'Worker fixture outside bound');
  assert.equal(digest(input), fixtureDigest, 'Direct Worker input differs from bundled fixture');
  const result = await page.evaluate(
    async ({ workerPath, inputBase64, config, options }) => {
      const requestId = 'owned-vp8-direct-worker';
      const input = Uint8Array.from(atob(inputBase64), (character) => character.charCodeAt(0));
      return new Promise<{
        requestId: string;
        durationMs: number;
        progressCount: number;
        ownedProgress: unknown[];
        output: number[];
      }>((resolve, reject) => {
        const worker = new Worker(`/${workerPath}`, { type: 'module' });
        const ownedProgress: unknown[] = [];
        let progressCount = 0;
        let started = false;
        let settled = false;
        const timer = setTimeout(() => finish(new Error('Direct Worker timed out')), 180_000);
        const finish = (
          error?: Error,
          value?: {
            requestId: string;
            durationMs: number;
            progressCount: number;
            ownedProgress: unknown[];
            output: number[];
          }
        ) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          worker.terminate();
          if (error) reject(error);
          else if (value) resolve(value);
          else reject(new Error('Direct Worker completed without a result'));
        };
        worker.addEventListener('error', (event) => {
          event.preventDefault();
          finish(new Error(`Direct Worker script error: ${event.message}`));
        });
        worker.addEventListener('messageerror', () =>
          finish(new Error('Direct Worker message error'))
        );
        worker.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
          if (!data || typeof data !== 'object') return;
          const message = data as Record<string, unknown>;
          if (message.type === 'ready' && message.requestId === '' && !started) {
            started = true;
            try {
              worker.postMessage(
                {
                  type: 'start',
                  requestId,
                  inputBuffer: input.buffer,
                  config,
                  options,
                  duration: 4,
                  framerate: 4,
                },
                [input.buffer]
              );
            } catch (error) {
              finish(new Error(`Direct Worker start failed: ${String(error)}`));
            }
            return;
          }
          if (message.requestId !== requestId) return;
          if (message.type === 'progress') {
            progressCount++;
            if (message.ownedVp8Steps !== undefined) {
              if (ownedProgress.length === 32) ownedProgress.shift();
              ownedProgress.push(message);
            }
          } else if (message.type === 'error') {
            finish(new Error(`Direct Worker ${String(message.code)}: ${String(message.message)}`));
          } else if (message.type === 'complete') {
            if (!(message.outputBuffer instanceof ArrayBuffer)) {
              finish(new Error('Direct Worker returned no ArrayBuffer'));
              return;
            }
            if (
              message.outputBuffer.byteLength === 0 ||
              message.outputBuffer.byteLength > 8 * 1024 * 1024
            ) {
              finish(new Error('Direct Worker small output outside transfer bound'));
              return;
            }
            finish(undefined, {
              requestId,
              durationMs: Number(message.durationMs),
              progressCount,
              ownedProgress,
              output: Array.from(new Uint8Array(message.outputBuffer)),
            });
          }
        });
      });
    },
    {
      workerPath: workerAssets[0]!.path,
      inputBase64: input.toString('base64'),
      config: DIRECT_WORKER_CLUSTER_CONFIG,
      options: DIRECT_WORKER_OPTIONS,
    }
  );
  assert(Number.isFinite(result.durationMs) && result.durationMs > 0);
  assert(result.progressCount > 0, 'Direct Worker emitted no progress');
  assert(result.ownedProgress.length > 0, 'Direct Worker emitted no owned VP8 progress');
  const owned = ownedCounts(result.ownedProgress.at(-1));
  const bytes = Buffer.from(result.output);
  const file = 'owned-vp8-functional-direct-worker.webp';
  await writeFile(join(output, file), bytes);
  const parsed = parseAnimatedWebp(bytes);
  assert.deepEqual(parsed.canvas, { width: fixture.width, height: fixture.height });
  assert(Math.abs(parsed.totalDurationMs - fixture.durationMs) <= 250);
  const decoded = await decodeWebp(page, bytes, true);
  assert.equal(decoded.frames.length, parsed.frames.length);
  for (const [index, frame] of decoded.frames.entries()) {
    assert.equal(frame.width, fixture.width);
    assert.equal(frame.height, fixture.height);
    assert(Math.abs(frame.durationMs - parsed.frames[index]!.durationMs) <= 1);
  }
  assertClusterSequence(decoded.frames);
  return {
    route: 'direct-conversion-worker',
    requestId: result.requestId,
    workerAsset: workerAssets[0]!,
    progressCount: result.progressCount,
    owned,
    durationMs: result.durationMs,
    inputSha256: fixtureDigest,
    saved: { file, bytes: bytes.length, sha256: digest(bytes) },
    parsed,
    decoded,
  };
}

async function exerciseActiveStop(
  context: BrowserContext,
  server: Server,
  fixturePath: string,
  fixtureDigest: string,
  stopFixturePath: string,
  output: string,
  loadApplication: (page: Page, url: string) => Promise<unknown>
) {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    if (errors.length < 32) errors.push(error.message);
  });
  try {
    await loadApplication(page, server.url);
    const documentIdentity = await page.evaluate(() => performance.timeOrigin);
    await configurePage(
      page,
      stopFixturePath,
      {
        id: 'active-stop',
        path: STOP_FIXTURE,
        mime: 'video/mp4',
        width: 320,
        height: 180,
        durationMs: 3_000,
      },
      'high'
    );
    await page.locator('[data-testid="convert-button"]').click();
    const confirmation = page.locator('[data-testid="modal-confirm-button"]');
    if (await confirmation.isVisible()) await confirmation.click();
    await page.waitForFunction(
      () => {
        const abi = Reflect.get(globalThis, '__wmcVp8AbiProbe') as { stepCalls: number };
        return abi.stepCalls > 0;
      },
      undefined,
      { timeout: 30_000 }
    );
    await page.locator('[data-testid="stop-conversion-button"]').click({ timeout: 10_000 });
    await page.waitForFunction(
      () => {
        const observed = Reflect.get(globalThis, '__wmcVp8ProductObserver') as {
          idleMs: number | null;
        };
        return observed.idleMs !== null;
      },
      undefined,
      { timeout: 10_000 }
    );
    const stop = await page.evaluate(() => {
      const observed = Reflect.get(globalThis, '__wmcVp8ProductObserver') as {
        stopMs: number | null;
        idleMs: number | null;
        publications: unknown[];
      };
      const abi = Reflect.get(globalThis, '__wmcVp8AbiProbe') as { stepCalls: number };
      return {
        stopMs: observed.stopMs,
        idleMs: observed.idleMs,
        publications: observed.publications.length,
        stepCalls: abi.stepCalls,
      };
    });
    assert(stop.stopMs !== null && stop.idleMs !== null);
    assert(
      stop.idleMs >= stop.stopMs && stop.idleMs - stop.stopMs <= 500,
      'Owned active Stop-to-idle exceeded 500ms'
    );
    assert.equal(stop.publications, 0, 'Cancelled owned job published a WebP Blob');
    assert.equal(await page.locator('[data-testid="result-section"]').isVisible(), false);
    assert.equal(await page.locator('[data-testid="error-display"]').isVisible(), false);
    const fixture = FIXTURES[0]!;
    await configurePage(page, fixturePath, fixture, 'medium');
    const recovery = await measureJob(
      page,
      fixture,
      fixtureDigest,
      'medium',
      'candidate',
      'same-document-warm',
      output,
      'owned-vp8-functional-main-after-stop'
    );
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => {
      const observed = Reflect.get(globalThis, '__wmcVp8ProductObserver') as {
        publications: unknown[];
      };
      return { publications: observed.publications.length, timeOrigin: performance.timeOrigin };
    });
    assert.equal(after.publications, 1, 'Stop recovery had stale or duplicate WebP publication');
    assert.equal(after.timeOrigin, documentIdentity, 'Stop recovery changed document');
    assert.deepEqual(errors, [], 'Active Stop page emitted errors');
    return { stop, stopToIdleMs: stop.idleMs - stop.stopMs, recovery, after };
  } catch (error) {
    await captureFailure(page, output, 'owned-vp8-functional-active-stop', error, errors);
    throw error;
  } finally {
    await page.close();
  }
}

async function exerciseInjectedTrap(
  page: Page,
  fixture: Fixture,
  fixturePath: string,
  fixtureDigest: string,
  output: string,
  pageErrors: string[]
) {
  const consoleWarnings: string[] = [];
  const consoleErrors: string[] = [];
  const onConsole = (message: { type: () => string; text: () => string }) => {
    const selected =
      message.type() === 'warning'
        ? consoleWarnings
        : message.type() === 'error'
          ? consoleErrors
          : null;
    if (selected && selected.length < 32) selected.push(message.text().slice(0, 512));
  };
  page.on('console', onConsole);
  const snapshot = () =>
    page.evaluate(() => {
      const abi = Reflect.get(globalThis, '__wmcVp8AbiProbe') as {
        instances: number;
        stepCalls: number;
        injectedErrorCount: number;
        records: Array<{
          id: number;
          stepCalls: number;
          retireCalls: number;
          retireStatus: number | null;
        }>;
      };
      const observed = Reflect.get(globalThis, '__wmcVp8ProductObserver') as {
        publications: unknown[];
      };
      const error = document.querySelector<HTMLElement>('[data-testid="error-display"]');
      return {
        timeOrigin: performance.timeOrigin,
        navigationCount: performance.getEntriesByType('navigation').length,
        instances: abi.instances,
        stepCalls: abi.stepCalls,
        injectedErrorCount: abi.injectedErrorCount,
        records: abi.records.map((record) => ({ ...record })),
        publications: observed.publications.length,
        fallbackResourceCount: performance
          .getEntriesByType('resource')
          .filter((entry) =>
            /\/(?:webp-wasm|wasm-webp)[\w.-]*\.(?:wasm|js)$/.test(new URL(entry.name).pathname)
          ).length,
        errorText: error?.getClientRects().length ? (error.textContent?.trim() ?? '') : null,
      };
    });
  try {
    const before = await page.evaluate(() => {
      const abi = Reflect.get(globalThis, '__wmcVp8AbiProbe') as {
        injectNextStepTrap: boolean;
        injectedErrorCount: number;
      };
      const observed = Reflect.get(globalThis, '__wmcVp8ProductObserver') as { reset: () => void };
      if (abi.injectNextStepTrap) throw new Error('ABI2 trap injection is already armed');
      observed.reset();
      abi.injectNextStepTrap = true;
      return { timeOrigin: performance.timeOrigin, injectedErrorCount: abi.injectedErrorCount };
    });
    const armed = await snapshot();
    await page.locator('[data-testid="convert-button"]').click();
    const prompt = page.locator('[data-testid="modal-confirm-button"]');
    if (await prompt.isVisible()) await prompt.click();
    await page
      .locator('[data-testid="error-display"]')
      .waitFor({ state: 'visible', timeout: CONVERSION_TIMEOUT_MS });
    await page
      .locator('[data-testid="convert-button"]')
      .waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await page.locator('[data-testid="convert-button"]').isEnabled(), true);
    assert.equal(await page.locator('[data-testid="stop-conversion-button"]').isVisible(), false);
    const failed = await snapshot();
    assert.equal(failed.timeOrigin, before.timeOrigin, 'Injected failure changed document');
    assert.equal(failed.navigationCount, armed.navigationCount, 'Injected failure navigated');
    assert.equal(
      failed.instances,
      armed.instances + 1,
      'Injected failure did not create one owned instance'
    );
    assert(
      failed.stepCalls > armed.stepCalls,
      'Injected failure did not execute an actual ABI2 step'
    );
    assert.equal(
      failed.injectedErrorCount,
      before.injectedErrorCount + 1,
      'Controlled trap did not fire once'
    );
    assert(
      failed.errorText?.includes('Owned VP8 WASM trapped'),
      'Controlled trap error is not visible'
    );
    assert.equal(failed.publications, 0, 'Controlled trap published output');
    assert.equal(
      failed.fallbackResourceCount,
      armed.fallbackResourceCount,
      'Controlled trap fetched legacy backend'
    );
    const failedRecord = failed.records.find((record) => record.id === failed.instances);
    assert(
      failedRecord &&
        failedRecord.stepCalls > 0 &&
        failedRecord.retireCalls > 0 &&
        failedRecord.retireStatus === 0,
      'Trapped instance was not retired'
    );
    assert.deepEqual(pageErrors, [], 'Controlled trap emitted an uncaught page error');
    // Give the settled error UI a bounded task window in which an unintended
    // automatic retry would create an instance or publish a result.
    await page.waitForTimeout(150);
    const guarded = await snapshot();
    assert.equal(guarded.instances, failed.instances, 'Backend retried without user action');
    assert.equal(guarded.stepCalls, failed.stepCalls, 'Backend continued after controlled trap');
    assert.equal(guarded.publications, 0, 'Backend published after controlled trap');
    assert.equal(
      guarded.fallbackResourceCount,
      armed.fallbackResourceCount,
      'Backend fetched legacy fallback'
    );
    assert(guarded.errorText, 'Failure UI disappeared without user action');
    assert.deepEqual(pageErrors, [], 'Guard interval emitted an uncaught page error');
    assert(
      (await page.locator('[data-testid="video-metadata"]').textContent())?.includes(
        fixturePath.split(/[\\/]/).at(-1)!
      ),
      'Explicit retry lost the selected source file'
    );
    const retry = await measureJob(
      page,
      fixture,
      fixtureDigest,
      'medium',
      'candidate',
      'same-document-warm',
      output,
      'owned-vp8-functional-main-after-injected-trap',
      'retry'
    );
    const recovered = await snapshot();
    assert.equal(recovered.timeOrigin, before.timeOrigin, 'Explicit retry changed document');
    assert.equal(recovered.navigationCount, armed.navigationCount, 'Explicit retry navigated');
    assert.equal(
      recovered.instances,
      failed.instances + 1,
      'Explicit retry did not create one fresh owned instance'
    );
    assert(recovered.stepCalls > failed.stepCalls, 'Explicit retry executed no owned ABI2 step');
    assert.equal(
      recovered.injectedErrorCount,
      failed.injectedErrorCount,
      'Trap injection was not one-shot'
    );
    assert.equal(recovered.publications, 1, 'Explicit retry did not publish exactly one WebP');
    assert.equal(
      recovered.fallbackResourceCount,
      armed.fallbackResourceCount,
      'Explicit retry fetched legacy backend'
    );
    const recoveredRecord = recovered.records.find((record) => record.id === recovered.instances);
    assert(
      recoveredRecord &&
        recoveredRecord.stepCalls > 0 &&
        recoveredRecord.retireCalls > 0 &&
        recoveredRecord.retireStatus === 0,
      'Retry instance did not complete and retire'
    );
    assert.deepEqual(pageErrors, [], 'Explicit retry emitted an uncaught page error');
    return {
      kind: 'controlled-post-step-runtime-error-injection',
      sourceFixture: fixturePath,
      inputSha256: fixtureDigest,
      before: armed,
      failed,
      guarded,
      explicitUserRetry: { ...retry, abi: recovered },
      consoleWarnings,
      consoleErrors,
      pageErrors: [...pageErrors],
    };
  } finally {
    page.off('console', onConsole);
  }
}

async function candidateFunctional(
  browser: Browser,
  build: Build,
  server: Server,
  output: string,
  fixturePath: string,
  fixtureDigest: string,
  workerFixturePath: string,
  workerFixtureDigest: string,
  stopFixturePath: string,
  loadApplication: (page: Page, url: string) => Promise<unknown>,
  recordCheck: (check: unknown) => Promise<void>
) {
  for (const main of [false, true]) {
    const route = main ? 'ui-main' : 'direct-worker';
    const workerPatches: Array<{ path: string; originalSha256: string; patchedSha256: string }> =
      [];
    const context = await createContext(browser, build, true, main, workerPatches);
    const fetchedWasm: Array<Promise<{ path: string; bytes: number; sha256: string }>> = [];
    context.on('response', (response) => {
      const path = new URL(response.url()).pathname.slice(1);
      if (/^assets\/owned-vp8[-.][\w-]{8}\.wasm$/.test(path)) {
        fetchedWasm.push(
          response.body().then((bytes) => ({ path, bytes: bytes.length, sha256: digest(bytes) }))
        );
      }
    });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => {
        if (errors.length < 32) errors.push(error.message);
      });
      try {
        await loadApplication(page, server.url);
        if (!main) {
          const direct = await exerciseDirectWorker(
            page,
            build,
            workerFixturePath,
            workerFixtureDigest,
            output
          );
          assert.deepEqual(errors, [], 'Direct Worker page errors');
          assert(
            workerPatches.some(
              (patch) =>
                patch.path === direct.workerAsset.path &&
                patch.originalSha256 === direct.workerAsset.sha256
            ),
            'Direct Worker did not load the source-bound bundled entry'
          );
          const ownedAsset = build.state.files.find((entry) =>
            /^assets\/owned-vp8[-.][\w-]{8}\.wasm$/.test(entry.path)
          );
          assert(ownedAsset, 'Candidate compiled owned WASM inventory entry is absent');
          const wasm = await Promise.all(fetchedWasm);
          assert(
            wasm.some(
              (entry) =>
                entry.path === ownedAsset.path &&
                entry.bytes === ownedAsset.size &&
                entry.sha256 === ownedAsset.sha256
            ),
            'Direct Worker fetched WASM differs from candidate inventory'
          );
          await recordCheck({ ...direct, fetchedWasm: wasm, workerPatches });
          continue;
        }
        const fixture = FIXTURES[0]!;
        await configurePage(page, fixturePath, fixture, 'medium');
        const recovery: Record<string, unknown> = { route };
        // An invalid selection must be recoverable in the same document before the valid job.
        await page.locator('[data-testid="file-input"]').setInputFiles({
          name: 'invalid.mp4',
          mimeType: 'video/mp4',
          buffer: Buffer.from('invalid media'),
        });
        await page
          .locator('[data-testid="error-display"]')
          .waitFor({ state: 'visible', timeout: 30_000 });
        recovery.invalidError = (
          await page.locator('[data-testid="error-display"]').textContent()
        )?.trim();
        await page
          .locator(
            '[data-testid="error-select-different-button"], [data-testid="error-select-different-fallback-button"]'
          )
          .click();
        await configurePage(page, fixturePath, fixture, 'medium');
        const sample = await measureJob(
          page,
          fixture,
          fixtureDigest,
          'medium',
          'candidate',
          'first-in-document',
          output,
          `owned-vp8-functional-${route}`
        );
        recovery.valid = sample;
        const probe = await page.evaluate(() => Reflect.get(globalThis, '__wmcVp8AbiProbe'));
        const abi = probe as { instances: number; stepCalls: number };
        assert(
          abi?.instances > 0 && abi.stepCalls > 0,
          'Main route did not call compiled VP8 ABI step'
        );
        recovery.abi = abi;
        recovery.injectedTrap = await exerciseInjectedTrap(
          page,
          fixture,
          fixturePath,
          fixtureDigest,
          output,
          errors
        );
        recovery.activeStop = await exerciseActiveStop(
          context,
          server,
          fixturePath,
          fixtureDigest,
          stopFixturePath,
          output,
          loadApplication
        );
        assert.deepEqual(errors, [], 'Functional page errors');
        const wasm = await Promise.all(fetchedWasm);
        const ownedAsset = build.state.files.find((entry) =>
          /^assets\/owned-vp8[-.][\w-]{8}\.wasm$/.test(entry.path)
        );
        assert(ownedAsset, 'Candidate compiled owned WASM inventory entry is absent');
        assert(
          wasm.some(
            (entry) =>
              entry.path === ownedAsset.path &&
              entry.bytes === ownedAsset.size &&
              entry.sha256 === ownedAsset.sha256
          ),
          'Fetched owned WASM differs from candidate inventory'
        );
        recovery.fetchedWasm = wasm;
        recovery.workerPatches = workerPatches;
        await recordCheck(recovery);
      } catch (error) {
        await captureFailure(page, output, `owned-vp8-functional-${route}`, error, errors);
        throw error;
      } finally {
        await page.close();
      }
    } finally {
      await context.close();
    }
  }
}

async function nearCapFunctional(
  mode: 'near-cap' | 'large-admitted',
  browser: Browser,
  bundleRoot: string,
  output: string,
  prior: Build,
  candidate: Build,
  server: Server,
  validateBundleFile: (root: string, path: string) => Promise<string>,
  loadApplication: (page: Page, url: string) => Promise<unknown>,
  record: (value: unknown) => Promise<void>
) {
  const largeAdmitted = mode === 'large-admitted';
  const fixture = largeAdmitted ? LARGE_ADMITTED_FIXTURE : NEAR_CAP_FIXTURE;
  const manifestPath = await validateBundleFile(
    bundleRoot,
    largeAdmitted
      ? 'validation/windows/owned-vp8-large-admitted.json'
      : 'validation/windows/owned-vp8-near-cap.json'
  );
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString()) as {
    schemaVersion: number;
    generator: string;
    input: {
      path: string;
      sha256: string;
      bytes: number;
      codec: string;
      width: number;
      height: number;
      pixels: number;
      frames: number;
      fps: number;
      durationMs: number;
    };
    settings: {
      format: string;
      quality: Quality;
      qualityPercent: number;
      targetCadenceFps: number;
      scale: number;
      smartFrameSkip: string;
    };
  };
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(
    manifest.generator,
    largeAdmitted
      ? 'scripts/test/generate-owned-vp8-large-admitted.ts'
      : 'scripts/test/generate-owned-vp8-near-cap.ts'
  );
  assert.deepEqual(manifest.input, {
    path: fixture.path,
    sha256: largeAdmitted
      ? 'd3aae8949721b4f278e0c12f5abe3b4b98edbfd37d2f7143e7d1e7fbf35abe10'
      : '7cdc718657b916d30243b53c80db6c72460b15bb37881cca2b4efc34fd6a896e',
    bytes: largeAdmitted ? 7762 : 8885,
    codec: 'vp9',
    width: fixture.width,
    height: 2457,
    pixels: fixture.width * fixture.height,
    frames: 2,
    fps: 2,
    durationMs: 1_000,
  });
  assert.deepEqual(manifest.settings, {
    format: 'webp',
    quality: 'low',
    qualityPercent: 60,
    targetCadenceFps: 12,
    scale: 1,
    smartFrameSkip: 'off',
  });
  const inputPath = await validateBundleFile(bundleRoot, fixture.path);
  const source = await readFile(inputPath);
  assert.equal(source.length, manifest.input.bytes, `${mode} input size differs`);
  assert.equal(digest(source), manifest.input.sha256, `${mode} input digest differs`);
  let candidatePassed = false;
  for (const name of ['prior', 'candidate'] as const) {
    const build = name === 'prior' ? prior : candidate;
    await server.setDistribution(build.relativePath);
    const workerPatches: Array<{ path: string; originalSha256: string; patchedSha256: string }> =
      [];
    const context = await createContext(browser, build, true, true, workerPatches);
    const fetchedWasm: Array<Promise<FetchedWasm>> = [];
    context.on('response', (response) => {
      const path = new URL(response.url()).pathname.slice(1);
      if (/^assets\/(?:owned-vp8|webp-wasm)[-.][\w-]{8}\.wasm$/.test(path))
        fetchedWasm.push(
          response.body().then((bytes) => ({ path, bytes: bytes.length, sha256: digest(bytes) }))
        );
    });
    try {
      await context.addInitScript(instrumentNearCapDecodedFrames);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => {
        if (errors.length < 32) errors.push(error.message);
      });
      const consoleCapture = captureNearCapConsole(page);
      let checked: Awaited<ReturnType<typeof measureJob>> | undefined;
      let decodedFrameProbe: unknown;
      let probe: FunctionalAbiProbe | undefined;
      let wasm: FetchedWasm[] | undefined;
      try {
        await loadApplication(page, server.url);
        const decoderSupport = await page.evaluate(
          async ({ width, height }) => {
            if (typeof VideoDecoder === 'undefined')
              return { supported: false, reason: 'VideoDecoder unavailable' };
            try {
              const result = await VideoDecoder.isConfigSupported({
                codec: 'vp09.00.10.08',
                codedWidth: width,
                codedHeight: height,
              });
              return {
                supported: result.supported,
                reason: result.supported ? null : `VP9 ${width}x${height} unsupported`,
              };
            } catch (error) {
              return { supported: false, reason: String(error) };
            }
          },
          { width: fixture.width, height: fixture.height }
        );
        await record({
          phase: 'decoder-support',
          build: name,
          decoderSupport,
          input: manifest.input,
          manifestSha256: digest(manifestBytes),
          settings: manifest.settings,
          prior: prior.state.sourceSha,
          candidate: candidate.state.sourceSha,
        });
        assert(
          decoderSupport.supported,
          `${mode} native source decode unsupported: ${decoderSupport.reason}`
        );
        await configurePage(page, inputPath, fixture, manifest.settings.quality);
        checked = await measureJob(
          page,
          fixture,
          manifest.input.sha256,
          manifest.settings.quality,
          name,
          'first-in-document',
          output,
          `owned-vp8-functional-${mode}-${name}`
        );
        decodedFrameProbe = largeAdmitted
          ? await page.evaluate(() => Reflect.get(globalThis, '__wmcNearCapDecodedFrames'))
          : null;
        if (largeAdmitted)
          assertLargeAdmittedDecodedFrames(
            decodedFrameProbe as Parameters<typeof assertLargeAdmittedDecodedFrames>[0]
          );
        probe = (await page.evaluate(() =>
          Reflect.get(globalThis, '__wmcVp8AbiProbe')
        )) as FunctionalAbiProbe;
        assert(checked.parsed.frames.length > 0, `${mode} WebP has no saved frames`);
        const scenes = checked.decoded.frames.map((frame) => {
          const [r, g, b] = frame.centerRgb;
          if (r! > 120 && g! < 110 && b! < 110) return 'red';
          if (b! > 110 && r! < 120 && g! < 120) return 'blue';
          return 'unknown';
        });
        assert.deepEqual(
          scenes.filter((scene, index) => index === 0 || scene !== scenes[index - 1]),
          ['red', 'blue'],
          `${mode} visible source scenes differ`
        );
        if (largeAdmitted)
          assertLargeAdmittedTimeline(
            checked.decoded.frames.map((frame, index) => ({
              scene: scenes[index]!,
              durationMs: frame.durationMs,
            }))
          );
        wasm = await Promise.all(fetchedWasm);
        const backendAsset = assertFunctionalBackendEvidence(name, probe, wasm, build.state.files);
        assert.deepEqual(errors, [], `${mode} page errors`);
        await record({
          phase: 'completed',
          build: name,
          status: 'passed',
          route: `ui-main-${mode}`,
          fixture: fixture.id,
          inputSha256: manifest.input.sha256,
          manifestSha256: digest(manifestBytes),
          settings: manifest.settings,
          decoderSupport,
          probe,
          decodedFrameProbe,
          backend: name === 'prior' ? 'legacy-wasm-webp' : 'owned-vp8',
          backendAsset,
          saved: checked.saved,
          parsed: checked.parsed,
          decoded: checked.decoded,
          fetchedWasm: wasm,
          workerPatches,
        });
        if (name === 'candidate') candidatePassed = true;
      } catch (error) {
        await captureFailure(
          page,
          output,
          `owned-vp8-functional-${mode}-${name}`,
          error,
          errors,
          consoleCapture.snapshot()
        );
        await record(
          functionalFailureRecord(name, error, {
            checked,
            probe,
            decodedFrameProbe,
            fetchedWasm: wasm,
          })
        );
        if (name === 'candidate') throw error;
      } finally {
        consoleCapture.detach();
        await page.close();
      }
    } finally {
      await context.close();
    }
  }
  assert(candidatePassed, `${mode} candidate did not complete`);
}

export async function exerciseOwnedVp8Product({
  browser,
  bundleRoot,
  output,
  scenario,
  prior,
  candidate,
  server,
  validateBundleFile,
  loadApplication,
}: {
  browser: Browser;
  bundleRoot: string;
  output: string;
  scenario:
    | 'owned-vp8-product'
    | 'owned-vp8-product-ba'
    | 'owned-vp8-product-v8-low'
    | 'owned-vp8-product-v8-low-ba'
    | 'owned-vp8-product-v8-medium'
    | 'owned-vp8-product-v8-medium-ba'
    | 'owned-vp8-product-v8-high'
    | 'owned-vp8-product-v8-high-ba'
    | 'owned-vp8-product-near-cap'
    | 'owned-vp8-product-large-admitted';
  prior: Build;
  candidate: Build;
  server: Server;
  validateBundleFile: (root: string, path: string) => Promise<string>;
  loadApplication: (page: Page, url: string) => Promise<unknown>;
}) {
  await mkdir(output, { recursive: true });
  const fullVideo = scenario.includes('-v8');
  const largeAdmitted = scenario === 'owned-vp8-product-large-admitted';
  const functionalOnly = scenario === 'owned-vp8-product-near-cap' || largeAdmitted;
  const v8Quality = fullVideo
    ? (/^owned-vp8-product-v8-(low|medium|high)(?:-ba)?$/.exec(scenario)?.[1] as
        | Quality
        | undefined)
    : undefined;
  if (fullVideo) assert(v8Quality, 'V8 scenario has no fixed quality');
  const qualities: readonly Quality[] = v8Quality ? [v8Quality] : ['low', 'medium', 'high'];
  const order = functionalOnly
    ? (['prior', 'candidate'] as const)
    : scenario.endsWith('-ba')
      ? (['candidate', 'prior'] as const)
      : (['prior', 'candidate'] as const);
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    scenario,
    ...(fullVideo ? { timingInvocationId: randomUUID() } : {}),
    fixedQuality: v8Quality ?? null,
    status: 'running',
    browserVersion: browser.version(),
    order,
    prior: {
      sourceSha: prior.state.sourceSha,
      treeSha: prior.state.treeSha,
      coreSha: prior.state.coreSha,
      manifestSha256: prior.manifestSha256,
    },
    candidate: {
      sourceSha: candidate.state.sourceSha,
      treeSha: candidate.state.treeSha,
      coreSha: candidate.state.coreSha,
      manifestSha256: candidate.manifestSha256,
    },
    timingScope: functionalOnly
      ? 'Functional-only conversion; incidental elapsed time is not a performance sample'
      : 'UI Convert click to matching published WebP Blob download control ready; save, parse and independent decode follow timing',
    timingGate: functionalOnly
      ? null
      : 'After five balanced controller invocations, compare medians for matching workload and condition; candidate regression <= max(5%, 20ms); retain every sample and range/MAD',
    cacheScope: functionalOnly
      ? 'separate browser context and one functional first-in-document attempt per build; no fresh-profile cold claim'
      : 'separate browser contexts per build, same document first/warm within each fixture-quality page; no fresh-profile cold claim',
    softwareInjection:
      'Page OffscreenCanvas.convertToBlob disabled before application code; timed V8 Worker has numeric ABI/copy probe and pinned prior loader has post-loop copy callback; a patch record alone is not encoding-route proof',
    functionalScope: functionalOnly
      ? `Independent pinned-prior legacy wasm-webp and candidate owned-VP8 ${largeAdmitted ? 'large admitted' : 'near-cap'} UI attempts, outside the V8 timing cohort; candidate must pass and prior outcome is retained separately`
      : fullVideo
        ? 'After first/warm timing samples with bounded numeric probes, one additional candidate main-WASM conversion independently checks ABI2 begin calls; emitted ANMF counts are recorded separately. Active Stop and recovery remain in the small selector.'
        : 'Candidate UI main software recovery and active Stop; separate direct conversion Worker protocol and owned output',
    samples: [] as Sample[],
    functional: [] as unknown[],
    nearCapPreflights: [] as unknown[],
    largeAdmittedPreflights: [] as unknown[],
  };
  let legacyLoaderPatch: { path: string; bytes: Uint8Array } | undefined;
  if (fullVideo) {
    assert.equal(
      prior.state.sourceSha,
      'be35f5fa89a60189475fe2ef7fd446e9fa18cef4',
      'V8 prior compiled source changed'
    );
    const legacyWasm = prior.state.files.filter((file) =>
      /^assets\/webp-wasm[-.][\w-]{8}\.wasm$/.test(file.path)
    );
    assert.equal(legacyWasm.length, 1, 'Prior WebP WASM is not unique');
    assert.equal(
      legacyWasm[0]!.sha256,
      PINNED_PRIOR_LEGACY_WASM_SHA256,
      'V8 prior WebP WASM changed'
    );
    const loader = prior.state.files.filter((file) =>
      /^assets\/webp-wasm[-.][\w-]{8}\.js$/.test(file.path)
    );
    assert.equal(loader.length, 1, 'Prior WebP loader is not unique');
    const file = loader[0]!;
    assert.equal(file.sha256, PINNED_PRIOR_LEGACY_LOADER_SHA256, 'V8 prior loader changed');
    assert(file.size > 0 && file.size < 1024 * 1024, 'Prior loader size is invalid');
    const loaderPath = await validateBundleFile(bundleRoot, `${prior.relativePath}/${file.path}`);
    const original = await readFile(loaderPath);
    assert.equal(original.length, file.size, 'Prior loader inventory size differs');
    const patched = patchPinnedLegacyLoader(original);
    legacyLoaderPatch = { path: file.path, bytes: patched.bytes };
    report.priorLegacyLoaderPatch = {
      path: file.path,
      originalSha256: file.sha256,
      patchedSha256: patched.sha256,
      instrumentation: 'post-loop-actual-iteration-count',
    };
  }
  const reportPath = join(output, `${scenario}.json`);
  const persist = async () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await persist();
  try {
    if (functionalOnly) {
      await nearCapFunctional(
        largeAdmitted ? 'large-admitted' : 'near-cap',
        browser,
        bundleRoot,
        output,
        prior,
        candidate,
        server,
        validateBundleFile,
        loadApplication,
        async (value) => {
          const entry = value as {
            phase: string;
            build: 'prior' | 'candidate';
            input?: { path: string; bytes: number; sha256: string };
            manifestSha256: string;
            status?: string;
          };
          if (entry.phase === 'decoder-support') {
            (
              (largeAdmitted
                ? report.largeAdmittedPreflights
                : report.nearCapPreflights) as unknown[]
            ).push(value);
            report.inputs = [entry.input];
            report[
              largeAdmitted ? 'largeAdmittedInputManifestSha256' : 'nearCapInputManifestSha256'
            ] = entry.manifestSha256;
          } else {
            (report.functional as unknown[]).push(value);
            const prefix = largeAdmitted ? 'largeAdmitted' : 'nearCap';
            if (entry.build === 'prior') report[`${prefix}PriorStatus`] = entry.status;
            if (entry.build === 'candidate') report[`${prefix}CandidateStatus`] = entry.status;
          }
          await persist();
        }
      );
      report.status = 'passed';
      await persist();
      return { profile: scenario, status: 'passed', report: `${scenario}.json`, samples: 0 };
    }
    if (fullVideo) {
      const manifestPath = await validateBundleFile(
        bundleRoot,
        'validation/windows/owned-vp8-v8.json'
      );
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        schemaVersion: number;
        input: {
          path: string;
          sha256: string;
          width: number;
          height: number;
          frames: number;
          fps: number;
          durationMs: number;
        };
        settings: {
          format: string;
          qualities: string[];
          qualityPercent: number[];
          targetCadenceFps: number[];
          scale: number;
          smartFrameSkip: string;
        };
        timingGate: {
          balancedInvocations: number;
          maximumMedianRegressionPercent: number;
          minimumMedianAllowanceMs: number;
        };
      };
      assert.equal(manifest.schemaVersion, 1);
      assert.deepEqual(manifest.input, {
        path: V8_FIXTURE.path,
        sha256: V8_SHA256,
        width: 1920,
        height: 1080,
        frames: 192,
        fps: 30,
        durationMs: 6400,
      });
      assert.deepEqual(manifest.settings, {
        format: 'webp',
        qualities: ['low', 'medium', 'high'],
        qualityPercent: [60, 75, 85],
        targetCadenceFps: [12, 18, 30],
        scale: 1,
        smartFrameSkip: 'off',
      });
      assert.deepEqual(manifest.timingGate, {
        balancedInvocations: 5,
        maximumMedianRegressionPercent: 5,
        minimumMedianAllowanceMs: 20,
      });
      report.frozenInputManifestSha256 = digest(await readFile(manifestPath));
    }
    const inputs = await Promise.all(
      (fullVideo ? [V8_FIXTURE] : FIXTURES).map(async (fixture) => {
        const path = await validateBundleFile(bundleRoot, fixture.path);
        const bytes = await readFile(path);
        assert(
          bytes.length > 0 && bytes.length <= MAX_INPUT_BYTES,
          `${fixture.id} fixture outside bound`
        );
        const sha256 = digest(bytes);
        if (fixture.id === 'v8-full') {
          assert.equal(bytes.length, 3_145_371, 'V8 source size differs from M0');
          assert.equal(sha256, V8_SHA256, 'V8 source digest differs from M0');
        }
        return { fixture, path, sha256, bytes: bytes.length };
      })
    );
    report.inputs = inputs.map(({ fixture, sha256, bytes }) => ({
      id: fixture.id,
      path: fixture.path,
      sha256,
      bytes,
    }));
    const ownedAsset = candidate.state.files.filter((entry) =>
      /^assets\/owned-vp8[-.][\w-]{8}\.wasm$/.test(entry.path)
    );
    assert.equal(ownedAsset.length, 1, 'Candidate has no unique compiled owned VP8 WASM asset');
    report.ownedAsset = ownedAsset[0];
    for (const name of order) {
      const build = name === 'prior' ? prior : candidate;
      await server.setDistribution(build.relativePath);
      const workerPatches: Array<{ path: string; originalSha256: string; patchedSha256: string }> =
        [];
      const context = await createContext(
        browser,
        build,
        false,
        false,
        workerPatches,
        fullVideo,
        name === 'prior' ? legacyLoaderPatch : undefined
      );
      try {
        for (const { fixture, path, sha256 } of inputs) {
          for (const quality of qualities) {
            const page = await context.newPage();
            const errors: string[] = [];
            let activeCase = `owned-vp8-${scenario}-${name}-${fixture.id}-${quality}-prepare`;
            page.on('pageerror', (error) => {
              if (errors.length < 32) errors.push(error.message);
            });
            try {
              await loadApplication(page, server.url);
              await configurePage(page, path, fixture, quality);
              let firstDocumentTimeOrigin: unknown;
              for (const condition of ['first-in-document', 'same-document-warm'] as const) {
                activeCase = `owned-vp8-${scenario}-${name}-${fixture.id}-${quality}-${condition}`;
                const sample: Sample = await measureJob(
                  page,
                  fixture,
                  sha256,
                  quality,
                  name,
                  condition,
                  output,
                  activeCase,
                  'convert',
                  report.timingInvocationId as string | undefined
                );
                sample.contextIdentity = `${scenario}:${name}`;
                sample.pageIdentity = `${fixture.id}:${quality}`;
                if (condition === 'first-in-document') firstDocumentTimeOrigin = sample.timeOrigin;
                else
                  assert.equal(
                    sample.timeOrigin,
                    firstDocumentTimeOrigin,
                    'Warm conversion changed document'
                  );
                assert.deepEqual(errors, [], `${name} ${fixture.id} ${quality} page errors`);
                (report.samples as Sample[]).push(sample);
                await persist();
              }
              if (fullVideo && name === 'candidate') {
                activeCase = `owned-vp8-${scenario}-${name}-${fixture.id}-${quality}-functional-cadence`;
                await page.evaluate(instrumentOwnedInstance);
                const checked = await measureJob(
                  page,
                  fixture,
                  sha256,
                  quality,
                  name,
                  'same-document-warm',
                  output,
                  activeCase
                );
                const probe = (await page.evaluate(() =>
                  Reflect.get(globalThis, '__wmcVp8AbiProbe')
                )) as {
                  instances: number;
                  successfulBeginCalls: number;
                  beginStatusCounts: Record<string, number>;
                };
                assert(probe.instances > 0, 'V8 functional conversion did not create owned WASM');
                const expected = (fixture.durationMs * CADENCE[quality]) / 1_000;
                assert(
                  probe.successfulBeginCalls >= Math.floor(expected) - 4 &&
                    probe.successfulBeginCalls <= Math.ceil(expected) + 4,
                  `Full V8 conversion omitted the selected ${CADENCE[quality]} fps encoded work`
                );
                assert(
                  checked.parsed.frames.length <= probe.successfulBeginCalls,
                  'V8 emitted more ANMF chunks than successful ABI2 begins'
                );
                (report.functional as unknown[]).push({
                  route: 'ui-main-v8-cadence',
                  fixture: fixture.id,
                  quality,
                  inputSha256: sha256,
                  targetCadenceFps: CADENCE[quality],
                  expectedBeginCalls: expected,
                  toleranceFrames: 4,
                  abi: probe,
                  emittedAnmfCount: checked.parsed.frames.length,
                  saved: checked.saved,
                  parsed: checked.parsed,
                  decoded: checked.decoded,
                });
                await persist();
              }
            } catch (error) {
              await captureFailure(page, output, activeCase, error, errors);
              throw error;
            } finally {
              await page.close();
            }
          }
        }
        report[`${name}WorkerPatches`] = workerPatches;
      } finally {
        await context.close();
      }
    }
    const samples = report.samples as Sample[];
    assert.equal(
      samples.length,
      fullVideo ? 4 : 24,
      'Scenario sample count differs from declared cohort'
    );
    for (const selected of samples.filter((sample) => sample.build === 'candidate')) {
      const priorSample = samples.find(
        (sample) =>
          sample.build === 'prior' &&
          sample.fixture === selected.fixture &&
          sample.quality === selected.quality &&
          sample.condition === selected.condition
      );
      assert(priorSample, 'Candidate sample has no paired prior sample');
      assert.equal(selected.inputSha256, priorSample.inputSha256, 'Paired inputs differ');
      // The muxer may merge identical encoded frames and extend their hold.
      // ANMF counts describe output representation, not selected-frame work.
      selected.pairedEmittedAnmfCount = (priorSample.parsed as { frames: unknown[] }).frames.length;
    }
    await server.setDistribution(candidate.relativePath);
    if (!fullVideo) {
      const stopFixturePath = await validateBundleFile(bundleRoot, STOP_FIXTURE);
      await candidateFunctional(
        browser,
        candidate,
        server,
        output,
        inputs[0]!.path,
        inputs[0]!.sha256,
        inputs[1]!.path,
        inputs[1]!.sha256,
        stopFixturePath,
        loadApplication,
        async (check) => {
          (report.functional as unknown[]).push(check);
          await persist();
        }
      );
    }
    report.status = 'passed';
    await persist();
    return {
      profile: scenario,
      status: 'passed',
      report: `${scenario}.json`,
      samples: (report.samples as Sample[]).length,
    };
  } catch (error) {
    report.status = 'failed';
    report.error = failure(error);
    await persist();
    throw error;
  }
}

/** Separate functional reachability receipt. No timing cohort is modified. */
export async function exerciseOwnedVp8OwnerRetention({
  browser,
  bundleRoot,
  output,
  candidate,
  server,
  validateBundleFile,
  loadApplication,
}: {
  browser: Browser;
  bundleRoot: string;
  output: string;
  candidate: Build;
  server: Server;
  validateBundleFile: (root: string, path: string) => Promise<string>;
  loadApplication: (page: Page, url: string) => Promise<unknown>;
}) {
  await mkdir(output, { recursive: true });
  const scenario = 'owned-vp8-owner-retention';
  const ownedAsset = candidate.state.files.filter((entry) =>
    /^assets\/owned-vp8[-.][\w-]{8}\.wasm$/.test(entry.path)
  );
  assert.equal(ownedAsset.length, 1, 'Candidate owned WASM asset is not unique');
  await validateBundleFile(bundleRoot, `${candidate.relativePath}/${ownedAsset[0]!.path}`);
  const fixture = FIXTURES[0]!;
  const fixturePath = await validateBundleFile(bundleRoot, fixture.path);
  const fixtureDigest = digest(await readFile(fixturePath));
  const stopFixturePath = await validateBundleFile(bundleRoot, STOP_FIXTURE);
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    scenario,
    status: 'UNVERIFIED',
    scope: 'validation-only post-owner reachability; no physical, RSS, GPU or timing claim',
    candidate: {
      sourceSha: candidate.state.sourceSha,
      treeSha: candidate.state.treeSha,
      coreSha: candidate.state.coreSha,
      manifestSha256: candidate.manifestSha256,
      ownedAsset: ownedAsset[0],
    },
    fixture: {
      id: fixture.id,
      sha256: fixtureDigest,
      quality: 'medium',
      scale: 1,
      smartFrameSkip: 'off',
    },
    browserVersion: browser.version(),
    guestProcessId: process.pid,
    invocationId: randomUUID(),
    contextIds: { main: randomUUID(), negativeControl: randomUUID(), worker: randomUUID() },
    probeSha256: digest(
      Buffer.from(
        [
          instrumentOwnedInstance.toString(),
          installWorkerLifecycleObserver.toString(),
          installRetainedWorkerProbe.toString(),
          collectGarbageCheckpoint.toString(),
        ].join('\n')
      )
    ),
    ownerReleaseBinding: {
      main: 'src/services/webp-encoder-service.ts:208-211,273-280; src/services/owned-vp8-core.ts:466-485,624-649',
      worker:
        'src/services/conversion-worker/main-thread-proxy.ts:112-123,136-143,188-194,253-270,305-314',
      observationLimit:
        'Private broker.release is source-bound, not independently observed by this probe',
    },
    compiledModuleCache:
      'allowed immutable Module; excluded from mutable Instance and Memory capacity',
    main: [] as unknown[],
    worker: [] as unknown[],
    negativeControl: null,
    errors: [] as string[],
  };
  const reportPath = join(output, `${scenario}.json`);
  const persist = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await persist();
  const mainAttempts = report.main as Array<{
    kind: string;
    createdCount: number;
    checkpoint: Awaited<ReturnType<typeof collectGarbageCheckpoint>>;
    ownerReleased: boolean;
    outputBytes?: number;
  }>;
  const workerAttempts = report.worker as Array<{
    kind: string;
    id: number;
    requestId: string | null;
    terminalType: string | null;
    terminatedAtMs: number | null;
    closeAtMs: number | null;
    closeObserved: boolean;
    closeCapability: boolean;
    openAfterTimeout: boolean | null;
    snapshot: {
      requestId: string | null;
      createdCount: number;
      records: Array<{
        id: number;
        successfulBeginCalls: number;
        stepCalls: number;
        retireCalls: number;
        retireStatus: number | null;
        peakCapacityBytes: number;
        retirementTimeCapacityBytes: number | null;
      }>;
    } | null;
    preCloseMutableCapacityBytes: number | null;
    postCloseReachableCapacityBytes: number | null;
    outputBytes?: number;
  }>;
  try {
    const mainContext = await createContext(browser, candidate, true, true, []);
    try {
      const page = await mainContext.newPage();
      try {
        await loadApplication(page, server.url);
        const documentIdentity = await page.evaluate(() => performance.timeOrigin);
        await configurePage(page, fixturePath, fixture, 'medium');
        const mainCheckpoint = async (kind: string, outputBytes?: number) => {
          const createdCount = await page.evaluate(() => {
            const probe = Reflect.get(globalThis, '__wmcVp8AbiProbe') as { instances: number };
            return probe.instances;
          });
          const ownerReleased = await page.evaluate(
            (origin) =>
              performance.timeOrigin === origin &&
              !document.querySelector('[data-testid="stop-conversion-button"]')?.getClientRects()
                .length,
            documentIdentity
          );
          const checkpoint = await collectGarbageCheckpoint(page);
          mainAttempts.push({
            kind,
            createdCount,
            checkpoint,
            ownerReleased,
            ...(outputBytes !== undefined ? { outputBytes } : {}),
          });
          await persist();
        };
        for (let index = 0; index < 3; index++) {
          const sample = await measureJob(
            page,
            fixture,
            fixtureDigest,
            'medium',
            'candidate',
            index === 0 ? 'first-in-document' : 'same-document-warm',
            output,
            `${scenario}-main-complete-${index + 1}`
          );
          await mainCheckpoint(`complete-${index + 1}`, sample.saved.bytes);
        }
        await configurePage(
          page,
          stopFixturePath,
          {
            id: 'active-stop',
            path: STOP_FIXTURE,
            mime: 'video/mp4',
            width: 320,
            height: 180,
            durationMs: 3_000,
          },
          'high'
        );
        await page.evaluate(() =>
          (Reflect.get(globalThis, '__wmcVp8ProductObserver') as { reset: () => void }).reset()
        );
        const beforeStopSteps = await page.evaluate(
          () => (Reflect.get(globalThis, '__wmcVp8AbiProbe') as { stepCalls: number }).stepCalls
        );
        await page.locator('[data-testid="convert-button"]').click();
        const stopPrompt = page.locator('[data-testid="modal-confirm-button"]');
        if (await stopPrompt.isVisible()) await stopPrompt.click();
        await page.waitForFunction(
          (before) =>
            (Reflect.get(globalThis, '__wmcVp8AbiProbe') as { stepCalls: number }).stepCalls >
            before,
          beforeStopSteps,
          { timeout: 30_000 }
        );
        await page.locator('[data-testid="stop-conversion-button"]').click();
        await page.waitForFunction(
          () => {
            const button = document.querySelector<HTMLButtonElement>(
              '[data-testid="convert-button"]'
            );
            return (
              !!button &&
              !button.disabled &&
              !document.querySelector('[data-testid="stop-conversion-button"]')
            );
          },
          undefined,
          { timeout: 10_000 }
        );
        const mainStopOutcome = await page.evaluate(() => {
          const observed = Reflect.get(globalThis, '__wmcVp8ProductObserver') as {
            stopMs: number | null;
            idleMs: number | null;
            publications: unknown[];
          };
          return {
            stopMs: observed.stopMs,
            idleMs: observed.idleMs,
            publications: observed.publications.length,
            resultVisible: !!document
              .querySelector('[data-testid="result-section"]')
              ?.getClientRects().length,
          };
        });
        assert(
          mainStopOutcome.stopMs !== null &&
            mainStopOutcome.idleMs !== null &&
            mainStopOutcome.idleMs >= mainStopOutcome.stopMs &&
            mainStopOutcome.idleMs - mainStopOutcome.stopMs <= 500 &&
            mainStopOutcome.publications === 0 &&
            !mainStopOutcome.resultVisible,
          'Main Stop did not reach the existing idle/no-publication contract'
        );
        report.mainStopOutcome = mainStopOutcome;
        await mainCheckpoint('stop');
        await configurePage(page, fixturePath, fixture, 'medium');
        const afterStop = await measureJob(
          page,
          fixture,
          fixtureDigest,
          'medium',
          'candidate',
          'same-document-warm',
          output,
          `${scenario}-main-after-stop`
        );
        await mainCheckpoint('after-stop', afterStop.saved.bytes);
        await page.evaluate(() => {
          const probe = Reflect.get(globalThis, '__wmcVp8AbiProbe') as {
            injectNextStepTrap: boolean;
          };
          probe.injectNextStepTrap = true;
        });
        await page.locator('[data-testid="convert-button"]').click();
        const trapPrompt = page.locator('[data-testid="modal-confirm-button"]');
        if (await trapPrompt.isVisible()) await trapPrompt.click();
        await page
          .locator('[data-testid="error-display"]')
          .waitFor({ state: 'visible', timeout: CONVERSION_TIMEOUT_MS });
        await page
          .locator('[data-testid="convert-button"]')
          .waitFor({ state: 'visible', timeout: 10_000 });
        await mainCheckpoint('post-step-trap');
        const afterTrap = await measureJob(
          page,
          fixture,
          fixtureDigest,
          'medium',
          'candidate',
          'same-document-warm',
          output,
          `${scenario}-main-after-trap`,
          'retry'
        );
        await mainCheckpoint('after-trap', afterTrap.saved.bytes);
      } finally {
        await page.close();
      }
    } finally {
      await mainContext.close();
    }

    const controlContext = await createContext(browser, candidate, true, true, []);
    try {
      const page = await controlContext.newPage();
      try {
        await loadApplication(page, server.url);
        await configurePage(page, fixturePath, fixture, 'medium');
        await page.evaluate(() =>
          (
            Reflect.get(globalThis, '__wmcVp8AbiProbe') as { retainNextForControl: () => void }
          ).retainNextForControl()
        );
        await measureJob(
          page,
          fixture,
          fixtureDigest,
          'medium',
          'candidate',
          'first-in-document',
          output,
          `${scenario}-negative-control`
        );
        const held = await collectGarbageCheckpoint(page);
        await page.evaluate(() =>
          (
            Reflect.get(globalThis, '__wmcVp8AbiProbe') as { releaseControl: () => void }
          ).releaseControl()
        );
        await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
        const released = await collectGarbageCheckpoint(page);
        report.negativeControl = { held, released };
        await persist();
      } finally {
        await page.close();
      }
    } finally {
      await controlContext.close();
    }

    const workerPatches: Array<{ path: string; originalSha256: string; patchedSha256: string }> =
      [];
    const workerContext = await createContext(
      browser,
      candidate,
      true,
      false,
      workerPatches,
      false,
      undefined,
      true
    );
    try {
      const page = await workerContext.newPage();
      const browserWorkers: Array<{
        id: number;
        closeAtMs: number | null;
        worker: WeakRef<ReturnType<Page['workers']>[number]>;
      }> = [];
      page.on('worker', (worker) => {
        if (!/^\/assets\/worker-[\w-]+\.js$/.test(new URL(worker.url()).pathname)) return;
        const entry = {
          id: browserWorkers.length + 1,
          closeAtMs: null as number | null,
          worker: new WeakRef(worker),
        };
        browserWorkers.push(entry);
        worker.on('close', () => {
          entry.closeAtMs = Date.now();
        });
      });
      const lifecycle = () =>
        page.evaluate(() => {
          const probe = Reflect.get(globalThis, '__wmcVp8WorkerLifecycle') as {
            snapshot: () => Array<{
              id: number;
              requestId: string | null;
              terminalType: string | null;
              terminalSnapshot: unknown;
              terminatedAtMs: number | null;
              invalidSnapshot: boolean;
            }>;
          };
          return { timeOrigin: performance.timeOrigin, records: probe.snapshot() };
        });
      const recordWorker = async (kind: string, outputBytes?: number, stopSnapshot?: unknown) => {
        const current = await lifecycle();
        const record = current.records.at(-1);
        if (!record) throw new Error('Product Worker creation was not observed');
        const matching = browserWorkers.find((entry) => entry.id === record.id);
        if (matching && record.terminatedAtMs !== null) {
          const deadline = Date.now() + 5_000;
          while (matching.closeAtMs === null && Date.now() < deadline)
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
        const openAfterTimeout = (() => {
          if (!matching || matching.closeAtMs !== null) return null;
          const target = matching.worker.deref();
          return target ? page.workers().includes(target) : null;
        })();
        const snapshot = (stopSnapshot ??
          record.terminalSnapshot) as (typeof workerAttempts)[number]['snapshot'];
        workerAttempts.push({
          kind,
          id: record.id,
          requestId: record.requestId,
          terminalType: record.terminalType,
          terminatedAtMs:
            record.terminatedAtMs === null ? null : current.timeOrigin + record.terminatedAtMs,
          closeAtMs: matching?.closeAtMs ?? null,
          closeObserved: matching?.closeAtMs !== null && matching?.closeAtMs !== undefined,
          closeCapability: !!matching,
          openAfterTimeout,
          snapshot,
          preCloseMutableCapacityBytes:
            snapshot?.records.reduce(
              (sum, entry) => sum + (entry.retirementTimeCapacityBytes ?? entry.peakCapacityBytes),
              0
            ) ?? null,
          postCloseReachableCapacityBytes: matching?.closeAtMs === null || !matching ? null : 0,
          ...(outputBytes !== undefined ? { outputBytes } : {}),
        });
        await persist();
      };
      try {
        await loadApplication(page, server.url);
        await configurePage(page, fixturePath, fixture, 'medium');
        for (let index = 0; index < 3; index++) {
          const sample = await measureJob(
            page,
            fixture,
            fixtureDigest,
            'medium',
            'candidate',
            index === 0 ? 'first-in-document' : 'same-document-warm',
            output,
            `${scenario}-worker-complete-${index + 1}`
          );
          await recordWorker(`complete-${index + 1}`, sample.saved.bytes);
        }
        await configurePage(
          page,
          stopFixturePath,
          {
            id: 'active-stop',
            path: STOP_FIXTURE,
            mime: 'video/mp4',
            width: 320,
            height: 180,
            durationMs: 3_000,
          },
          'high'
        );
        await page.evaluate(() =>
          (Reflect.get(globalThis, '__wmcVp8ProductObserver') as { reset: () => void }).reset()
        );
        const workerCreated = page.waitForEvent('worker', { timeout: 30_000 });
        await page.locator('[data-testid="convert-button"]').click();
        const prompt = page.locator('[data-testid="modal-confirm-button"]');
        if (await prompt.isVisible()) await prompt.click();
        let activeWorker: Awaited<typeof workerCreated> | undefined = await workerCreated;
        let stopSnapshot: unknown = null;
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          try {
            stopSnapshot = await activeWorker.evaluate(() => {
              const probe = Reflect.get(globalThis, '__wmcVp8RetainedWorkerProbe') as
                | { snapshot: () => { records: Array<{ stepCalls: number }> } }
                | undefined;
              return probe?.snapshot() ?? null;
            });
          } catch {
            break;
          }
          if (
            (stopSnapshot as { records?: Array<{ stepCalls: number }> } | null)?.records?.some(
              (r) => r.stepCalls > 0
            )
          )
            break;
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
        activeWorker = undefined;
        await page.locator('[data-testid="stop-conversion-button"]').click({ timeout: 10_000 });
        await page.waitForFunction(
          () => {
            const button = document.querySelector<HTMLButtonElement>(
              '[data-testid="convert-button"]'
            );
            return (
              !!button &&
              !button.disabled &&
              !document.querySelector('[data-testid="stop-conversion-button"]')
            );
          },
          undefined,
          { timeout: 10_000 }
        );
        const workerStopOutcome = await page.evaluate(() => {
          const observed = Reflect.get(globalThis, '__wmcVp8ProductObserver') as {
            stopMs: number | null;
            idleMs: number | null;
            publications: unknown[];
          };
          return {
            stopMs: observed.stopMs,
            idleMs: observed.idleMs,
            publications: observed.publications.length,
            resultVisible: !!document
              .querySelector('[data-testid="result-section"]')
              ?.getClientRects().length,
          };
        });
        assert(
          workerStopOutcome.stopMs !== null &&
            workerStopOutcome.idleMs !== null &&
            workerStopOutcome.idleMs >= workerStopOutcome.stopMs &&
            workerStopOutcome.idleMs - workerStopOutcome.stopMs <= 500 &&
            workerStopOutcome.publications === 0 &&
            !workerStopOutcome.resultVisible,
          'Worker Stop did not reach the existing idle/no-publication contract'
        );
        report.workerStopOutcome = workerStopOutcome;
        await recordWorker('stop', undefined, stopSnapshot);
        await configurePage(page, fixturePath, fixture, 'medium');
        const recovery = await measureJob(
          page,
          fixture,
          fixtureDigest,
          'medium',
          'candidate',
          'same-document-warm',
          output,
          `${scenario}-worker-after-stop`
        );
        await recordWorker('after-stop', recovery.saved.bytes);
        report.workerPatches = workerPatches;
      } finally {
        await page.close();
      }
    } finally {
      await workerContext.close();
    }
    const decision = verifyOwnerRetention({
      moduleCacheExcluded: true,
      negativeControl: report.negativeControl as {
        held: Awaited<ReturnType<typeof collectGarbageCheckpoint>>;
        released: Awaited<ReturnType<typeof collectGarbageCheckpoint>>;
      },
      main: mainAttempts,
      worker: workerAttempts,
    });
    report.status = decision.status;
    report.reasons = decision.reasons;
  } catch (error) {
    (report.errors as string[]).push(failure(error));
    report.status = 'UNVERIFIED';
  }
  await persist();
  if (report.status !== 'PASS')
    throw new Error(`Owner-retention reachability gate ${report.status}; see ${scenario}.json`);
  return { profile: scenario, status: report.status, report: `${scenario}.json` };
}
