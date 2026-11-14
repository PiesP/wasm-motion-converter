// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, relative, sep } from 'node:path';

import type { Browser } from '@playwright/test';

type BuildFile = { path: string; bytes: number; sha256: string };
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
const BUNDLE_PATH = 'temp/owned-demux-measurement';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`));
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
  const bundlePath = await validateBundleFile(bundleRoot, BUNDLE_PATH);
  assert((await stat(bundlePath)).isDirectory(), 'Demux measurement bundle is not a directory');
  const manifestPath = await validateBundleFile(bundleRoot, `${BUNDLE_PATH}/build-info.json`);
  const manifestBytes = await readFile(manifestPath);
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
    assert(!files.has(file.path), 'Duplicate measurement bundle asset');
    const path = await validateBundleFile(bundleRoot, `${BUNDLE_PATH}/${file.path}`);
    assert(inside(bundlePath, path), 'Measurement bundle asset escaped its root');
    const bytes = await readFile(path);
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
    measurementBuild: { ...manifest, manifestSha256: sha256(manifestBytes) },
    metricLimits: {
      firstMetadata: 'dynamic entry import, selection, metadata read/index export and disposal',
      warmMetadata: 'same document and Blob, compiled/module cache, repeated metadata extraction',
      seek: 'snapshot copy, Blob structuredClone, index import or parse, verified key seek, first chunk and disposal',
      excluded: 'input staging, payload hash, diagnostic parser pass and full Worker startup',
      reads: 'Blob.slice requested bytes and completed Blob.arrayBuffer bytes only',
      wasmCapacity: 'separate untimed diagnostic session, not the timed instance',
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
            const reads = {
              sliceCalls: 0,
              requestedBytes: 0,
              arrayBufferCalls: 0,
              completedBytes: 0,
            };
            const nativeSlice = Blob.prototype.slice;
            const nativeArrayBuffer = Blob.prototype.arrayBuffer;
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
                reads.sliceCalls++;
                reads.requestedBytes += result.size;
              }
              return result;
            };
            Blob.prototype.arrayBuffer = async function () {
              const result = await nativeArrayBuffer.call(this);
              if (tracked.has(this)) {
                reads.arrayBufferCalls++;
                reads.completedBytes += result.byteLength;
              }
              return result;
            };
            const currentReads = () => ({ ...reads });
            const delta = (before: typeof reads, after: typeof reads) => ({
              sliceCalls: after.sliceCalls - before.sliceCalls,
              requestedBytes: after.requestedBytes - before.requestedBytes,
              arrayBufferCalls: after.arrayBufferCalls - before.arrayBufferCalls,
              completedBytes: after.completedBytes - before.completedBytes,
            });
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
            type Entry = {
              engine: string;
              select: (input: Blob) => void;
              metadata: (input: Blob) => Promise<Metadata>;
              seek: (input: Blob, metadata: Metadata, trim: number) => Promise<SeekResult>;
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
            try {
              const beforeFirstMetadata = currentReads();
              const firstMetadataStart = performance.now();
              api = (await import(entry)) as Entry;
              api.select(source);
              const firstMetadata = await api.metadata(source);
              const firstMetadataMs = performance.now() - firstMetadataStart;
              const firstMetadataReads = delta(beforeFirstMetadata, currentReads());
              const firstMetadataValue = await summarize(firstMetadata);

              const beforeFirstSeek = currentReads();
              const firstSeekStart = performance.now();
              const firstSeek = await api.seek(source, firstMetadata, trimStart);
              const firstSeekMs = performance.now() - firstSeekStart;
              const firstSeekReads = delta(beforeFirstSeek, currentReads());
              const firstPacket = await packet(firstSeek);

              const beforeWarmMetadata = currentReads();
              const warmMetadataStart = performance.now();
              const warmMetadata = await api.metadata(source);
              const warmMetadataMs = performance.now() - warmMetadataStart;
              const warmMetadataReads = delta(beforeWarmMetadata, currentReads());
              const warmMetadataValue = await summarize(warmMetadata);

              const beforeWarmSeek = currentReads();
              const warmSeekStart = performance.now();
              const warmSeek = await api.seek(source, warmMetadata, trimStart);
              const warmSeekMs = performance.now() - warmSeekStart;
              const warmSeekReads = delta(beforeWarmSeek, currentReads());
              const warmPacket = await packet(warmSeek);

              const diagnosticReadsBefore = currentReads();
              const ownedDiagnostic = await api.diagnosticOwnedCapacity(source);
              const diagnosticReads = delta(diagnosticReadsBefore, currentReads());
              return {
                engine: api.engine,
                timeOrigin: performance.timeOrigin,
                firstMetadata: {
                  ms: firstMetadataMs,
                  reads: firstMetadataReads,
                  value: firstMetadataValue,
                },
                warmMetadata: {
                  ms: warmMetadataMs,
                  reads: warmMetadataReads,
                  value: warmMetadataValue,
                },
                firstSeek: { ms: firstSeekMs, reads: firstSeekReads, firstPacket },
                warmSeek: { ms: warmSeekMs, reads: warmSeekReads, firstPacket: warmPacket },
                diagnostic: { ownedDiagnostic, reads: diagnosticReads },
              };
            } finally {
              api?.clearSelection();
              Blob.prototype.slice = nativeSlice;
              Blob.prototype.arrayBuffer = nativeArrayBuffer;
              globalThis.structuredClone = nativeClone;
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
        assert.deepEqual(errors, [], `${input.id}: browser errors`);
        (report.samples as unknown[]).push({
          id: input.id,
          source: { bytes: input.size, sha256: input.sha256 },
          trimStart: input.trimStart,
          ...sample,
        });
      } finally {
        await page.close();
      }
    }
    report.status = 'passed';
    return { profile: 'owned-demux-service-measurement', status: 'passed', samples: inputs.length };
  } catch (error) {
    failure = error;
    report.status = 'failed';
    report.error = errorText(error);
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
