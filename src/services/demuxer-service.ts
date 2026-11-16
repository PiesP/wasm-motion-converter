// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { schedulerYield as yieldToMain } from '@piesp/browser-core/util';
import { ownedDecoderConfig, ownedTimestampUs } from '@services/owned-demux-config';
import {
  classifyOwnedDemuxError,
  computeOwnedPacketStats,
  createOwnedDemuxSession,
  OwnedDemuxAbiError,
  OwnedDemuxConversionError,
  OwnedDemuxResourceError,
} from '@services/owned-demux-core';
import { isOwnedInputIndexSnapshot } from '@services/owned-input-index-cache';
import type {
  ConversionRequest,
  PrecomputedVideoMetadata,
  VideoRotation,
} from '@t/conversion-types';
import {
  DEFAULT_FPS,
  DEMUX_MEMORY_BUDGET_BYTES,
  ENCODED_CHUNK_BUDGET_BYTES,
  ENCODED_PACKET_BUDGET_BYTES,
} from '@utils/constants';
import { logger } from '@utils/logger';
import { getTrimmedDurationSeconds } from '@utils/trim-time';

import { fingerprintOwnedDemuxSource } from './owned-demux-index-snapshot';

export interface DemuxResult {
  /** One-shot packet stream. The producer advances only when the decoder requests a chunk. */
  chunks: Iterable<EncodedVideoChunk> | AsyncIterable<EncodedVideoChunk>;
  config: VideoDecoderConfig;
  /** Maximum encoded bytes that the decoder may retain before emitting matching output. */
  encodedChunkBudgetBytes?: number | undefined;
  /** Estimated frame count until the stream finishes, then the exact packet count. */
  totalFrames: number;
  duration: number;
  /** Exact streamed source duration in milliseconds once chunks are consumed. */
  sourceTotalMs: number;
  framerate: number;
  /** First requested presentation timestamp in microseconds. Preroll packets may precede it. */
  trimStartUs?: number | undefined;
  /** Exclusive requested presentation end timestamp in microseconds. */
  trimEndUs?: number | undefined;
  rotation?: VideoRotation | undefined;
  /** Idempotently release the conversion-owned parser if the stream is not consumed. */
  dispose?: (() => void) | undefined;
  /** A matching selected-file index avoids reparsing this conversion. */
  indexRoute?: 'imported' | 'parsed' | undefined;
  /** One per-job copy; the main realm holds another master copy. */
  indexSnapshotBytes?: number | undefined;
  /** Original caller-owned ArrayBuffer outside the 128 MiB demux reserve. */
  inputBufferBytes?: number | undefined;
}

type DemuxPreparedCallback = (estimatedTotalFrames: number) => void;
const ENCODED_CHUNK_OVERHEAD_BYTES = 1024;
const HEADER_WINDOW_OVERLAP_BYTES = 2 * 64 * 1024;

export function getEncodedChunkRetainedBytes(chunk: EncodedVideoChunk): number {
  return chunk.byteLength + ENCODED_CHUNK_OVERHEAD_BYTES;
}

function resolveInputSource(request: ConversionRequest): Blob | ArrayBuffer {
  const source = request.inputBlob ?? request.inputBuffer;
  if (!source) throw new Error('No video input source provided');
  return source;
}

function getInputSizeBytes(source: Blob | ArrayBuffer): number {
  return source instanceof Blob ? source.size : source.byteLength;
}

