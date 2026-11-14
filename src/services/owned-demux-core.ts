// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { schedulerYield } from '@piesp/browser-core/util';

import { OwnedDemuxSession, type OwnedDemuxTrack } from './owned-demux-session';

const MAX_WASM_ASSET_BYTES = 256 * 1024;
const MAX_WASM_INITIAL_PAGES = 64;
const MAX_WASM_PAGES = 1024;
const PACKET_STATS_TIMEOUT_MS = 2_000;
let compiledModule: WebAssembly.Module | undefined;

export class OwnedDemuxLoadError extends Error {
  override name = 'OwnedDemuxLoadError';
}
export class OwnedDemuxAbiError extends Error {
  override name = 'OwnedDemuxAbiError';
}
export class OwnedDemuxResourceError extends Error {
  override name = 'OwnedDemuxResourceError';
}
export class OwnedDemuxParseError extends Error {
  override name = 'OwnedDemuxParseError';
}
export class OwnedDemuxConversionError extends Error {
  override name = 'OwnedDemuxConversionError';
}

/** Reject a substituted module's oversized initial memory before instantiation. */
function inspectMemoryDeclaration(bytes: Uint8Array): void {
  if (
    bytes.length < 8 ||
    bytes[0] !== 0 ||
    bytes[1] !== 97 ||
    bytes[2] !== 115 ||
    bytes[3] !== 109 ||
    bytes[4] !== 1 ||
    bytes[5] !== 0 ||
    bytes[6] !== 0 ||
    bytes[7] !== 0
  )
    throw new OwnedDemuxAbiError('Owned demux WASM header is invalid');
  let at = 8;
  const integer = (): number => {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = bytes[at++];
      if (byte === undefined) throw new OwnedDemuxAbiError('Owned demux WASM integer is truncated');
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw new OwnedDemuxAbiError('Owned demux WASM integer is unbounded');
  };
  while (at < bytes.length) {
    const section = bytes[at++];
    const size = integer();
    const end = at + size;
    if (end > bytes.length) throw new OwnedDemuxAbiError('Owned demux WASM section is truncated');
    if (section === 5) {
      if (integer() !== 1 || integer() !== 1)
        throw new OwnedDemuxAbiError('Owned demux WASM memory shape is invalid');
      const initial = integer();
      const maximum = integer();
      if (at !== end) throw new OwnedDemuxAbiError('Owned demux WASM memory record is invalid');
      if (initial > MAX_WASM_INITIAL_PAGES || maximum !== MAX_WASM_PAGES)
        throw new OwnedDemuxResourceError('Owned demux WASM memory declaration exceeds admission');
      return;
    }
    at = end;
  }
  throw new OwnedDemuxAbiError('Owned demux WASM memory declaration is missing');
}

function awaitAbortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new DOMException('Owned demux load aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
    if (signal.aborted) onAbort();
  });
}

/** Classify terminal failures without retrying a failed or cancelled conversion. */
export function classifyOwnedDemuxError(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted)
    return error instanceof Error && error.name === 'AbortError'
      ? error
      : new DOMException('Owned demux cancelled', 'AbortError');
  if (error instanceof Error && error.name === 'AbortError') return error;
  if (
    error instanceof OwnedDemuxLoadError ||
    error instanceof OwnedDemuxAbiError ||
    error instanceof OwnedDemuxResourceError ||
    error instanceof OwnedDemuxParseError ||
    error instanceof OwnedDemuxConversionError
  )
    return error;
  if (error instanceof WebAssembly.LinkError)
    return new OwnedDemuxAbiError(error.message, { cause: error });
  if (error instanceof RangeError)
    return new OwnedDemuxResourceError(error.message, { cause: error });
  const message = error instanceof Error ? error.message : String(error);
  if (/ABI|invalid status|invalid event|exports missing|version mismatch/.test(message))
    return new OwnedDemuxAbiError(message, { cause: error });
  if (
    /resource|memory|capacity|limit|admission|out of range/i.test(message) ||
    /parser error 4\b/.test(message)
  )
    return new OwnedDemuxResourceError(message, { cause: error });
  return new OwnedDemuxParseError(message, { cause: error });
}

