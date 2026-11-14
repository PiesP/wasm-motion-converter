// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';

import type { Browser } from '@playwright/test';

type BuildFile = { path: string; bytes: number; sha256: string; base64: string };
type BenchmarkBuild = { schema: 1; sourceSha: string; inventory: BuildFile[] };

export type DemuxMeasurementInput = {
  id: string;
  path: string;
  size: number;
  sha256: string;
  trimStart: number;
};

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const BUNDLE_PATH = 'dist-validation/owned-demux-measurement.json';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Timings are from actual service imports and compiled WASM in an installed browser. */
export async function exerciseOwnedDemuxServiceMeasurement({
  browser,
  bundleRoot,
  output,
  build,
  validateBundleFile,
  inputs,
  expectedEngine,
}: {
  browser: Browser;
  bundleRoot: string;
  output: string;
  build: unknown;
  validateBundleFile: (root: string, path: string) => Promise<string>;
  inputs: readonly DemuxMeasurementInput[];
  expectedEngine: 'mediabunny' | 'owned-rust-wasm';
}) {
  assert(inputs.length > 0 && inputs.length <= 2, 'Demux measurement workload count exceeded');
  assert(build && typeof build === 'object' && 'state' in build);
  const sourceBuild = build as { state: { sourceSha: string } };
  await mkdir(output, { recursive: true });
  const manifestPath = await validateBundleFile(bundleRoot, BUNDLE_PATH);
  const manifestBytes = await readFile(manifestPath);
  assert(manifestBytes.byteLength > 0 && manifestBytes.byteLength <= 4 * 1024 * 1024);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as BenchmarkBuild;
  assert.equal(manifest.schema, 1);
  assert.match(manifest.sourceSha, /^[0-9a-f]{40}$/);
  assert.equal(manifest.sourceSha, sourceBuild.state.sourceSha);
  assert(Array.isArray(manifest.inventory) && manifest.inventory.length > 0);
  assert(manifest.inventory.length <= 16, 'Demux measurement bundle file count exceeded');
  const files = new Map<string, Buffer>();
  for (const file of manifest.inventory) {
    assert.match(file.path, /^(?:entry\.js|assets\/[\w.-]+\.(?:js|wasm))$/);
    assert(file.bytes > 0 && file.bytes <= MAX_BUNDLE_BYTES);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.match(file.base64, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
    assert(!files.has(file.path), 'Duplicate measurement bundle asset');
    const bytes = Buffer.from(file.base64, 'base64');
    assert.equal(bytes.length, file.bytes);
    assert.equal(sha256(bytes), file.sha256);
    files.set(file.path, bytes);
  }
  assert(files.has('entry.js'), 'Measurement bundle entry is missing');
  assert.equal(
    [...files.keys()].filter((path) => path.endsWith('.wasm')).length,
    expectedEngine === 'owned-rust-wasm' ? 1 : 0,
    'Demux measurement bundle did not match the declared implementation'
  );

  const requests: string[] = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (requests.length < 128) requests.push(pathname);
    const file = pathname.slice(1);
    const body =
      pathname === '/'
        ? Buffer.from('<!doctype html><title>Demux measurement</title>')
        : files.get(file);
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'"
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (
      !body ||
      (pathname !== '/' && !/^(?:\/entry\.js|\/assets\/[\w.-]+\.(?:js|wasm))$/.test(pathname))
    ) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end();
      return;
    }
    response.setHeader(
      'Content-Type',
      pathname === '/'
        ? 'text/html; charset=utf-8'
        : extname(file) === '.wasm'
          ? 'application/wasm'
          : 'text/javascript; charset=utf-8'
    );
    response.writeHead(200, { 'Content-Length': body.byteLength });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
  let failure: unknown;
  const report: Record<string, unknown> = {
    schema: 1,
    kind: 'service-level-metadata-seek',
    status: 'running',
    browserVersion: browser.version(),
    productionBuild: build,
    measurementBuild: {
      schema: manifest.schema,
      sourceSha: manifest.sourceSha,
      inventory: manifest.inventory.map((file) => ({
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
      })),
      manifestSha256: sha256(manifestBytes),
    },
    metricLimits: {
      firstMetadata: 'dynamic entry import, selection, metadata read/index export and disposal',
      warmMetadata: 'same document and Blob, compiled/module cache, repeated metadata extraction',
      seek: 'snapshot copy, Blob structuredClone, index import or parse, verified key seek, first chunk and disposal',
      excluded:
        'The four latency metrics exclude input staging, payload hash, diagnostic parser pass, full drain and full Worker startup',
      reads:
        'Blob.slice view extents, completed Blob.arrayBuffer bytes, native stream reader chunks and cumulative completed read wait; phase-attributed call and completion counts',
      wasmCapacity: 'separate untimed diagnostic session, not the timed instance',
      fullDrain:
        'separate trim-zero product stream after the four latency samples; setup and stream wall time exclude packet hashing',
    },
    requests,
    expectedEngine,
    samples: [] as unknown[],
  };
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        done();
      });
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    context = await browser.newContext({ locale: 'en-US' });
    for (const input of inputs) {
      assert.match(input.id, /^[\w.-]{1,60}$/);
      assert(Number.isSafeInteger(input.size) && input.size > 0 && input.size <= MAX_INPUT_BYTES);
      assert.match(input.sha256, /^[0-9a-f]{64}$/);
      assert(Number.isFinite(input.trimStart) && input.trimStart > 0);
      const path = await validateBundleFile(bundleRoot, input.path);
      const bytes = await readFile(path);
      assert.equal(bytes.byteLength, input.size);
      assert.equal(sha256(bytes), input.sha256);
      const page = await context.newPage();
      let pageFailure: unknown;
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(errorText(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text().slice(0, 200));
      });
      try {
        await page.goto(origin, { waitUntil: 'load' });
        const sample = await page.evaluate(
          async ({ base64, entry, trimStart }) => {
            const sourceBytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
            const source = new Blob([sourceBytes]);
            const tracked = new WeakSet<Blob>([source]);
            type Phase =
              | 'firstMetadata'
              | 'firstSeek'
              | 'warmMetadata'
              | 'warmSeek'
              | 'fullDrainDiagnostic'
              | 'diagnostic'
              | 'unattributed';
            const makeReads = () => ({
              sliceCalls: 0,
              viewSliceBytes: 0,
              arrayBufferCalls: 0,
              arrayBufferCompletedBytes: 0,
              arrayBufferCompletedWaitMs: 0,
              arrayBufferErrors: 0,
              streamCalls: 0,
              defaultReaderCalls: 0,
              byobReaderCalls: 0,
              unobservedReaderCalls: 0,
              streamReadCalls: 0,
              streamCompletedBytes: 0,
              streamCompletedWaitMs: 0,
              streamDoneReads: 0,
              streamReadErrors: 0,
              streamNonUint8Values: 0,
              streamLateCompletions: 0,
              streamLateCompletedBytes: 0,
              streamLateErrors: 0,
              arrayBufferLateCompletions: 0,
              arrayBufferLateCompletedBytes: 0,
              arrayBufferLateErrors: 0,
            });
            const readsByPhase: Record<Phase, ReturnType<typeof makeReads>> = {
              firstMetadata: makeReads(),
              firstSeek: makeReads(),
              warmMetadata: makeReads(),
              warmSeek: makeReads(),
              fullDrainDiagnostic: makeReads(),
              diagnostic: makeReads(),
              unattributed: makeReads(),
            };
            let phase: Phase = 'unattributed';
            const closedPhases = new Set<Phase>();
            const pendingReads = new Set<Promise<void>>();
            const restorers: Array<() => void> = [];
            const nativeSlice = Blob.prototype.slice;
            const nativeArrayBuffer = Blob.prototype.arrayBuffer;
            const nativeStream = Blob.prototype.stream;
            const nativeClone = globalThis.structuredClone;
            globalThis.structuredClone = ((
              value: unknown,
              options?: StructuredSerializeOptions
            ) => {
              const result: unknown = nativeClone(value, options);
              if (
                value &&
                typeof value === 'object' &&
                'source' in value &&
                value.source === source &&
                result &&
                typeof result === 'object' &&
                'source' in result &&
                result.source instanceof Blob
              )
                tracked.add(result.source);
              return result;
            }) as typeof structuredClone;
            Blob.prototype.slice = function (start?: number, end?: number, type?: string) {
              const result = nativeSlice.call(this, start, end, type);
              if (tracked.has(this)) {
                tracked.add(result);
                readsByPhase[phase].sliceCalls++;
                // A slice is a view; its length is not an observed I/O amount.
                readsByPhase[phase].viewSliceBytes += result.size;
              }
              return result;
            };
            Blob.prototype.arrayBuffer = function () {
              const readStartMs = performance.now();
              const result = nativeArrayBuffer.call(this);
              if (tracked.has(this)) {
                const callPhase = phase;
                const counts = readsByPhase[callPhase];
                counts.arrayBufferCalls++;
                const settled = result.then(
                  (bytes) => {
                    counts.arrayBufferCompletedBytes += bytes.byteLength;
                    counts.arrayBufferCompletedWaitMs += performance.now() - readStartMs;
                    if (closedPhases.has(callPhase)) {
                      counts.arrayBufferLateCompletions++;
                      counts.arrayBufferLateCompletedBytes += bytes.byteLength;
                    }
                  },
                  () => {
                    counts.arrayBufferErrors++;
                    if (closedPhases.has(callPhase)) counts.arrayBufferLateErrors++;
                  }
                );
                pendingReads.add(settled);
                void settled.then(() => {
                  pendingReads.delete(settled);
                });
              }
              return result;
            };
            Blob.prototype.stream = function () {
              const stream = nativeStream.call(this);
              if (!tracked.has(this)) return stream;
              const streamPhase = phase;
              readsByPhase[streamPhase].streamCalls++;
              if (!(stream instanceof ReadableStream)) {
                readsByPhase[streamPhase].unobservedReaderCalls++;
                return stream;
              }
              const nativeGetReader = stream.getReader;
              const previousGetReader = Object.getOwnPropertyDescriptor(stream, 'getReader');
              try {
                Object.defineProperty(stream, 'getReader', {
                  configurable: true,
                  writable: true,
                  value: function (this: ReadableStream<Uint8Array>, ...args: unknown[]) {
                    const reader = (
                      nativeGetReader as (...values: unknown[]) => ReadableStreamReader<Uint8Array>
                    ).apply(this, args);
                    const callPhase = phase;
                    if (!(reader instanceof ReadableStreamDefaultReader)) {
                      readsByPhase[callPhase].byobReaderCalls++;
                      return reader;
                    }
                    readsByPhase[callPhase].defaultReaderCalls++;
                    const nativeRead = reader.read;
                    const previousRead = Object.getOwnPropertyDescriptor(reader, 'read');
                    try {
                      Object.defineProperty(reader, 'read', {
                        configurable: true,
                        writable: true,
                        value: function (this: ReadableStreamDefaultReader<Uint8Array>) {
                          const readPhase = phase;
                          const counts = readsByPhase[readPhase];
                          counts.streamReadCalls++;
                          const readStartMs = performance.now();
                          let result: ReturnType<typeof nativeRead>;
                          try {
                            result = nativeRead.call(this);
                          } catch (error) {
                            counts.streamReadErrors++;
                            throw error;
                          }
                          // Observe settlement without replacing the native read promise.
                          const settled = result.then(
                            ({ done, value }) => {
                              counts.streamCompletedWaitMs += performance.now() - readStartMs;
                              if (done) counts.streamDoneReads++;
                              else if (value instanceof Uint8Array) {
                                counts.streamCompletedBytes += value.byteLength;
                                if (closedPhases.has(readPhase))
                                  counts.streamLateCompletedBytes += value.byteLength;
                              } else counts.streamNonUint8Values++;
                              if (closedPhases.has(readPhase)) counts.streamLateCompletions++;
                            },
                            () => {
                              counts.streamReadErrors++;
                              if (closedPhases.has(readPhase)) counts.streamLateErrors++;
                            }
                          );
                          pendingReads.add(settled);
                          void settled.then(() => {
                            pendingReads.delete(settled);
                          });
                          return result;
                        },
                      });
                      restorers.push(() => {
                        if (previousRead) Object.defineProperty(reader, 'read', previousRead);
                        else Reflect.deleteProperty(reader, 'read');
                      });
                    } catch {
                      readsByPhase[callPhase].unobservedReaderCalls++;
                    }
                    return reader;
                  },
                });
                restorers.push(() => {
                  if (previousGetReader)
                    Object.defineProperty(stream, 'getReader', previousGetReader);
                  else Reflect.deleteProperty(stream, 'getReader');
                });
              } catch {
                readsByPhase[streamPhase].unobservedReaderCalls++;
              }
              return stream;
            };
            const timedPhase = async <T>(name: Phase, work: () => Promise<T>) => {
              phase = name;
              const start = performance.now();
              try {
                const value = await work();
                return { value, ms: performance.now() - start };
              } finally {
                closedPhases.add(name);
                phase = 'unattributed';
              }
            };
            const settleReads = async () => {
              const start = performance.now();
              const deadline = start + 2000;
              while (pendingReads.size && performance.now() < deadline) {
                const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
                await new Promise<void>((resolve) => {
                  const timer = setTimeout(resolve, remaining);
                  void Promise.allSettled([...pendingReads]).then(() => {
                    clearTimeout(timer);
                    resolve();
                  });
                });
              }
              return {
                deadlineMs: 2000,
                awaitedMs: performance.now() - start,
                remainingReads: pendingReads.size,
                remainingReadBytesUnverified: pendingReads.size > 0,
              };
            };
            const hex = (bytes: Uint8Array) =>
              Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
            const digest = async (bytes: Uint8Array) =>
              hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)));
            type Metadata = {
              config?: VideoDecoderConfig;
              duration: number;
              framerate: number;
              bitrate: number;
              rotation?: number;
              width: number;
              height: number;
            };
            type SeekResult = {
              chunk: EncodedVideoChunk;
              indexRoute: string;
              indexSnapshotBytes: number;
              hostTransferMs: number;
            };
            type FullDrainResult = {
              chunks: EncodedVideoChunk[];
              setupMs: number;
              streamWallMs: number;
              packetCount: number;
              compressedBytes: number;
              retainedByteLimit: number;
              chunkAllowanceBytes: number;
              indexRoute: string;
              indexSnapshotBytes: number;
              hostTransferMs: number;
              reportedTotalFrames: number;
              sourceTotalMs: number;
            };
            type Entry = {
              engine: string;
              select: (input: Blob) => void;
              metadata: (input: Blob) => Promise<Metadata>;
              seek: (input: Blob, metadata: Metadata, trim: number) => Promise<SeekResult>;
              diagnosticFullDrain: (input: Blob, metadata: Metadata) => Promise<FullDrainResult>;
              clearSelection: () => void;
              diagnosticOwnedCapacity: (input: Blob) => Promise<Record<string, number> | null>;
            };
            const summarize = async (value: Metadata) => {
              const description = value.config?.description;
              let descriptionBytes: Uint8Array | null = null;
              if (description instanceof ArrayBuffer) {
                descriptionBytes = new Uint8Array(description);
              } else if (ArrayBuffer.isView(description)) {
                descriptionBytes = new Uint8Array(
                  description.buffer,
                  description.byteOffset,
                  description.byteLength
                );
              } else if (
                typeof SharedArrayBuffer !== 'undefined' &&
                description instanceof SharedArrayBuffer
              ) {
                descriptionBytes = new Uint8Array(description);
              } else if (description) {
                throw new Error('Unexpected decoder description buffer type');
              }
              return {
                width: value.width,
                height: value.height,
                duration: value.duration,
                framerate: value.framerate,
                bitrate: value.bitrate,
                rotation: value.rotation ?? 0,
                codec: value.config?.codec ?? '',
                descriptionBytes: descriptionBytes?.byteLength ?? 0,
                descriptionSha256: descriptionBytes ? await digest(descriptionBytes) : null,
              };
            };
            const packet = async (result: SeekResult) => {
              const bytes = new Uint8Array(result.chunk.byteLength);
              result.chunk.copyTo(bytes);
              return {
                type: result.chunk.type,
                timestampUs: result.chunk.timestamp,
                durationUs: result.chunk.duration,
                bytes: result.chunk.byteLength,
                sha256: await digest(bytes),
                indexRoute: result.indexRoute,
                indexSnapshotBytes: result.indexSnapshotBytes,
                hostTransferMs: result.hostTransferMs,
              };
            };
            let api: Entry | undefined;
            let readsSettled = false;
            try {
              const firstMetadataTimed = await timedPhase('firstMetadata', async () => {
                api = (await import(entry)) as Entry;
                api.select(source);
                return api.metadata(source);
              });
              if (!api) throw new Error('Demux measurement entry did not initialize');
              const readyApi = api;
              const firstMetadata = firstMetadataTimed.value;
              const firstMetadataValue = await summarize(firstMetadata);

              const firstSeekTimed = await timedPhase('firstSeek', () =>
                readyApi.seek(source, firstMetadata, trimStart)
              );
              const firstSeek = firstSeekTimed.value;
              const firstPacket = await packet(firstSeek);

              const warmMetadataTimed = await timedPhase('warmMetadata', () =>
                readyApi.metadata(source)
              );
              const warmMetadata = warmMetadataTimed.value;
              const warmMetadataValue = await summarize(warmMetadata);

              const warmSeekTimed = await timedPhase('warmSeek', () =>
                readyApi.seek(source, warmMetadata, trimStart)
              );
              const warmSeek = warmSeekTimed.value;
              const warmPacket = await packet(warmSeek);

              const fullDrainTimed = await timedPhase('fullDrainDiagnostic', () =>
                readyApi.diagnosticFullDrain(source, warmMetadata)
              );
              const fullDrain = fullDrainTimed.value;
              const trace: Array<{
                type: EncodedVideoChunk['type'];
                timestampUs: number;
                durationUs: number | null;
                bytes: number;
                sha256: string;
              }> = [];
              try {
                // Copy and hash only after the complete product stream has been timed.
                for (const chunk of fullDrain.chunks) {
                  const bytes = new Uint8Array(chunk.byteLength);
                  chunk.copyTo(bytes);
                  trace.push({
                    type: chunk.type,
                    timestampUs: chunk.timestamp,
                    durationUs: chunk.duration,
                    bytes: chunk.byteLength,
                    sha256: await digest(bytes),
                  });
                }
              } finally {
                fullDrain.chunks.length = 0;
              }

              const ownedDiagnostic = (
                await timedPhase('diagnostic', () => readyApi.diagnosticOwnedCapacity(source))
              ).value;
              // Reader settlement is outside all measured latency intervals.
              const readSettlement = await settleReads();
              readsSettled = true;
              return {
                engine: readyApi.engine,
                timeOrigin: performance.timeOrigin,
                firstMetadata: {
                  ms: firstMetadataTimed.ms,
                  reads: { ...readsByPhase.firstMetadata },
                  value: firstMetadataValue,
                },
                warmMetadata: {
                  ms: warmMetadataTimed.ms,
                  reads: { ...readsByPhase.warmMetadata },
                  value: warmMetadataValue,
                },
                firstSeek: {
                  ms: firstSeekTimed.ms,
                  reads: { ...readsByPhase.firstSeek },
                  firstPacket,
                },
                warmSeek: {
                  ms: warmSeekTimed.ms,
                  reads: { ...readsByPhase.warmSeek },
                  firstPacket: warmPacket,
                },
                fullDrainDiagnostic: {
                  ms: fullDrainTimed.ms,
                  setupMs: fullDrain.setupMs,
                  streamWallMs: fullDrain.streamWallMs,
                  packetCount: fullDrain.packetCount,
                  compressedBytes: fullDrain.compressedBytes,
                  retainedByteLimit: fullDrain.retainedByteLimit,
                  chunkAllowanceBytes: fullDrain.chunkAllowanceBytes,
                  indexRoute: fullDrain.indexRoute,
                  indexSnapshotBytes: fullDrain.indexSnapshotBytes,
                  hostTransferMs: fullDrain.hostTransferMs,
                  reportedTotalFrames: fullDrain.reportedTotalFrames,
                  sourceTotalMs: fullDrain.sourceTotalMs,
                  reads: { ...readsByPhase.fullDrainDiagnostic },
                  trace,
                },
                diagnostic: { ownedDiagnostic, reads: { ...readsByPhase.diagnostic } },
                unattributedReads: { ...readsByPhase.unattributed },
                readSettlement,
              };
            } finally {
              try {
                api?.clearSelection();
              } finally {
                try {
                  try {
                    if (!readsSettled) await settleReads();
                  } finally {
                    for (let index = restorers.length - 1; index >= 0; index--) restorers[index]!();
                  }
                } finally {
                  Blob.prototype.slice = nativeSlice;
                  Blob.prototype.arrayBuffer = nativeArrayBuffer;
                  Blob.prototype.stream = nativeStream;
                  globalThis.structuredClone = nativeClone;
                }
              }
            }
          },
          {
            base64: bytes.toString('base64'),
            entry: `${origin}/entry.js`,
            trimStart: input.trimStart,
          }
        );
        assert.deepEqual(sample.firstMetadata.value, sample.warmMetadata.value);
        assert.equal(sample.engine, expectedEngine);
        assert.deepEqual(sample.firstSeek.firstPacket.sha256, sample.warmSeek.firstPacket.sha256);
        assert.deepEqual(
          sample.firstSeek.firstPacket.timestampUs,
          sample.warmSeek.firstPacket.timestampUs
        );
        assert.deepEqual(sample.firstSeek.firstPacket.type, sample.warmSeek.firstPacket.type);
        assert(sample.firstMetadata.ms > 0 && sample.warmMetadata.ms > 0);
        assert(sample.firstSeek.ms > 0 && sample.warmSeek.ms > 0);
        assert(sample.fullDrainDiagnostic.ms > 0 && sample.fullDrainDiagnostic.streamWallMs > 0);
        assert.equal(
          sample.fullDrainDiagnostic.trace.length,
          sample.fullDrainDiagnostic.packetCount
        );
        assert.equal(
          sample.fullDrainDiagnostic.trace.reduce((sum, packet) => sum + packet.bytes, 0),
          sample.fullDrainDiagnostic.compressedBytes
        );
        assert.equal(
          sample.fullDrainDiagnostic.reportedTotalFrames,
          sample.fullDrainDiagnostic.packetCount
        );
        assert.deepEqual(errors, [], `${input.id}: browser errors`);
        (report.samples as unknown[]).push({
          id: input.id,
          source: { bytes: input.size, sha256: input.sha256 },
          trimStart: input.trimStart,
          ...sample,
        });
      } catch (error) {
        pageFailure = error;
        throw error;
      } finally {
        try {
          await page.close();
        } catch (error) {
          if (pageFailure)
            throw new AggregateError([pageFailure, error], 'Demux sample and page cleanup failed');
          throw error;
        }
      }
    }
    report.status = 'passed';
    return { profile: 'owned-demux-service-measurement', status: 'passed', samples: inputs.length };
  } catch (error) {
    failure = error;
    report.status = 'failed';
    report.error = errorText(error);
    if (error instanceof AggregateError) report.errorDetails = error.errors.map(errorText);
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      await context?.close();
    } catch (error) {
      report.status = 'failed';
      report.cleanupError = errorText(error);
      cleanupError = error;
    }
    await new Promise<void>((done) => server.close(() => done()));
    await writeFile(
      join(output, 'owned-demux-service-measurement.json'),
      `${JSON.stringify(report, null, 2)}\n`
    );
    if (cleanupError) {
      if (failure)
        throw new AggregateError([failure, cleanupError], 'Demux measurement and cleanup failed');
      throw cleanupError;
    }
  }
}
