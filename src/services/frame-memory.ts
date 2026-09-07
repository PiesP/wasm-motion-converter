// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { FRAME_PIPELINE_MEMORY_BUDGET_BYTES } from '@utils/constants';
import { getPooledBufferSize } from './buffer-pool';

const RGB_BYTES_PER_PIXEL = 3;
const RGBA_BYTES_PER_PIXEL = 4;
const DECODED_RGBA_BYTES_PER_PIXEL = 4;
const UNCERTAIN_DECODED_BYTES_PER_PIXEL = 8;
const RGB_FRAME_TASK_TRANSIENT_BYTES_PER_PIXEL = 8;
const RGBA_FRAME_TASK_TRANSIENT_BYTES_PER_PIXEL = 4;
const CANVAS_BYTES_PER_PIXEL = 4;

export type CpuPixelFormat = 'rgb' | 'rgba';

export interface FrameMemoryUsage {
  readonly canvasBytes: number;
  readonly resultBytes: number;
  readonly sourceBytes: number;
  readonly targetBytes: number;
  readonly totalBytes: number;
}

type ReservationKind = 'canvas' | 'source' | 'target';

/** One conversion-scoped reservation. Release is deliberately idempotent. */
export class FrameMemoryReservation {
  private released = false;
  private retainedResultBytes = 0;

  constructor(
    private readonly budget: WebpFrameMemoryBudget,
    readonly kind: ReservationKind,
    readonly bytes: number
  ) {}

  get isReleased(): boolean {
    return this.released;
  }

  /** Charge an encoded result before it may be retained out of order. */
  reserveResultBytes(bytes: number): boolean {
    if (this.released || this.kind !== 'target') return false;
    if (!this.budget.growResult(this, bytes)) return false;
    this.retainedResultBytes += bytes;
    return true;
  }

  get resultBytes(): number {
    return this.retainedResultBytes;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.budget.release(this, this.retainedResultBytes);
    this.retainedResultBytes = 0;
  }
}

export interface FrameMemoryHandoff {
  readonly isTaken: boolean;
  take(): FrameMemoryReservation;
}

export interface WebpFrameMemoryBudgetOptions {
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  targetWidth: number;
  targetHeight: number;
  workerCount: number;
  sourceHeadroomFrames?: number;
}

export interface WebpWorkerBudgetOptions
  extends Omit<WebpFrameMemoryBudgetOptions, 'sourceHeadroomFrames' | 'workerCount'> {
  requestedWorkers: number;
}

/**
 * Select a pool size that can retain its canvases beside decoder-copy storage,
 * worker tasks, and conservative source ownership. Zero selects the existing
 * serial OffscreenCanvas fallback before any unusable Worker pool is created.
 */
export function calculateWebpWorkerCountForBudget(options: WebpWorkerBudgetOptions): number {
  const requestedWorkers = Math.max(1, Math.floor(options.requestedWorkers));
  const sourceBytes = estimateRuntimeDecodedSourceFrameBytes(
    options.codedWidth,
    options.codedHeight,
    options.displayWidth,
    options.displayHeight,
    null
  );
  const taskBytes = estimateFrameTaskBytes(options.targetWidth, options.targetHeight, 'rgba');
  const canvasBytes = estimateCanvasBytes(options.targetWidth, options.targetHeight);
  const decoderCanvasBytes = canvasBytes;
  const sourceHeadroomBytes = sourceBytes * 9;

  for (let workers = requestedWorkers; workers >= 2; workers--) {
    const parallelBytes =
      sourceHeadroomBytes + decoderCanvasBytes + canvasBytes * workers + taskBytes * workers;
    if (parallelBytes <= FRAME_PIPELINE_MEMORY_BUDGET_BYTES) return workers;
  }

  const serialBytes = sourceBytes + decoderCanvasBytes + canvasBytes + taskBytes;
  return serialBytes <= FRAME_PIPELINE_MEMORY_BUDGET_BYTES ? 1 : 0;
}

interface TargetWaiter {
  reject: (error: Error) => void;
  resolve: (reservation: FrameMemoryReservation) => void;
}

