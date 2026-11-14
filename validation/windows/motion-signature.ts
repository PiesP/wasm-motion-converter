// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { Browser, BrowserContext, Page } from '@playwright/test';

export const MOTION_SIGNATURE_SCENARIO = 'motion-signature';
export const MOTION_SIGNATURE_RECOVERY_SCENARIO = 'motion-signature-recovery';
export const MOTION_PRIMARY_FIXTURE = 'public/test-video-ci-high-motion-120fps.mp4';
export const MOTION_SMALL_FIXTURE = 'public/test-video-ci-h264.mp4';

const MAX_VERIFIED_OUTPUT_BYTES = 96 * 1024 * 1024;
const CONVERSION_TIMEOUT_MS = 180_000;

export type MotionWasmAsset = { path: string; sha256: string; size: number };
type WasmCacheObservation = {
  status:
    | 'not-applicable'
    | 'unavailable'
    | 'missing'
    | 'ambiguous'
    | 'oversize'
    | 'mismatch'
    | 'matched';
  path: string | null;
  cacheName: string | null;
  sha256: string | null;
  bytes: number | null;
  phase: 'after-first-before-warm' | 'after-warm';
  observedAtUtc: string;
  responseStatus: number | null;
  contentType: string | null;
  admission: string | null;
  sourceHeader: string | null;
  sourcePath: string | null;
  sourceOriginMatches: boolean | null;
  responseUrlEmpty: boolean | null;
};
type HostAssetRequests = { paths: string[]; overflow: boolean };

/** Reads only an existing, source-bound CacheStorage key after download readiness. */
async function readWasmCache(
  page: Page,
  asset: MotionWasmAsset | null,
  phase: WasmCacheObservation['phase']
): Promise<WasmCacheObservation> {
  const observedAtUtc = new Date().toISOString();
  if (!asset) {
    return {
      status: 'not-applicable',
      path: null,
      cacheName: null,
      sha256: null,
      bytes: null,
      phase,
      observedAtUtc,
      responseStatus: null,
      contentType: null,
      admission: null,
      sourceHeader: null,
      sourcePath: null,
      sourceOriginMatches: null,
      responseUrlEmpty: null,
    };
  }
  return page.evaluate(
    async ({ expected, phase, observedAtUtc }) => {
      const base = {
        path: expected.path,
        cacheName: null,
        sha256: null,
        bytes: null,
        phase,
        observedAtUtc,
        responseStatus: null,
        contentType: null,
        admission: null,
        sourceHeader: null,
        sourcePath: null,
        sourceOriginMatches: null,
        responseUrlEmpty: null,
      };
      if (!('caches' in globalThis) || !globalThis.crypto?.subtle) {
        return { ...base, status: 'unavailable' as const };
      }
      try {
        const names = (await caches.keys()).filter((name) =>
          name.startsWith('dropconvert-dynamic-')
        );
        if (names.length > 16) return { ...base, status: 'ambiguous' as const };
        const key = new URL(expected.path, location.origin).href;
        const matches: { name: string; response: Response }[] = [];
        for (const name of names) {
          const response = await caches.match(key, { cacheName: name });
          if (response) matches.push({ name, response });
        }
        if (matches.length === 0) return { ...base, status: 'missing' as const };
        if (matches.length !== 1) return { ...base, status: 'ambiguous' as const };
        const { name, response } = matches[0]!;
        const sourceHeader = response.headers.get('x-dropconvert-asset-source');
        let sourcePath: string | null = null;
        let sourceOriginMatches = false;
        try {
          const source = new URL(sourceHeader ?? '');
          sourcePath = source.pathname;
          sourceOriginMatches = source.origin === location.origin;
        } catch {
          // Preserve malformed cache metadata as an explicit mismatch.
        }
        const found = {
          ...base,
          cacheName: name,
          responseStatus: response.status,
          contentType: response.headers.get('content-type'),
          admission: response.headers.get('x-dropconvert-asset-admission'),
          sourceHeader,
          sourcePath,
          sourceOriginMatches,
          responseUrlEmpty: response.url === '',
        };
        if (!response.body) return { ...found, status: 'mismatch' as const };
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > 128 * 1024) {
              await reader.cancel();
              return { ...found, status: 'oversize' as const, bytes: length };
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const sha256 = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0')
        ).join('');
        const headersValid =
          found.responseStatus === 200 &&
          found.responseUrlEmpty &&
          found.contentType?.split(';')[0]?.trim().toLowerCase() === 'application/wasm' &&
          found.admission === 'body-checked-v1' &&
          sourceHeader === key &&
          found.sourcePath === expected.path &&
          found.sourceOriginMatches;
        return {
          ...found,
          status:
            headersValid && length === expected.size && sha256 === expected.sha256
              ? ('matched' as const)
              : ('mismatch' as const),
          sha256,
          bytes: length,
        };
      } catch {
        return { ...base, status: 'unavailable' as const };
      }
    },
    { expected: asset, phase, observedAtUtc }
  );
}