/** Prepare a bounded owned packet index and preserve decode-order lazy streaming. */
export async function demuxVideo(
  request: ConversionRequest,
  preComputedMetadata?: PrecomputedVideoMetadata,
  onPrepared?: DemuxPreparedCallback,
  signal?: AbortSignal
): Promise<DemuxResult> {
  const startTime = performance.now();
  const inputSource = resolveInputSource(request);
  const inputSizeBytes = getInputSizeBytes(inputSource);
  const session = await createOwnedDemuxSession(inputSource, signal);
  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', dispose);
    session.release();
  }
  signal?.addEventListener('abort', dispose, { once: true });
  try {
    signal?.throwIfAborted();
    const cached = request.indexSnapshot;
    if (cached !== undefined && !isOwnedInputIndexSnapshot(cached))
      throw new OwnedDemuxAbiError('Owned demux index snapshot envelope is invalid');
    if (cached && !(inputSource instanceof Blob))
      throw new OwnedDemuxAbiError('Owned demux index snapshot requires a Blob source');
    let indexRoute: 'imported' | 'parsed' = 'parsed';
    const indexSnapshotBytes = cached?.bytes.byteLength ?? 0;
    let track: Awaited<ReturnType<typeof session.analyze>> | undefined;
    if (cached && cached.sourceSize === inputSizeBytes) {
      const fingerprint = await fingerprintOwnedDemuxSource(inputSource, signal);
      signal?.throwIfAborted();
      if (fingerprint === cached.fingerprint) {
        track = await session.importIndex(cached.bytes, signal);
        indexRoute = 'imported';
      }
    }
    track ??= await session.analyze(signal);
    const config = preComputedMetadata?.config ?? ownedDecoderConfig(track);
    const configDescriptionBytes = config.description?.byteLength ?? 0;
    if (!Number.isSafeInteger(configDescriptionBytes) || configDescriptionBytes > 1024 * 1024)
      throw new OwnedDemuxResourceError('Demux memory limit exceeded by decoder configuration');
    ownedTimestampUs(track.durationTicks, track.timescale);
    const duration = preComputedMetadata?.duration ?? Number(track.durationTicks) / track.timescale;
    const stats = preComputedMetadata
      ? null
      : await computeOwnedPacketStats(session, track, signal);
    const framerate =
      preComputedMetadata?.framerate ??
      (stats && Number.isFinite(stats.averagePacketRate) && stats.averagePacketRate > 0
        ? Math.round(stats.averagePacketRate * 100) / 100
        : DEFAULT_FPS);
    const rotation: VideoRotation =
      preComputedMetadata?.rotation ??
      (track.rotation === 90 || track.rotation === 180 || track.rotation === 270
        ? track.rotation
        : 0);
    const safeFramerate = Number.isFinite(framerate) && framerate > 0 ? framerate : DEFAULT_FPS;
    const trimmedDuration = getTrimmedDurationSeconds(duration, request.trimStart, request.trimEnd);
    const estimatedTotalFrames = Math.max(1, Math.round(trimmedDuration * safeFramerate));

    // The caller-owned original ArrayBuffer is reported separately. Only incremental
    // parser, range-read, packet, and WebCodecs queue allocations spend this reserve.
    const inputBufferBytes = inputSource instanceof Blob ? 0 : inputSource.byteLength;
    const { wasmCapacityBytes } = session.transferStats;
    const seekWorkspaceBytes = request.trimStart > 0 ? session.seekWorkspaceBytes : 0;
    const descriptionReserveBytes = Math.max(
      2 * track.description.byteLength,
      track.description.byteLength + configDescriptionBytes
    );
    const chunkBudgetBytes = Math.min(
      ENCODED_CHUNK_BUDGET_BYTES,
      DEMUX_MEMORY_BUDGET_BYTES -
        wasmCapacityBytes -
        track.maxPacketBytes -
        // A returned packet may remain live while another realm read is pending.
        ENCODED_PACKET_BUDGET_BYTES -
        descriptionReserveBytes -
        HEADER_WINDOW_OVERLAP_BYTES -
        // Snapshot master (main realm) and this transferred copy stay live.
        2 * indexSnapshotBytes -
        seekWorkspaceBytes
    );
    const packetBudgetBytes = ENCODED_PACKET_BUDGET_BYTES;
    if (
      !Number.isSafeInteger(chunkBudgetBytes) ||
      chunkBudgetBytes < track.maxPacketBytes + ENCODED_CHUNK_OVERHEAD_BYTES ||
      track.maxPacketBytes + ENCODED_CHUNK_OVERHEAD_BYTES > packetBudgetBytes
    )
      throw new OwnedDemuxResourceError('Demux memory limit exceeded before packet streaming');

    // A retained 64 KiB source window remains charged to the realm's 16 MiB
    // read credit. The independent small packet copy fits in this existing
    // overlap reserve; no additional header or chunk admission is needed.
    session.enablePacketReadWindow();

    // A nonzero trim begins at the latest verified presentation-time key at or
    // before the requested boundary; earlier packets remain decoder preroll.
    const startIndex =
      request.trimStart > 0 ? await session.findVerifiedKey(request.trimStart, signal) : 0;
    if (startIndex === null) throw new Error('No decodable packets found in input buffer');
    signal?.throwIfAborted();
    onPrepared?.(estimatedTotalFrames);
    logger.info('demuxer', 'Demux stream prepared', {
      fileName: request.fileName,
      fileSizeBytes: inputSizeBytes,
      inputBufferBytes,
      codec: config.codec,
      duration: `${duration.toFixed(2)}s`,
      packetBudgetBytes,
      chunkBudgetBytes,
      wasmCapacityBytes,
      indexRoute,
      indexSnapshotBytes,
    });

    // The generator updates this result after it returns to its owner.
    // oxlint-disable-next-line prefer-const
    let result!: DemuxResult;
    const chunks = (async function* streamChunks(): AsyncGenerator<EncodedVideoChunk> {
      let totalFrames = 0;
      let sourceDurationUs = 0;
      let peakChunkBytes = 0;
      let completed = false;
      try {
        // Keep decode order through the end of the source. A future reference
        // frame may be needed for a visible B-frame before trimEnd.
        for (let index = startIndex; index < track.packetCount; index++) {
          signal?.throwIfAborted();
          const packet = await session.packetAsync(index, signal);
          const packetRetainedBytes = packet.byteLength + ENCODED_CHUNK_OVERHEAD_BYTES;
          if (packetRetainedBytes > packetBudgetBytes || packetRetainedBytes > chunkBudgetBytes)
            throw new OwnedDemuxResourceError(
              `Demux memory limit exceeded by one encoded packet (${packetBudgetBytes} byte budget)`
            );
          let data: ArrayBuffer | null = await session.readPacket(packet, signal);
          signal?.throwIfAborted();
          let chunk: EncodedVideoChunk;
          try {
            chunk = new EncodedVideoChunk({
              type: packet.key ? 'key' : 'delta',
              timestamp: ownedTimestampUs(packet.ptsTicks, track.timescale),
              duration: ownedTimestampUs(packet.durationTicks, track.timescale),
              data,
            });
          } catch (error) {
            throw new OwnedDemuxConversionError('Owned demux chunk construction failed', {
              cause: error,
            });
          }
          // Drop the host source-read reference before yielding at the decoder's
          // backpressure boundary; the reservation still counts its peak copy.
          data = null;
          const retainedBytes = getEncodedChunkRetainedBytes(chunk);
          if (retainedBytes > chunkBudgetBytes)
            throw new OwnedDemuxResourceError('Demux memory limit exceeded while creating chunk');
          peakChunkBytes = Math.max(peakChunkBytes, retainedBytes);
          totalFrames++;
          sourceDurationUs += Math.max(0, chunk.duration ?? 0);
          yield chunk;
          if (totalFrames % 50 === 0) await yieldToMain();
        }
        completed = true;
      } catch (error) {
        throw classifyOwnedDemuxError(error, signal);
      } finally {
        result.totalFrames = totalFrames;
        result.sourceTotalMs = sourceDurationUs / 1000;
        dispose();
        const elapsed = performance.now() - startTime;
        logger.info('demuxer', completed ? 'Demux stream complete' : 'Demux stream closed', {
          totalFrames,
          sourceTotalMs: result.sourceTotalMs,
          peakChunkBytes,
          elapsedMs: Math.round(elapsed),
          elapsed: `${(elapsed / 1000).toFixed(2)}s`,
        });
      }
    })();
    result = {
      chunks,
      config,
      encodedChunkBudgetBytes: chunkBudgetBytes,
      totalFrames: estimatedTotalFrames,
      duration,
      sourceTotalMs: 0,
      indexRoute,
      indexSnapshotBytes,
      inputBufferBytes,
      framerate,
      trimStartUs: request.trimStart * 1_000_000,
      ...(request.trimEnd > 0 ? { trimEndUs: request.trimEnd * 1_000_000 } : {}),
      rotation,
      dispose,
    };
    return result;
  } catch (error) {
    dispose();
    throw classifyOwnedDemuxError(error, signal);
  }
}