interface TargetDrainWaiter {
  reject: (error: Error) => void;
  resolve: () => void;
}

/**
 * Shared 192 MiB ledger for decoded sources, pixel/worker tasks, persistent
 * canvases, and completed results waiting for presentation order.
 */
export class WebpFrameMemoryBudget {
  readonly targetTaskBytes: number;
  readonly sourceHeadroomBytes: number;
  readonly maxOutstandingTasks: number;
  readonly allowsTargetLookahead: boolean;

  private canvasBytes = 0;
  private resultBytes = 0;
  private sourceBytes = 0;
  private targetBytes = 0;
  private targetCount = 0;
  private readonly reservations = new Set<FrameMemoryReservation>();
  private readonly targetWaiters: TargetWaiter[] = [];
  private readonly targetDrainWaiters: TargetDrainWaiter[] = [];
  private targetGateError: Error | null = null;
  private useSourceHeadroom: boolean;
  private decoderFlushActive = false;

  constructor(options: WebpFrameMemoryBudgetOptions) {
    const requestedWorkers = Math.max(1, Math.floor(options.workerCount));
    const canvasBytes = estimateCanvasBytes(options.targetWidth, options.targetHeight);
    this.targetTaskBytes = estimateFrameTaskBytes(
      options.targetWidth,
      options.targetHeight,
      'rgba'
    );
    const sourceFrameBytes = estimateRuntimeDecodedSourceFrameBytes(
      options.codedWidth,
      options.codedHeight,
      options.displayWidth,
      options.displayHeight,
      null
    );
    const sourceHeadroomFrames = Math.max(1, Math.floor(options.sourceHeadroomFrames ?? 9));
    this.sourceHeadroomBytes = sourceFrameBytes * sourceHeadroomFrames;
    if (!Number.isSafeInteger(this.sourceHeadroomBytes)) {
      throw new RangeError('Source-frame headroom exceeds the safe integer range');
    }

    // Every pool Worker may retain its lazily initialized Canvas while idle.
    // The decoder-side scaling/fallback Canvas remains alive for the conversion.
    const persistentCanvasBytes = canvasBytes * (requestedWorkers + 1);
    const canvasReservation = this.reserveImmediate('canvas', persistentCanvasBytes);
    if (!canvasReservation) {
      throw new Error('WebP frame memory limit exceeded by persistent canvases');
    }
    if (persistentCanvasBytes + this.targetTaskBytes > FRAME_PIPELINE_MEMORY_BUDGET_BYTES) {
      canvasReservation.release();
      throw new Error('WebP frame memory limit exceeded by one encoder task');
    }

    const headroomTaskCapacity = Math.max(
      0,
      Math.floor(
        (FRAME_PIPELINE_MEMORY_BUDGET_BYTES - persistentCanvasBytes - this.sourceHeadroomBytes) /
          this.targetTaskBytes
      )
    );
    this.maxOutstandingTasks =
      requestedWorkers >= 2 ? Math.max(1, Math.min(requestedWorkers * 2, headroomTaskCapacity)) : 1;
    this.useSourceHeadroom = this.maxOutstandingTasks >= 2;
    this.allowsTargetLookahead = this.maxOutstandingTasks >= 2;
  }

  get usage(): FrameMemoryUsage {
    return {
      canvasBytes: this.canvasBytes,
      resultBytes: this.resultBytes,
      sourceBytes: this.sourceBytes,
      targetBytes: this.targetBytes,
      totalBytes: this.canvasBytes + this.resultBytes + this.sourceBytes + this.targetBytes,
    };
  }

  /** Decoder output promises may retain this many source floors beside one task. */
  calculatePendingSourceCapacity(sourceBytes: number, requestedMaximum: number): number {
    assertReservationBytes(sourceBytes);
    if (sourceBytes === 0) return 0;
    const requested = Math.max(1, Math.floor(requestedMaximum));
    const availableSourceBytes =
      FRAME_PIPELINE_MEMORY_BUDGET_BYTES - this.canvasBytes - this.targetTaskBytes;
    return Math.min(requested, Math.max(0, Math.floor(availableSourceBytes / sourceBytes)));
  }