export function classifyWasmWarmCache({
  asset,
  first,
  warm,
  firstHost,
  warmHost,
  firstController,
  warmController,
}: {
  asset: MotionWasmAsset | null;
  first: WasmCacheObservation;
  warm: WasmCacheObservation;
  firstHost: HostAssetRequests;
  warmHost: HostAssetRequests;
  firstController: string | null;
  warmController: string | null;
}) {
  const counts = {
    firstHostCount: firstHost.paths.length,
    warmHostCount: warmHost.paths.length,
    newHostCount:
      warmHost.paths.length >= firstHost.paths.length &&
      firstHost.paths.every((path, index) => warmHost.paths[index] === path)
        ? warmHost.paths.length - firstHost.paths.length
        : null,
  };
  if (!asset) return { qualified: false, reason: 'no-gif-wasm-asset', ...counts };
  const exactSourceHeader = (value: string | null) => {
    try {
      const source = new URL(value ?? '');
      return source.pathname === asset.path && source.search === '' && source.hash === '';
    } catch {
      return false;
    }
  };
  const verified = (entry: WasmCacheObservation, phase: WasmCacheObservation['phase']) =>
    entry.status === 'matched' &&
    entry.phase === phase &&
    entry.path === asset.path &&
    entry.sha256 === asset.sha256 &&
    entry.bytes === asset.size &&
    entry.responseStatus === 200 &&
    entry.contentType?.split(';')[0]?.trim().toLowerCase() === 'application/wasm' &&
    entry.admission === 'body-checked-v1' &&
    exactSourceHeader(entry.sourceHeader) &&
    entry.sourcePath === asset.path &&
    entry.sourceOriginMatches === true &&
    entry.responseUrlEmpty === true &&
    entry.cacheName?.startsWith('dropconvert-dynamic-') === true;
  if (!verified(first, 'after-first-before-warm') || !verified(warm, 'after-warm')) {
    return { qualified: false, reason: 'cache-entry-unverified', ...counts };
  }
  if (
    first.path !== asset.path ||
    warm.path !== asset.path ||
    first.sha256 !== asset.sha256 ||
    warm.sha256 !== asset.sha256 ||
    first.cacheName !== warm.cacheName
  ) {
    return { qualified: false, reason: 'cache-identity-mismatch', ...counts };
  }
  if (firstController !== '/service-worker.js' || warmController !== '/service-worker.js') {
    return { qualified: false, reason: 'service-worker-uncontrolled', ...counts };
  }
  if (
    firstHost.overflow ||
    warmHost.overflow ||
    warmHost.paths.length < firstHost.paths.length ||
    firstHost.paths.some((path, index) => warmHost.paths[index] !== path)
  ) {
    return { qualified: false, reason: 'host-request-log-incomplete', ...counts };
  }
  if (warmHost.paths.length !== firstHost.paths.length) {
    return { qualified: false, reason: 'new-host-wasm-request', ...counts };
  }
  return { qualified: true, reason: 'matched-cache-and-no-new-host-wasm-request', ...counts };
}

export type MotionWorkload = {
  id: 'primary-enabled' | 'small-enabled' | 'primary-off';
  fixture: string;
  inputSha256: string;
  width: number;
  height: number;
  smartFrameSkip: 'low' | 'off';
  quality?: 'low' | 'medium' | 'high';
  scale?: number;
  oracleKind?: 'owner-video';
  expectedDurationUs?: number;
  durationToleranceUs?: number;
  minimumFrameCount?: number;
  minimumDistinctFrames?: number;
};

type WorkerEvent = {
  url: string;
  starts: { requestId: string; options: Record<string, unknown> }[];
  completes: { requestId: string; outputBytes: number; profile: unknown | null }[];
  retainedRoute: {
    requestId: string;
    gifRetainedMappedFrames: number;
    gifRetainedImageDataWrites: number;
    gifRetainedWasmCapacityBytes: number;
  } | null;
  errors: { requestId: string; code: string }[];
  terminationCalls: number;
};

type MotionObserver = {
  clickMs: number | null;
  outputUrls: { url: string; size: number; type: string; atMs: number }[];
  gifPublicationCount: number;
  lastGifPublication: { url: string; size: number } | null;
  readyMs: number | null;
  stopClickMs: number | null;
  idleAfterStopMs: number | null;
  workers: WorkerEvent[];
  workerConstructionFailures: { url: string; name: string }[];
  onConversionWorkerMessage: ((message: unknown) => void) | null;
  reset: () => void;
  calibrate?: () => {
    iterations: number;
    clockPairNs: number[];
    readinessCallbackNs: number[];
    blobWrapperExtraNs: number[];
    scope: string;
  };
};

export type MotionDiagnostic = {
  workload: MotionWorkload['id'];
  pageErrors: string[];
  consoleErrors: string[];
  expectedBlobAborts: { protocol: string; resourceType: string; path: string }[];
  failedRequests: { protocol: string; resourceType: string; path: string; error: string }[];
  failedResponses: { protocol: string; path: string; status: number }[];
  overflow: number;
};

function recordBounded<T>(entries: T[], item: T, diagnostic: MotionDiagnostic, limit = 16) {
  if (entries.length < limit) entries.push(item);
  else diagnostic.overflow++;
}

