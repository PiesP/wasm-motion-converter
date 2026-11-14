// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import {
  DEMUX_MEMORY_BUDGET_BYTES,
  FRAME_PIPELINE_MEMORY_BUDGET_BYTES,
  WEBP_MAX_OUTPUT_BYTES,
  WORKER_MAX_MEMORY_MB,
  BYTES_PER_MB,
} from '@utils/constants';

import { globalBufferPool } from './buffer-pool';
import type { DemuxResult } from './demuxer-service';
import type { WebpFrameMemoryBudget } from './frame-memory';
import {
  OwnedVp8MemoryAdmissionError,
  OwnedVp8OutputLimitError,
  type OwnedVp8Accounting,
} from './owned-vp8-core';
import type { StreamingWebpMuxer } from './streaming-webp-encoder';

const MAX_CONVERSION_BYTES = WORKER_MAX_MEMORY_MB * BYTES_PER_MB;

/** Synchronous conversion-wide admission. The 128 MiB demux reserve already
 * includes both index copies; the original input ArrayBuffer is outside it. */
export class OwnedVp8MemoryBroker implements OwnedVp8Accounting {
  private linearCapacityBytes = 0;
  private hostCopyBytes = 0;
  private released = false;

  constructor(
    private readonly demux: DemuxResult,
    private readonly frames: WebpFrameMemoryBudget,
    private readonly muxer: StreamingWebpMuxer,
    private readonly assertAdditionalMemoryBytes: (bytes: number) => void,
    private readonly maxOutputBytes = WEBP_MAX_OUTPUT_BYTES
  ) {}

  /** Active pooled target buffers are already covered by target reservations.
   * Idle pooled buffers and any active allocation above that credit are extra. */
  get frameLiveBytes(): number {
    const usage = this.frames.usage;
    const poolExcess =
      globalBufferPool.totalPooledMemory +
      Math.max(0, globalBufferPool.totalActiveMemory - usage.targetBytes);
    return usage.totalBytes + poolExcess;
  }

  private assertTotal(muxBytes: number, linearBytes: number, copyBytes: number): void {
    if (
      !Number.isSafeInteger(muxBytes) ||
      !Number.isSafeInteger(linearBytes) ||
      !Number.isSafeInteger(copyBytes) ||
      muxBytes < 0 ||
      linearBytes < 0 ||
      copyBytes < 0 ||
      this.frameLiveBytes > FRAME_PIPELINE_MEMORY_BUDGET_BYTES ||
      muxBytes > this.maxOutputBytes ||
      copyBytes > WEBP_MAX_OUTPUT_BYTES
    )
      throw new OwnedVp8MemoryAdmissionError('Owned VP8 host memory reservation is invalid');
    const total =
      DEMUX_MEMORY_BUDGET_BYTES +
      (this.demux.inputBufferBytes ?? 0) +
      this.frameLiveBytes +
      muxBytes +
      linearBytes +
      copyBytes;
    if (!Number.isSafeInteger(total) || total > MAX_CONVERSION_BYTES)
      throw new OwnedVp8MemoryAdmissionError('Owned VP8 conversion exceeds aggregate memory');
    // The caller's existing guard already charges original input, both index
    // copies, and every pooled byte. Supply only the remaining reservations.
    const alreadyCharged =
      (this.demux.inputBufferBytes ?? 0) +
      2 * (this.demux.indexSnapshotBytes ?? 0) +
      globalBufferPool.totalRetainedMemory;
    this.assertAdditionalMemoryBytes(Math.max(0, total - alreadyCharged));
  }

  reserve(linearCapacityBytes: number, hostOutputCopyBytes: number): void {
    if (this.released) throw new OwnedVp8MemoryAdmissionError('Owned VP8 broker retired');
    this.assertTotal(this.muxer.retainedBytes, linearCapacityBytes, hostOutputCopyBytes);
    this.linearCapacityBytes = linearCapacityBytes;
    this.hostCopyBytes = hostOutputCopyBytes;
  }

  observe(actualCapacityBytes: number): void {
    if (actualCapacityBytes > this.linearCapacityBytes)
      throw new OwnedVp8MemoryAdmissionError('Owned VP8 grew beyond reserved linear memory');
  }

  /** The old pending frame may coexist with emitted chunks and the new copy. */
  assertPresentationCopy(startUs: number): void {
    this.assertTotal(
      this.muxer.retainedBeforePresentationCopy(startUs),
      this.linearCapacityBytes,
      this.hostCopyBytes
    );
  }

  assertFinishPresentation(endUs: number): void {
    this.assertTotal(this.muxer.retainedBeforeFinishPresentation(endUs), 0, 0);
  }

  /** Blob and final ArrayBuffer are two complete owned output copies. */
  assertFinalization(): void {
    const bytes = this.muxer.retainedBytes;
    if (bytes > this.maxOutputBytes)
      throw new OwnedVp8OutputLimitError('Owned VP8 final output copies exceed the byte limit');
    // The output copy is distinct from the retained Blob source.
    this.assertTotal(bytes, 0, bytes);
  }

  release(): void {
    this.released = true;
    this.linearCapacityBytes = 0;
    this.hostCopyBytes = 0;
  }
}