  tryReserveSource(bytes: number): FrameMemoryReservation | null {
    assertReservationBytes(bytes);
    const taskFloor = Math.max(0, this.targetTaskBytes - this.targetBytes);
    if (this.currentBytes + bytes + taskFloor > FRAME_PIPELINE_MEMORY_BUDGET_BYTES) return null;
    return this.reserveImmediate('source', bytes);
  }

  async acquireTarget(): Promise<FrameMemoryReservation> {
    if (this.targetGateError) throw this.targetGateError;
    const reservation = this.tryReserveTarget();
    if (reservation) return reservation;
    return await new Promise<FrameMemoryReservation>((resolve, reject) => {
      this.targetWaiters.push({ reject, resolve });
    });
  }

  createHandoff(reservation: FrameMemoryReservation): FrameMemoryHandoff {
    let taken = false;
    return {
      get isTaken() {
        return taken;
      },
      take: () => {
        if (taken) throw new Error('Frame memory ownership has already been transferred');
        if (reservation.isReleased) throw new Error('Frame memory reservation has been released');
        taken = true;
        return reservation;
      },
    };
  }

  /** Keep native flush output serial while its decoded-source burst is retained. */
  beginDecoderFlush(): void {
    this.useSourceHeadroom = false;
    this.decoderFlushActive = true;
    this.drainTargetWaiters();
  }

  completeDecoderFlush(): void {
    this.decoderFlushActive = false;
    this.drainTargetWaiters();
  }

  async waitForTargets(): Promise<void> {
    if (this.targetBytes === 0) return;
    if (this.targetGateError) throw this.targetGateError;
    await new Promise<void>((resolve, reject) => {
      this.targetDrainWaiters.push({ reject, resolve });
    });
  }

  closeTargetGate(error: unknown): void {
    if (this.targetGateError) return;
    this.targetGateError = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this.targetWaiters.splice(0)) waiter.reject(this.targetGateError);
    for (const waiter of this.targetDrainWaiters.splice(0)) waiter.reject(this.targetGateError);
  }

  dispose(): void {
    this.closeTargetGate(new Error('WebP frame memory budget disposed'));
    for (const reservation of [...this.reservations]) reservation.release();
  }

  growResult(reservation: FrameMemoryReservation, bytes: number): boolean {
    assertReservationBytes(bytes);
    if (!this.reservations.has(reservation)) return false;
    if (this.currentBytes + bytes > FRAME_PIPELINE_MEMORY_BUDGET_BYTES) return false;
    this.resultBytes += bytes;
    return true;
  }

  release(reservation: FrameMemoryReservation, resultBytes: number): void {
    if (!this.reservations.delete(reservation)) return;
    if (reservation.kind === 'canvas') this.canvasBytes -= reservation.bytes;
    if (reservation.kind === 'source') this.sourceBytes -= reservation.bytes;
    if (reservation.kind === 'target') {
      this.targetBytes -= reservation.bytes;
      this.targetCount = Math.max(0, this.targetCount - 1);
    }
    this.resultBytes -= resultBytes;
    if (this.targetBytes === 0) {
      for (const waiter of this.targetDrainWaiters.splice(0)) waiter.resolve();
    }
    this.drainTargetWaiters();
  }

  private get currentBytes(): number {
    return this.canvasBytes + this.resultBytes + this.sourceBytes + this.targetBytes;
  }

  private get admissionBytes(): number {
    // The first target must be able to consume the source frame that is already
    // held for it. Conservative nine-frame headroom applies only before adding
    // asynchronous lookahead beyond that serial progress guarantee.
    const retainedSources =
      this.useSourceHeadroom && this.targetBytes > 0
        ? Math.max(this.sourceBytes, this.sourceHeadroomBytes)
        : this.sourceBytes;
    return this.canvasBytes + this.resultBytes + retainedSources + this.targetBytes;
  }

  private tryReserveTarget(): FrameMemoryReservation | null {
    if (this.targetCount >= this.maxOutstandingTasks) return null;
    if (this.decoderFlushActive && this.targetCount >= 1) return null;
    if (this.admissionBytes + this.targetTaskBytes > FRAME_PIPELINE_MEMORY_BUDGET_BYTES)
      return null;
    return this.reserveImmediate('target', this.targetTaskBytes);
  }

  private reserveImmediate(kind: ReservationKind, bytes: number): FrameMemoryReservation | null {
    assertReservationBytes(bytes);
    if (this.currentBytes + bytes > FRAME_PIPELINE_MEMORY_BUDGET_BYTES) return null;
    const reservation = new FrameMemoryReservation(this, kind, bytes);
    this.reservations.add(reservation);
    if (kind === 'canvas') this.canvasBytes += bytes;
    if (kind === 'source') this.sourceBytes += bytes;
    if (kind === 'target') {
      this.targetBytes += bytes;
      this.targetCount++;
    }
    return reservation;
  }

  private drainTargetWaiters(): void {
    while (this.targetWaiters.length > 0 && !this.targetGateError) {
      const reservation = this.tryReserveTarget();
      if (!reservation) return;
      this.targetWaiters.shift()?.resolve(reservation);
    }
  }
}

function assertReservationBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new RangeError('Frame memory reservation must be a non-negative safe integer');
  }
}

/** Conservatively estimate a retained VideoFrame from its maximum visible extent. */
export function estimateDecodedSourceFrameBytes(
  codedWidth: number,
  codedHeight: number,
  displayWidth: number,
  displayHeight: number
): number {
  const width = Math.max(codedWidth, displayWidth);
  const height = Math.max(codedHeight, displayHeight);
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels <= 0) {
    throw new RangeError('Source frame dimensions must produce a positive safe pixel count');
  }

  const bytes = pixels * DECODED_RGBA_BYTES_PER_PIXEL;
  if (!Number.isSafeInteger(bytes)) {
    throw new RangeError('Source frame allocation exceeds the safe integer range');
  }
  return bytes;
}

/**
 * Reserve a decoded frame from its runtime plane allocation when trustworthy.
 * Unknown layouts use an 8-Bpp extent so high-bit-depth, alpha, and 4:4:4
 * surfaces cannot silently fall back to the 4-Bpp admission floor.
 */
export function estimateRuntimeDecodedSourceFrameBytes(
  codedWidth: number,
  codedHeight: number,
  displayWidth: number,
  displayHeight: number,
  runtimeAllocationBytes: number | null
): number {
  const extentFloorBytes = estimateDecodedSourceFrameBytes(
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight
  );
  if (
    runtimeAllocationBytes !== null &&
    Number.isSafeInteger(runtimeAllocationBytes) &&
    runtimeAllocationBytes > 0
  ) {
    return Math.max(extentFloorBytes, runtimeAllocationBytes);
  }

  const uncertainBytes =
    (extentFloorBytes / DECODED_RGBA_BYTES_PER_PIXEL) * UNCERTAIN_DECODED_BYTES_PER_PIXEL;
  if (!Number.isSafeInteger(uncertainBytes)) {
    throw new RangeError('Source frame fallback allocation exceeds the safe integer range');
  }
  return uncertainBytes;
}

/** Estimate the cross-realm memory retained by one active pixel encode task. */
export function estimateActiveFrameBytes(
  width: number,
  height: number,
  pixelFormat: CpuPixelFormat = 'rgb'
): number {
  return estimateFrameTaskBytes(width, height, pixelFormat) + estimateCanvasBytes(width, height);
}

/** Pixel ownership plus format-specific transient decoder/worker storage. */
export function estimateFrameTaskBytes(
  width: number,
  height: number,
  pixelFormat: CpuPixelFormat = 'rgb'
): number {
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels <= 0) {
    throw new RangeError('Frame dimensions must produce a positive safe pixel count');
  }

  const pixelBytes = pixels * (pixelFormat === 'rgba' ? RGBA_BYTES_PER_PIXEL : RGB_BYTES_PER_PIXEL);
  const transientBytes =
    pixels *
    (pixelFormat === 'rgba'
      ? RGBA_FRAME_TASK_TRANSIENT_BYTES_PER_PIXEL
      : RGB_FRAME_TASK_TRANSIENT_BYTES_PER_PIXEL);
  if (!Number.isSafeInteger(pixelBytes) || !Number.isSafeInteger(transientBytes)) {
    throw new RangeError('Frame allocation exceeds the safe integer range');
  }

  return getPooledBufferSize(pixelBytes) + transientBytes;
}