export function assertNoUnexpectedDiagnostics(diagnostic: MotionDiagnostic) {
  assert.deepEqual(diagnostic.pageErrors, [], 'Page emitted an unhandled error');
  assert.deepEqual(diagnostic.consoleErrors, [], 'Page emitted a console error');
  assert.deepEqual(diagnostic.failedRequests, [], 'Page had a failed request');
  assert.deepEqual(diagnostic.failedResponses, [], 'Page had an HTTP error response');
  assert.equal(diagnostic.overflow, 0, 'Page diagnostics exceeded bounded capacity');
}

/** Installed before the application; keeps all measurement events in one page clock. */
export function installMotionObserver(options?: { forceConversionWorkerFailure?: boolean }) {
  const observerOptions = options;
  const observed: MotionObserver = {
    clickMs: null,
    outputUrls: [],
    gifPublicationCount: 0,
    lastGifPublication: null,
    readyMs: null,
    stopClickMs: null,
    idleAfterStopMs: null,
    workers: [],
    workerConstructionFailures: [],
    onConversionWorkerMessage: null,
    reset() {
      this.clickMs = null;
      this.outputUrls = [];
      this.readyMs = null;
    },
  };
  Reflect.set(globalThis, '__wmcMotionObserver', observed);

  const checkDownloadReady = () => {
    if (observed.readyMs !== null || observed.outputUrls.length === 0) return;
    const latest = observed.outputUrls.at(-1);
    const button = document.querySelector<HTMLAnchorElement>(
      '[data-testid="download-result-button"]'
    );
    if (
      latest &&
      button?.getAttribute('href') === latest.url &&
      button.getClientRects().length > 0 &&
      getComputedStyle(button).visibility !== 'hidden'
    ) {
      observed.readyMs = performance.now();
    }
  };
  const checkIdleAfterStop = () => {
    if (observed.stopClickMs === null || observed.idleAfterStopMs !== null) return;
    const convert = document.querySelector<HTMLButtonElement>('[data-testid="convert-button"]');
    const stop = document.querySelector('[data-testid="stop-conversion-button"]');
    if (convert && !convert.disabled && convert.getClientRects().length > 0 && !stop) {
      observed.idleAfterStopMs = performance.now();
    }
  };
  new MutationObserver(() => {
    checkDownloadReady();
    checkIdleAfterStop();
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
  });

  const NativeWorker = Worker;
  globalThis.Worker = class ObservedWorker extends NativeWorker {
    private readonly entry: WorkerEvent | null;

    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      const url = new URL(String(scriptURL), location.href);
      if (
        /^\/assets\/worker-[\w-]+\.js$/.test(url.pathname) &&
        observerOptions?.forceConversionWorkerFailure
      ) {
        observed.workerConstructionFailures.push({ url: url.href, name: 'NotSupportedError' });
        throw new DOMException(
          'Controlled conversion Worker construction failure',
          'NotSupportedError'
        );
      }
      super(scriptURL, options);
      this.entry = /^\/assets\/worker-[\w-]+\.js$/.test(url.pathname)
        ? {
            url: url.href,
            starts: [],
            completes: [],
            retainedRoute: null,
            errors: [],
            terminationCalls: 0,
          }
        : null;
      if (this.entry) observed.workers.push(this.entry);
      this.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
        if (!this.entry || !data || typeof data !== 'object' || !('type' in data)) return;
        if (data.type === 'progress' && 'phase' in data && data.phase === 'assembling') {
          const mapped = Reflect.get(data, 'gifRetainedMappedFrames');
          const writes = Reflect.get(data, 'gifRetainedImageDataWrites');
          const capacity = Reflect.get(data, 'gifRetainedWasmCapacityBytes');
          if (
            Number.isSafeInteger(mapped) &&
            Number.isSafeInteger(writes) &&
            Number.isSafeInteger(capacity) &&
            mapped >= 0 &&
            writes >= 0 &&
            capacity >= 0
          ) {
            this.entry.retainedRoute = {
              requestId: 'requestId' in data ? String(data.requestId) : '',
              gifRetainedMappedFrames: mapped,
              gifRetainedImageDataWrites: writes,
              gifRetainedWasmCapacityBytes: capacity,
            };
          }
        } else if (
          data.type === 'complete' &&
          'outputBuffer' in data &&
          data.outputBuffer instanceof ArrayBuffer
        ) {
          this.entry.completes.push({
            requestId: 'requestId' in data ? String(data.requestId) : '',
            outputBytes: data.outputBuffer.byteLength,
            profile:
              'profile' in data && data.profile && typeof data.profile === 'object'
                ? data.profile
                : null,
          });
        } else if (data.type === 'error') {
          this.entry.errors.push({
            requestId: 'requestId' in data ? String(data.requestId) : '',
            code: 'code' in data ? String(data.code) : '',
          });
        }
        // This listener was registered in the constructor, before the product
        // installs its onmessage handler. The active-stop observer can see the
        // raw progress boundary even when the throttled DOM never renders it.
        observed.onConversionWorkerMessage?.(data);
      });
    }

    override postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
      if (
        this.entry &&
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'start' &&
        'options' in message &&
        message.options &&
        typeof message.options === 'object'
      ) {
        this.entry.starts.push({
          requestId: 'requestId' in message ? String(message.requestId) : '',
          options: { ...message.options },
        });
      }
      if (Array.isArray(options)) return super.postMessage(message, options);
      return super.postMessage(message, options);
    }

    override terminate() {
      if (this.entry) this.entry.terminationCalls++;
      return super.terminate();
    }
  };

  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (object: Blob | MediaSource) {
    const url = createObjectURL.call(URL, object);
    if (object instanceof Blob && object.type === 'image/gif') {
      // Lifetime counters deliberately survive per-measurement reset: a stale
      // cancelled publication must not disappear during recovery preparation.
      observed.gifPublicationCount++;
      observed.lastGifPublication = { url, size: object.size };
      observed.outputUrls.push({
        url,
        size: object.size,
        type: object.type,
        atMs: performance.now(),
      });
      checkDownloadReady();
    }
    return url;
  };
  // Run only after every timed conversion. Own and revoke only calibration URLs.
  observed.calibrate = () => {
    const iterations = 200;
    const clockPairNs: number[] = [];
    const readinessCallbackNs: number[] = [];
    const blobWrapperExtraNs: number[] = [];
    const savedUrls = observed.outputUrls;
    const savedReady = observed.readyMs;
    const blob = new Blob(['calibration'], { type: 'image/gif' });
    const elapsed = (action: () => void) => {
      const start = performance.now();
      for (let index = 0; index < iterations; index++) action();
      return ((performance.now() - start) * 1_000_000) / iterations;
    };
    try {
      for (let round = 0; round < 5; round++) {
        clockPairNs.push(
          elapsed(() => {
            performance.now();
            performance.now();
          })
        );
        observed.outputUrls = savedUrls;
        readinessCallbackNs.push(
          elapsed(() => {
            observed.readyMs = null;
            checkDownloadReady();
          })
        );
        observed.readyMs = savedReady;
        observed.outputUrls = [];
        const native = () => URL.revokeObjectURL(createObjectURL.call(URL, blob));
        const wrapped = () => URL.revokeObjectURL(URL.createObjectURL(blob));
        let nativeNs: number;
        let wrappedNs: number;
        if (round % 2 === 0) {
          nativeNs = elapsed(native);
          wrappedNs = elapsed(wrapped);
        } else {
          wrappedNs = elapsed(wrapped);
          nativeNs = elapsed(native);
        }
        blobWrapperExtraNs.push(wrappedNs - nativeNs);
      }
    } finally {
      observed.outputUrls = savedUrls;
      observed.readyMs = savedReady;
    }
    return {
      iterations,
      clockPairNs,
      readinessCallbackNs,
      blobWrapperExtraNs,
      scope:
        'Post-trial main-realm timer-pair, actual readiness-callback self-cost, and balanced native-versus-wrapped Blob URL cost. Excludes MutationObserver dispatch, Worker profiling/serialization, and whole-build instrumentation effects; not conversion samples.',
    };
  };
  document.addEventListener(
    'click',
    (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-testid="convert-button"]')
      ) {
        observed.clickMs = performance.now();
      }
      if (
        event.target instanceof Element &&
        event.target.closest('[data-testid="stop-conversion-button"]')
      ) {
        observed.stopClickMs = performance.now();
      }
    },
    true
  );
}

