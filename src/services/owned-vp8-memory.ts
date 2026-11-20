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
import type { FrameMemoryUsage, WebpFrameMemoryBudget } from './frame-memory';
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
  private readonly removeFrameGuard: () => void;
  private readonly removePoolGuard: () => void;

  constructor(
    private readonly demux: DemuxResult,
    private readonly frames: WebpFrameMemoryBudget,
    private readonly muxer: StreamingWebpMuxer,
    private readonly assertAdditionalMemoryBytes: (bytes: number) => void,
    private readonly maxOutputBytes = WEBP_MAX_OUTPUT_BYTES
  ) {
    this.removeFrameGuard = frames.installAdmissionGuard((nextUsage) => {
      this.assertTotal(
        this.muxer.retainedBytes,
        this.linearCapacityBytes,
        this.hostCopyBytes,
        nextUsage
      );
    });
    try {
      this.removePoolGuard = globalBufferPool.installGrowthGuard((nextPooledBytes) => {
        this.assertTotal(
          this.muxer.retainedBytes,
          this.linearCapacityBytes,
          this.hostCopyBytes,
          this.frames.usage,
          nextPooledBytes
        );
      });
    } catch (error) {
      this.removeFrameGuard();
      throw error;
    }
  }

  /** Target reservations cover both output pixels and transient copy scratch.
   * Credit pooled active/idle storage once against that shared reservation; an
   * idle RGBA scratch buffer is still part of the reserved RGB copy footprint. */
  get frameLiveBytes(): number {
    return this.frameLiveFor(this.frames.usage, globalBufferPool.totalRetainedMemory);
  }

  private frameLiveFor(usage: FrameMemoryUsage, pooledBytes: number): number {
    const poolExcess = Math.max(0, pooledBytes - usage.targetBytes);
    return usage.totalBytes + poolExcess;
  }

  private assertTotal(
    muxBytes: number,
    linearBytes: number,
    copyBytes: number,
    frameUsage = this.frames.usage,
    pooledBytes = globalBufferPool.totalRetainedMemory
  ): void {
    const frameLiveBytes = this.frameLiveFor(frameUsage, pooledBytes);
    if (
      !Number.isSafeInteger(muxBytes) ||
      !Number.isSafeInteger(linearBytes) ||
      !Number.isSafeInteger(copyBytes) ||
      !Number.isSafeInteger(frameLiveBytes) ||
      !Number.isSafeInteger(pooledBytes) ||
      muxBytes < 0 ||
      linearBytes < 0 ||
      copyBytes < 0 ||
      pooledBytes < 0 ||
      frameLiveBytes > FRAME_PIPELINE_MEMORY_BUDGET_BYTES ||
      copyBytes > WEBP_MAX_OUTPUT_BYTES
    )
      throw new OwnedVp8MemoryAdmissionError('Owned VP8 host memory reservation is invalid');
    // Includes overlapping pending and emitted bytes before a presentation is settled.
    if (muxBytes > this.maxOutputBytes)
      throw new OwnedVp8MemoryAdmissionError(
        `Owned VP8 live mux memory exceeds ${this.maxOutputBytes} bytes (${muxBytes} bytes required)`
      );
    const total =
      DEMUX_MEMORY_BUDGET_BYTES +
      (this.demux.inputBufferBytes ?? 0) +
      frameLiveBytes +
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
    if (this.released) return;
    if (actualCapacityBytes > this.linearCapacityBytes)
      throw new OwnedVp8MemoryAdmissionError('Owned VP8 grew beyond reserved linear memory');
    this.assertTotal(this.muxer.retainedBytes, this.linearCapacityBytes, this.hostCopyBytes);
  }

  /** The old pending frame may coexist with emitted chunks and the new copy. */
  assertPresentationCopy(startUs: number): void {
    this.assertTotal(
      this.muxer.retainedBeforePresentationCopy(startUs),
      this.linearCapacityBytes,
      this.hostCopyBytes
    );
  }

  presentationCopySettled(): void {
    // The mux now owns any new copy and reports it in retainedBytes.
    this.hostCopyBytes = 0;
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
    this.hostCopyBytes = bytes;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.linearCapacityBytes = 0;
    this.hostCopyBytes = 0;
  }

  /** Keep conversion-wide guards until finalization and any late copy settle. */
  dispose(): void {
    this.release();
    this.removePoolGuard();
    this.removeFrameGuard();
  }
}