async function readBoundedAsset(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new OwnedDemuxLoadError('Owned demux WASM response has no body');
  const bytes = new Uint8Array(MAX_WASM_ASSET_BYTES);
  let length = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await awaitAbortable(reader.read(), signal);
      if (next.done) break;
      if (length + next.value.byteLength > bytes.byteLength)
        throw new OwnedDemuxLoadError('Owned demux WASM asset exceeds its byte limit');
      bytes.set(next.value, length);
      length += next.value.byteLength;
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cancellation may leave a pending browser read; the reader is discarded.
    }
  }
  if (length < 8) throw new OwnedDemuxLoadError('Owned demux WASM asset is truncated');
  return bytes.subarray(0, length);
}

/** Only a successfully compiled and non-aborted module is cached in this realm. */
export async function loadOwnedDemuxModule(signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  if (compiledModule) return compiledModule;
  let response: Response;
  try {
    response = await awaitAbortable(
      fetch(new URL('./owned-demux.wasm', import.meta.url), signal ? { signal } : {}),
      signal
    );
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    throw new OwnedDemuxLoadError('Owned demux WASM fetch failed', { cause: error });
  }
  if (
    !response.ok ||
    response.redirected ||
    response.type === 'opaque' ||
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/wasm'
  )
    throw new OwnedDemuxLoadError('Owned demux WASM asset response is invalid');
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedAsset(response, signal);
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof OwnedDemuxLoadError) throw error;
    throw new OwnedDemuxLoadError('Owned demux WASM read failed', { cause: error });
  }
  signal?.throwIfAborted();
  inspectMemoryDeclaration(bytes);
  let module: WebAssembly.Module;
  try {
    module = await awaitAbortable(WebAssembly.compile(bytes as BufferSource), signal);
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    throw new OwnedDemuxLoadError('Owned demux WASM compilation failed', { cause: error });
  }
  signal?.throwIfAborted();
  if (WebAssembly.Module.imports(module).length !== 0)
    throw new OwnedDemuxAbiError('Owned demux WASM has unexpected imports');
  compiledModule = module;
  return module;
}

export async function createOwnedDemuxSession(
  source: Blob | ArrayBuffer,
  signal?: AbortSignal
): Promise<OwnedDemuxSession> {
  try {
    const module = await loadOwnedDemuxModule(signal);
    signal?.throwIfAborted();
    return new OwnedDemuxSession(source, module);
  } catch (error) {
    throw classifyOwnedDemuxError(error, signal);
  }
}

export type OwnedPacketStats = { averagePacketRate: number; averageBitrate: number };

/** Match the patched oracle's 50-packet decode-order window and B-frame lookahead. */
export async function computeOwnedPacketStats(
  session: OwnedDemuxSession,
  track: OwnedDemuxTrack,
  signal?: AbortSignal
): Promise<OwnedPacketStats | null> {
  const deadline = performance.now() + PACKET_STATS_TIMEOUT_MS;
  let start = Infinity;
  let end = -Infinity;
  let count = 0;
  let bytes = 0;
  for (let index = 0; index < track.packetCount; index++) {
    if (index % 256 === 0) {
      signal?.throwIfAborted();
      if (performance.now() >= deadline) return null;
      await schedulerYield();
    }
    const packet = session.packet(index);
    const pts = Number(packet.ptsTicks) / track.timescale;
    const duration = Number(packet.durationTicks) / track.timescale;
    if (count >= 50 && pts >= end) break;
    start = Math.min(start, pts);
    end = Math.max(end, pts + duration);
    count++;
    bytes += packet.byteLength;
  }
  signal?.throwIfAborted();
  const span = end - start;
  if (!count || !Number.isFinite(span) || span <= 0) return null;
  return {
    averagePacketRate: Number((count / span).toPrecision(16)),
    averageBitrate: Number(((8 * bytes) / span).toPrecision(16)),
  };
}