export async function choose(page: Page, group: string, value: string) {
  const option = page.locator(`[data-testid="option-${group}-${value}"]`);
  if (!(await option.isVisible()))
    await page.locator('[data-testid="advanced-settings"] summary').click();
  await option.click();
  assert.equal(await option.locator('input').isChecked(), true);
}

async function downloadIdentity(page: Page) {
  const pending = page.waitForEvent('download', { timeout: 30_000 });
  await page.locator('[data-testid="download-result-button"]').click();
  const stream = await (await pending).createReadStream();
  assert(stream, 'Saved GIF stream is unavailable');
  let bytes = 0;
  let header = Buffer.alloc(0);
  const hash = createHash('sha256');
  const parts: Buffer[] = [];
  for await (const chunk of stream) {
    const part = Buffer.from(chunk);
    bytes += part.length;
    assert(
      bytes <= MAX_VERIFIED_OUTPUT_BYTES,
      'Saved GIF exceeded the 96 MiB scenario verification bound'
    );
    hash.update(part);
    parts.push(part);
    if (header.length < 6) header = Buffer.concat([header, part.subarray(0, 6 - header.length)]);
  }
  assert(bytes > 13 && ['GIF87a', 'GIF89a'].includes(header.toString('ascii')));
  return { bytes, sha256: hash.digest('hex'), data: Buffer.concat(parts) };
}

function gifLoopCount(bytes: Buffer): number | null {
  assert(bytes.length >= 13, 'Saved GIF has no logical screen descriptor');
  const packed = bytes[10]!;
  let cursor = 13 + ((packed & 0x80) !== 0 ? 3 * 2 ** ((packed & 0x07) + 1) : 0);
  while (cursor < bytes.length) {
    const kind = bytes[cursor++];
    if (kind === 0x2c || kind === 0x3b) return null; // First image or trailer.
    assert.equal(kind, 0x21, 'Malformed GIF extension boundary');
    const label = bytes[cursor++];
    const blockSize = bytes[cursor]!;
    if (label === 0xff && blockSize === 11) {
      const identifier = bytes.toString('ascii', cursor + 1, cursor + 12);
      if (identifier === 'NETSCAPE2.0' || identifier === 'ANIMEXTS1.0') {
        assert.equal(bytes[cursor + 12], 3, 'Malformed GIF loop sub-block');
        assert.equal(bytes[cursor + 13], 1, 'Malformed GIF loop sub-block marker');
        assert.equal(bytes[cursor + 16], 0, 'Malformed GIF loop terminator');
        return bytes.readUInt16LE(cursor + 14);
      }
    }
    while (cursor < bytes.length) {
      const size = bytes[cursor++]!;
      if (size === 0) break;
      cursor += size;
    }
  }
  return null;
}