/** Persistent RGBA Canvas backing retained by an initialized worker/context. */
export function estimateCanvasBytes(width: number, height: number): number {
  const pixels = width * height;
  const bytes = pixels * CANVAS_BYTES_PER_PIXEL;
  if (!Number.isSafeInteger(pixels) || pixels <= 0 || !Number.isSafeInteger(bytes)) {
    throw new RangeError('Canvas dimensions must produce a positive safe byte count');
  }
  return bytes;
}

/** Estimate source-frame ownership plus target conversion working memory. */
export function estimateFrameOutputBytes(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  pixelFormat: CpuPixelFormat = 'rgb'
): number {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
    return estimateActiveFrameBytes(sourceWidth, sourceHeight, pixelFormat);
  }

  const sourcePixels = sourceWidth * sourceHeight;
  if (!Number.isSafeInteger(sourcePixels) || sourcePixels <= 0) {
    throw new RangeError('Source frame dimensions must produce a positive safe pixel count');
  }
  const sourceBytes = sourcePixels * DECODED_RGBA_BYTES_PER_PIXEL;
  if (!Number.isSafeInteger(sourceBytes)) {
    throw new RangeError('Source frame allocation exceeds the safe integer range');
  }

  const targetBytes = estimateActiveFrameBytes(targetWidth, targetHeight, pixelFormat);
  const totalBytes = sourceBytes + targetBytes;
  if (!Number.isSafeInteger(totalBytes)) {
    throw new RangeError('Frame output allocation exceeds the safe integer range');
  }
  return totalBytes;
}

/** Derive concurrency while retaining decoded source and converted target frames. */
export function calculateFrameOutputConcurrency(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  requestedMaximum: number,
  pixelFormat: CpuPixelFormat = 'rgb'
): number {
  const requested = Math.max(1, Math.floor(requestedMaximum));
  const bytesPerFrame = estimateFrameOutputBytes(
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
    pixelFormat
  );
  return Math.min(requested, Math.floor(FRAME_PIPELINE_MEMORY_BUDGET_BYTES / bytesPerFrame));
}

/**
 * Derive the number of decoded source frames that may wait while reserving the
 * requested number of target working sets. Target memory is held aside for the
 * lifetime of the queue, so source reservations cannot consume its headroom.
 */
export function calculateStagedFrameSourceCapacity(
  codedWidth: number,
  codedHeight: number,
  displayWidth: number,
  displayHeight: number,
  targetWidth: number,
  targetHeight: number,
  requestedMaximum: number,
  targetWorkingSetCount = 1,
  pixelFormat: CpuPixelFormat = 'rgb'
): number {
  const requested = Math.max(1, Math.floor(requestedMaximum));
  const targetCount = Math.max(1, Math.floor(targetWorkingSetCount));
  const sourceBytes = estimateDecodedSourceFrameBytes(
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight
  );
  const targetWorkingBytes =
    estimateActiveFrameBytes(targetWidth, targetHeight, pixelFormat) * targetCount;
  if (!Number.isSafeInteger(targetWorkingBytes)) {
    throw new RangeError('Target working-set reservation exceeds the safe integer range');
  }
  const sourceBudgetBytes = FRAME_PIPELINE_MEMORY_BUDGET_BYTES - targetWorkingBytes;
  if (sourceBudgetBytes < sourceBytes) return 0;
  return Math.min(requested, Math.floor(sourceBudgetBytes / sourceBytes));
}

/** Derive bounded concurrency from the shared live-frame memory reservation. */
export function calculateFrameConcurrency(
  width: number,
  height: number,
  requestedMaximum: number,
  pixelFormat: CpuPixelFormat = 'rgb'
): number {
  return Math.max(
    1,
    calculateFrameOutputConcurrency(width, height, width, height, requestedMaximum, pixelFormat)
  );
}