/** Independent browser decode, after the latency interval has ended. */
async function inspectGif(page: Page, data: Buffer, workload: MotionWorkload) {
  return page.evaluate(
    async ({ encoded, width, height }) => {
      if (typeof ImageDecoder !== 'function') throw new Error('ImageDecoder unavailable');
      const decoder = new ImageDecoder({
        data: Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
        type: 'image/gif',
        preferAnimation: true,
      });
      try {
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack;
        if (!track || track.frameCount < 1 || track.frameCount > 400)
          throw new Error('Unexpected GIF frame count');
        const frames: { durationUs: number; pixelSha256: string }[] = [];
        for (let index = 0; index < track.frameCount; index++) {
          const frame = await decoder.decode({ frameIndex: index, completeFramesOnly: true });
          const image = frame.image;
          try {
            if (!frame.complete || image.displayWidth !== width || image.displayHeight !== height)
              throw new Error(`GIF frame ${index} was incomplete or had wrong dimensions`);
            const pixels = new Uint8Array(width * height * 4);
            await image.copyTo(pixels, { format: 'RGBA' });
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', pixels));
            frames.push({
              durationUs: image.duration ?? 0,
              pixelSha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(
                ''
              ),
            });
          } finally {
            image.close();
          }
        }
        const durationUs = frames.reduce((total, frame) => total + frame.durationUs, 0);
        return {
          frameCount: track.frameCount,
          imageDecoderRepetitionCount: track.repetitionCount ?? null,
          durationUs,
          frames,
        };
      } finally {
        decoder.close();
      }
    },
    { encoded: data.toString('base64'), width: workload.width, height: workload.height }
  );
}

async function heapPoint(page: Page) {
  try {
    const session = await page.context().newCDPSession(page);
    try {
      const usage = await session.send('Runtime.getHeapUsage');
      return { usedSize: usage.usedSize, totalSize: usage.totalSize };
    } finally {
      await session.detach();
    }
  } catch (error) {
    return {
      unavailable:
        error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    };
  }
}

export async function measure(
  page: Page,
  workload: MotionWorkload,
  condition: 'cold-first-use' | 'fresh-context' | 'warm',
  index: number,
  wasmAsset: MotionWasmAsset | null = null
) {
  const rendererHeapBefore = await heapPoint(page);
  const before = await page.evaluate(() => {
    const observer = Reflect.get(globalThis, '__wmcMotionObserver') as MotionObserver;
    observer.reset();
    return { workerCount: observer.workers.length, timeOrigin: performance.timeOrigin };
  });
  const wallStart = new Date().toISOString();
  await page.locator('[data-testid="convert-button"]').click();
  const prompt = page.locator('[data-testid="modal-confirm-button"]');
  if (await prompt.isVisible()) await prompt.click();
  await page.waitForFunction(
    () => {
      const observer = Reflect.get(globalThis, '__wmcMotionObserver') as MotionObserver;
      return (
        observer.readyMs !== null &&
        document.querySelector('[data-testid="result-section"]')?.getClientRects().length
      );
    },
    undefined,
    { timeout: CONVERSION_TIMEOUT_MS }
  );
  assert.equal(await page.locator('[data-testid="error-display"]').isVisible(), false);
  const observation = await page.evaluate((workerCount) => {
    const observer = Reflect.get(globalThis, '__wmcMotionObserver') as MotionObserver;
    return {
      clickMs: observer.clickMs,
      outputUrls: [...observer.outputUrls],
      readyMs: observer.readyMs,
      workers: observer.workers.slice(workerCount),
      timeOrigin: performance.timeOrigin,
    };
  }, before.workerCount);
  assert.equal(observation.timeOrigin, before.timeOrigin, 'Document changed during conversion');
  assert(observation.clickMs !== null, 'Request click was not observed');
  assert(observation.readyMs !== null, 'Matching download button readiness was not observed');
  assert.equal(observation.workers.length, 1, 'A new conversion Worker was not created');
  const worker = observation.workers[0]!;
  assert.equal(worker.starts.length, 1, 'Worker did not receive exactly one start');
  assert.equal(worker.completes.length, 1, 'Worker did not complete exactly once');
  assert.deepEqual(worker.errors, [], 'Worker reported a failure');
  if (worker.retainedRoute) {
    assert.equal(
      worker.retainedRoute.requestId,
      worker.starts[0]?.requestId,
      'Retained-route progress belongs to a different request'
    );
  }
  assert.deepEqual(
    {
      format: worker.starts[0]?.options.format,
      quality: worker.starts[0]?.options.quality,
      scale: worker.starts[0]?.options.scale,
      smartFrameSkip: worker.starts[0]?.options.smartFrameSkip,
    },
    {
      format: 'gif',
      quality: workload.quality ?? 'low',
      scale: workload.scale ?? 1,
      smartFrameSkip: workload.smartFrameSkip,
    }
  );
  assert.equal(worker.terminationCalls, 1, 'Completed Worker was not terminated once');
  const href = await page.locator('[data-testid="download-result-button"]').getAttribute('href');
  assert(href?.startsWith('blob:'), 'GIF result has no Blob URL');
  const rendererHeapAfterReady = await heapPoint(page);
  const { data, ...saved } = await downloadIdentity(page);
  const loopCount = gifLoopCount(data);
  assert.equal(loopCount, 0, 'Saved GIF does not have the existing infinite-loop extension');
  const ready = observation.outputUrls.findLast((event) => event.size === saved.bytes);
  assert(ready, 'Saved GIF had no matching Blob publication event');
  assert.equal(
    worker.completes[0]?.outputBytes,
    saved.bytes,
    'Worker output size differs from saved file'
  );
  const decoded = await inspectGif(page, data, workload);
  const rendererHeapAfter = await heapPoint(page);
  const cacheObservation = await page.evaluate((workerUrl) => {
    const workerResourceTimings = performance
      .getEntriesByName(workerUrl, 'resource')
      .map((entry) => {
        const resource = entry as PerformanceResourceTiming;
        const deliveryType = Reflect.get(resource, 'deliveryType');
        return {
          transferSize: resource.transferSize,
          encodedBodySize: resource.encodedBodySize,
          decodedBodySize: resource.decodedBodySize,
          deliveryType: typeof deliveryType === 'string' ? deliveryType : null,
        };
      });
    const controller = navigator.serviceWorker?.controller;
    return {
      workerResourceTimings,
      serviceWorkerController: controller ? new URL(controller.scriptURL).pathname : null,
    };
  }, worker.url);
  const wasmAssetCache = await readWasmCache(
    page,
    wasmAsset,
    condition === 'warm' ? 'after-warm' : 'after-first-before-warm'
  );
  assert(
    ready.atMs <= observation.readyMs,
    'Button was ready before its matching Blob URL existed'
  );
  const elapsedMs = observation.readyMs - observation.clickMs;
  assert(elapsedMs > 0, 'Invalid request-to-download-ready interval');
  return {
    workload: workload.id,
    condition,
    index,
    wallStart,
    timeOrigin: observation.timeOrigin,
    inputSha256: workload.inputSha256,
    settings: {
      format: 'gif',
      quality: workload.quality ?? 'low',
      scale: workload.scale ?? 1,
      smartFrameSkip: workload.smartFrameSkip,
    },
    outputRoute: 'gif-worker',
    routeBasis: 'owned-built-worker-start-format-gif-and-complete-matched-saved-bytes',
    requestToDownloadReadyMs: elapsedMs,
    requestToBlobPublicationMs: ready.atMs - observation.clickMs,
    worker: {
      url: worker.url,
      starts: worker.starts,
      completes: worker.completes,
      retainedRoute: worker.retainedRoute,
      terminationCalls: worker.terminationCalls,
    },
    cacheObservation: { ...cacheObservation, wasmAssetCache },
    memory: {
      rendererHeapBefore,
      rendererHeapAfterReady,
      rendererHeapAfterVerification: rendererHeapAfter,
      workerHeap: null,
      nativeGpuMemory: null,
      scope:
        'Renderer Runtime.getHeapUsage point samples; after-verification includes harness GIF decoding and cannot establish product retention or peak/native memory',
    },
    saved: { ...saved, loopCount },
    decoded,
  };
}

/** Functional recovery check for an intentionally unavailable conversion Worker. */
export async function measureFallback(page: Page, workload: MotionWorkload) {
  const before = await page.evaluate(() => {
    const observer = Reflect.get(globalThis, '__wmcMotionObserver') as MotionObserver;
    if (observer.gifPublicationCount !== 0)
      throw new Error('Cancelled conversion published before recovery');
    observer.reset();
    return {
      workerCount: observer.workers.length,
      rejectionCount: observer.workerConstructionFailures.length,
      timeOrigin: performance.timeOrigin,
    };
  });
  await page.locator('[data-testid="convert-button"]').click();
  const prompt = page.locator('[data-testid="modal-confirm-button"]');
  if (await prompt.isVisible()) await prompt.click();
  await page.waitForFunction(
    () => {
      const observer = Reflect.get(globalThis, '__wmcMotionObserver') as MotionObserver;
      return (
        observer.readyMs !== null &&
        document.querySelector('[data-testid="result-section"]')?.getClientRects().length
      );
    },
    undefined,
    { timeout: CONVERSION_TIMEOUT_MS }
  );
  assert.equal(await page.locator('[data-testid="error-display"]').isVisible(), false);
  const observation = await page.evaluate(({ workerCount, rejectionCount }) => {
    const observer = Reflect.get(globalThis, '__wmcMotionObserver') as MotionObserver;
    return {
      clickMs: observer.clickMs,
      readyMs: observer.readyMs,
      outputUrls: [...observer.outputUrls],
      gifPublicationCount: observer.gifPublicationCount,
      lastGifPublication: observer.lastGifPublication,
      workers: observer.workers.slice(workerCount),
      rejections: observer.workerConstructionFailures.slice(rejectionCount),
      timeOrigin: performance.timeOrigin,
    };
  }, before);
  assert.equal(observation.timeOrigin, before.timeOrigin, 'Document changed during recovery');
  assert.equal(observation.workers.length, 0, 'Fallback unexpectedly created a conversion Worker');
  assert.equal(observation.rejections.length, 1, 'Fallback did not reject one conversion Worker');
  assert.equal(observation.rejections[0]?.name, 'NotSupportedError');
  assert(observation.clickMs !== null && observation.readyMs !== null);
  assert(observation.readyMs > observation.clickMs, 'Invalid recovery readiness interval');
  const href = await page.locator('[data-testid="download-result-button"]').getAttribute('href');
  assert(href?.startsWith('blob:'), 'Recovery GIF has no Blob URL');
  const { data, ...saved } = await downloadIdentity(page);
  const loopCount = gifLoopCount(data);
  assert.equal(loopCount, 0, 'Recovery GIF is missing infinite-loop extension');
  assert.equal(observation.outputUrls.length, 1, 'Unexpected GIF publication during recovery');
  assert.equal(observation.outputUrls[0]?.url, href, 'Saved GIF differs from published Blob');
  assert.equal(observation.outputUrls[0]?.size, saved.bytes);
  assert.equal(observation.gifPublicationCount, 1, 'Stale GIF publication survived cancellation');
  assert.deepEqual(observation.lastGifPublication, { url: href, size: saved.bytes });
  const decoded = await inspectGif(page, data, workload);
  return {
    outputRoute: 'gif-main-thread-fallback' as const,
    routeBasis: 'conversion-worker-constructor-rejected-and-no-worker-created',
    timeOrigin: observation.timeOrigin,
    workerConstructionFailures: observation.rejections,
    requestToDownloadReadyMs: observation.readyMs - observation.clickMs,
    saved: { ...saved, loopCount },
    decoded,
  };
}

export type MotionOutputSample = {
  workload: MotionWorkload['id'];
  decoded: {
    durationUs: number;
    frames: readonly { durationUs: number; pixelSha256: string }[];
  };
};

export function assertUsefulOutput(sample: MotionOutputSample, workload: MotionWorkload) {
  const primary = sample.workload !== 'small-enabled';
  const expectedDurationUs = workload.expectedDurationUs ?? (primary ? 3_000_000 : 1_000_000);
  assert(
    Math.abs(sample.decoded.durationUs - expectedDurationUs) <=
      (workload.durationToleranceUs ?? 250_000),
    'Saved GIF duration missed the frozen source-duration tolerance'
  );
  if (workload.oracleKind === 'owner-video') {
    const frames = sample.decoded.frames;
    assert(
      frames.length >= (workload.minimumFrameCount ?? 2),
      'Owner-video output had too few composited frames'
    );
    assert(
      frames.every((frame) => frame.durationUs > 0),
      'Owner-video output contained a nonpositive frame duration'
    );
    assert(
      new Set(frames.map((frame) => frame.pixelSha256)).size >=
        (workload.minimumDistinctFrames ?? 2),
      'Owner-video output did not preserve visible motion'
    );
    return;
  }
  if (!primary) return;
  const frames = sample.decoded.frames;
  assert(frames.length >= 16, 'Primary high-motion output had fewer than 16 frames');
  assert(
    frames.every((frame) => frame.durationUs > 0),
    'Primary high-motion output contained a nonpositive frame duration'
  );
  assert(
    new Set(frames.map((frame) => frame.pixelSha256)).size >= 2,
    'Primary high-motion output did not retain two distinct composited frames'
  );
  assert(
    frames.slice(1).filter((frame, index) => frame.pixelSha256 !== frames[index]!.pixelSha256)
      .length >= 15,
    'Primary high-motion output had fewer than 15 adjacent pixel changes'
  );
}

export async function exerciseMotionSignature(
  browser: Browser,
  url: string,
  workloads: readonly MotionWorkload[],
  onSample: (sample: Awaited<ReturnType<typeof measure>>) => Promise<void>,
  output: string,
  diagnostics: MotionDiagnostic[],
  mode: 'three-pair-cohort' | 'single-pair' | 'single-correctness' = 'three-pair-cohort',
  wasmAsset: MotionWasmAsset | null = null
) {
  assert.equal(workloads.length, mode === 'three-pair-cohort' ? 3 : 1);
  const samples: Awaited<ReturnType<typeof measure>>[] = [];
  const primary = workloads[0]!;
  const orderedWorkloads =
    mode === 'three-pair-cohort' ? [primary, workloads[1]!, workloads[2]!] : [primary];
  const artifacts: { file: string; bytes: number; sha256: string }[] = [];
  const contexts = new Set<BrowserContext>();
  const closedContexts: string[] = [];
  let measurementOverhead: ReturnType<NonNullable<MotionObserver['calibrate']>> | undefined;
  let primaryFailure: unknown;
  let failed = false;
  try {
    for (const workload of orderedWorkloads) {
      const context = await browser.newContext({ acceptDownloads: true, locale: 'en-US' });
      contexts.add(context);
      const page = await context.newPage();
      const diagnostic: MotionDiagnostic = {
        workload: workload.id,
        pageErrors: [],
        consoleErrors: [],
        expectedBlobAborts: [],
        failedRequests: [],
        failedResponses: [],
        overflow: 0,
      };
      diagnostics.push(diagnostic);
      page.on('pageerror', (error) =>
        recordBounded(diagnostic.pageErrors, error.message.slice(0, 400), diagnostic)
      );
      page.on('console', (message) => {
        if (message.type() === 'error')
          recordBounded(diagnostic.consoleErrors, message.text().slice(0, 400), diagnostic);
      });
      page.on('requestfailed', (request) => {
        let path = 'unparseable';
        let protocol = 'unknown';
        try {
          const url = new URL(request.url());
          path = url.pathname.slice(0, 160);
          protocol = url.protocol;
        } catch {
          // Preserve the failure without copying an unparsed URL or query string.
        }
        const error = (request.failure()?.errorText ?? 'unknown').slice(0, 200);
        const resourceType = request.resourceType();
        if (protocol === 'blob:' && error === 'net::ERR_ABORTED') {
          recordBounded(
            diagnostic.expectedBlobAborts,
            { protocol, resourceType, path },
            diagnostic,
            256
          );
          return;
        }
        recordBounded(
          diagnostic.failedRequests,
          { protocol, resourceType, path, error },
          diagnostic
        );
      });
      page.on('response', (response) => {
        if (response.status() < 400) return;
        let path = 'unparseable';
        let protocol = 'unknown';
        try {
          const url = new URL(response.url());
          path = url.pathname.slice(0, 160);
          protocol = url.protocol;
        } catch {
          // Preserve the status without copying an unparsed URL or query string.
        }
        recordBounded(
          diagnostic.failedResponses,
          { protocol, path, status: response.status() },
          diagnostic
        );
      });
      await page.addInitScript(installMotionObserver);
      const response = await page.goto(url);
      assert(response?.ok(), 'Production app failed to load');
      assert(await page.evaluate(() => crossOriginIsolated), 'Production page is not isolated');
      await page.locator('[data-testid="file-input"]').setInputFiles(workload.fixture);
      await page.locator('[data-testid="convert-button"]').waitFor({ state: 'visible' });
      await choose(page, 'format', 'gif');
      await choose(page, 'quality', workload.quality ?? 'low');
      await choose(page, 'scale', String(workload.scale ?? 1));
      await choose(page, 'smart-frame-skip', workload.smartFrameSkip);
      const condition =
        mode !== 'three-pair-cohort' || workload.id === 'primary-enabled'
          ? 'cold-first-use'
          : 'fresh-context';
      const sample = await measure(page, workload, condition, 0, wasmAsset);
      samples.push(sample);
      await onSample(sample);
      assertUsefulOutput(sample, workload);
      assertNoUnexpectedDiagnostics(diagnostic);
      if (mode !== 'single-correctness') {
        const warm = await measure(page, workload, 'warm', 0, wasmAsset);
        samples.push(warm);
        await onSample(warm);
        assertUsefulOutput(warm, workload);
        assertNoUnexpectedDiagnostics(diagnostic);
      }
      if (mode !== 'three-pair-cohort' || workload.id === 'primary-enabled') {
        const file = 'motion-signature-result.png';
        const bytes = await page.screenshot({ path: join(output, file), fullPage: true });
        artifacts.push({
          file,
          bytes: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
        measurementOverhead = await page.evaluate(() => {
          const observer = Reflect.get(globalThis, '__wmcMotionObserver') as MotionObserver;
          if (!observer.calibrate) throw new Error('Observer calibration unavailable');
          return observer.calibrate();
        });
      }
      assert.equal(await page.evaluate(() => performance.timeOrigin), sample.timeOrigin);
      await context.close();
      contexts.delete(context);
      closedContexts.push(workload.id);
    }
    assert(measurementOverhead, 'Primary measurement calibration was not recorded');
    return {
      measurementOverhead,
      ownedContextCleanup: { closedWorkloads: closedContexts, remaining: contexts.size },
      scenario: MOTION_SIGNATURE_SCENARIO,
      status: 'passed' as const,
      browserVersion: browser.version(),
      samplingPlan:
        mode === 'single-correctness'
          ? 'One default-settings correctness and loading conversion; no timing cohort claim.'
          : mode === 'single-pair'
            ? 'One workload in a fresh browser process/profile: first use then same-document warm with a new Worker; five balanced invocations per variant and workload.'
            : 'For each workload: first use, same-document warm with a new conversion Worker, then context cleanup. Primary pair precedes controls. Run five fresh controller invocations per variant.',
      artifacts,
      diagnostics,
      samples,
    };
  } catch (error) {
    primaryFailure = error;
    failed = true;
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([...contexts].map((context) => context.close()));
    const cleanupErrors = cleanup.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : []
    );
    if (cleanupErrors.length)
      throw new AggregateError(
        [...(failed ? [primaryFailure] : []), ...cleanupErrors],
        'Motion signature validation or context cleanup failed'
      );
  }
}
