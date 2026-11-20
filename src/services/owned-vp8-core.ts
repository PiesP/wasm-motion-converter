// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { schedulerYield } from '@piesp/browser-core/util';

import { OwnedVp8MemoryAdmissionError } from './owned-vp8-memory-admission-error';

export { OwnedVp8MemoryAdmissionError };

const ABI_VERSION = 2;
const REQUEST_BYTES = 48;
const RESPONSE_BYTES = 96;
const MAX_ASSET_BYTES = 482_273;
const MAX_INITIAL_PAGES = 128;
const MAX_MEMORY_PAGES = 3_072;
const MAX_LINEAR_BYTES = 192 * 1024 * 1024;
const MAX_AGGREGATE_BYTES = 512 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 96 * 1024 * 1024;
const COPY_CHUNK_BYTES = 65_536;
const TASK_BUDGET_MS = 6;
const WORKING = 10;
const OUTPUT_READY = 11;
const U32_MAX = 0xffff_ffff;

let compiledModule: { module: WebAssembly.Module; initialPages: number } | undefined;

export class OwnedVp8LoadError extends Error {
  override name = 'OwnedVp8LoadError';
}
export class OwnedVp8AbiError extends Error {
  override name = 'OwnedVp8AbiError';
}
export class OwnedVp8InvalidInputError extends Error {
  override name = 'OwnedVp8InvalidInputError';
}
export class OwnedVp8UnsupportedLayoutError extends Error {
  override name = 'OwnedVp8UnsupportedLayoutError';
}
export class OwnedVp8UnsupportedPixelsError extends Error {
  override name = 'OwnedVp8UnsupportedPixelsError';
}
export class OwnedVp8OutputLimitError extends Error {
  override name = 'OwnedVp8OutputLimitError';
}
export class OwnedVp8PartitionLimitError extends Error {
  override name = 'OwnedVp8PartitionLimitError';
}
export class OwnedVp8TrapError extends Error {
  override name = 'OwnedVp8TrapError';
}
export class OwnedVp8CancelledError extends Error {
  override name = 'OwnedVp8CancelledError';
}
export class OwnedVp8BusyError extends Error {
  override name = 'OwnedVp8BusyError';
}

export interface OwnedVp8Settings {
  width: number;
  height: number;
  stride: number;
  /** 0 RGBA, 1 BGRA, 2 RGBX, 3 BGRX, 4 packed RGB. */
  layout: number;
  quality: 60 | 75 | 85;
  outputLimit: number;
  externalLiveBytes: number;
  retainedOutputBytes: number;
}

/** Reservations include WASM capacity once and a separate possible host copy. */
export interface OwnedVp8Accounting {
  reserve(linearCapacityBytes: number, hostOutputCopyBytes: number): void | Promise<void>;
  observe?(actualCapacityBytes: number): void;
  release(): void;
}

export interface OwnedVp8EncoderOptions {
  signal?: AbortSignal;
  generation?: number;
  isCurrent?: () => boolean;
  accounting: OwnedVp8Accounting;
}

export interface OwnedVp8Stats {
  frame: number;
  sourceCopyBytes: number;
  finalizedVp8Bytes: number;
  hostOutputCopyReservedBytes: number;
  actualLinearCapacityBytes: number;
  reservedLinearCapacityBytes: number;
  aggregateAdmittedBytes: number;
  steps: number;
  hostTaskYields: number;
}

/** The consumer must settle every write and copy that uses this borrowed view
 * before its returned Promise settles. The encoder keeps the output lease until
 * then, including when cancellation or retire is requested. */
export type ConsumeFinalizedRawVp8 = (rawVp8: Uint8Array) => void | Promise<void>;

interface Vp8Exports {
  memory: WebAssembly.Memory;
  vp8_v2_abi_version(): number;
  vp8_v2_request_ptr(): number;
  vp8_v2_response_ptr(): number;
  vp8_v2_plan(): number;
  vp8_v2_reserve_step(generation: number, frame: number): number;
  vp8_v2_begin(generation: number, frame: number): number;
  vp8_v2_step(generation: number, frame: number): number;
  vp8_v2_abort(generation: number, frame: number): number;
  vp8_v2_release_input(generation: number, frame: number): number;
  vp8_v2_release_output(generation: number, frame: number): number;
  vp8_v2_retire(): number;
}

interface ResponseRecord {
  status: number;
  phase: number;
  generation: number;
  frame: number;
  inputPointer: number;
  inputLength: number;
  outputPointer: number;
  outputLength: number;
  actualCapacity: number;
  admittedCapacity: number;
  aggregateBytes: number;
  stage: number;
  progressDone: number;
  progressTotal: number;
  frameBytes: number;
  hostOutputCopyBytes: number;
}

function fixedWord(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX)
    throw new OwnedVp8InvalidInputError(`Owned VP8 ${label} is not a fixed-width word`);
  return value;
}

function cancelled(signal?: AbortSignal): OwnedVp8CancelledError {
  return new OwnedVp8CancelledError('Owned VP8 conversion cancelled', {
    cause: signal?.reason,
  });
}

function awaitAbortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(cancelled(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(cancelled(signal));
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

function readWord(bytes: Uint8Array, position: { at: number }, end: number): number {
  let value = 0;
  for (let index = 0; index < 5; index++) {
    if (position.at >= end) throw new OwnedVp8AbiError('Owned VP8 WASM integer is truncated');
    const byte = bytes[position.at++]!;
    if (index === 4 && (byte & 0xf0) !== 0)
      throw new OwnedVp8AbiError('Owned VP8 WASM integer exceeds u32');
    value += (byte & 0x7f) * 2 ** (index * 7);
    if ((byte & 0x80) === 0) return value;
  }
  throw new OwnedVp8AbiError('Owned VP8 WASM integer is unbounded');
}

/** Reject oversized, shared, memory64, or unbounded memory before instantiate. */
function inspectMemoryDeclaration(bytes: Uint8Array): number {
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
    throw new OwnedVp8AbiError('Owned VP8 WASM header is invalid');
  const position = { at: 8 };
  let initialPages: number | undefined;
  while (position.at < bytes.length) {
    const section = bytes[position.at++]!;
    const size = readWord(bytes, position, bytes.length);
    const end = position.at + size;
    if (end > bytes.length) throw new OwnedVp8AbiError('Owned VP8 WASM section is truncated');
    if (section === 8) throw new OwnedVp8AbiError('Owned VP8 WASM start section is unsupported');
    if (section === 5) {
      if (initialPages !== undefined)
        throw new OwnedVp8AbiError('Owned VP8 WASM has duplicate memory sections');
      if (readWord(bytes, position, end) !== 1 || readWord(bytes, position, end) !== 1)
        throw new OwnedVp8AbiError('Owned VP8 WASM memory shape is unsupported');
      const initial = readWord(bytes, position, end);
      const maximum = readWord(bytes, position, end);
      if (position.at !== end)
        throw new OwnedVp8AbiError('Owned VP8 WASM memory record is malformed');
      if (initial > MAX_INITIAL_PAGES || maximum !== MAX_MEMORY_PAGES || initial > maximum)
        throw new OwnedVp8MemoryAdmissionError(
          'Owned VP8 WASM memory declaration exceeds admission'
        );
      initialPages = initial;
    }
    position.at = end;
  }
  if (initialPages === undefined)
    throw new OwnedVp8AbiError('Owned VP8 WASM memory declaration is missing');
  return initialPages;
}

async function readBoundedAsset(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new OwnedVp8LoadError('Owned VP8 WASM response has no body');
  const bytes = new Uint8Array(MAX_ASSET_BYTES);
  let length = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw cancelled(signal);
      const next = await awaitAbortable(reader.read(), signal);
      if (signal?.aborted) throw cancelled(signal);
      if (next.done) break;
      if (length + next.value.byteLength > bytes.length)
        throw new OwnedVp8LoadError('Owned VP8 WASM asset exceeds its byte limit');
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
      // Aborted reads may still be unwinding in the browser.
    }
  }
  if (length < 8) throw new OwnedVp8LoadError('Owned VP8 WASM asset is truncated');
  return bytes.subarray(0, length);
}

const REQUIRED_EXPORTS = [
  'vp8_v2_abi_version',
  'vp8_v2_request_ptr',
  'vp8_v2_response_ptr',
  'vp8_v2_plan',
  'vp8_v2_reserve_step',
  'vp8_v2_begin',
  'vp8_v2_step',
  'vp8_v2_abort',
  'vp8_v2_release_input',
  'vp8_v2_release_output',
  'vp8_v2_retire',
] as const;

function checkedExports(instance: WebAssembly.Instance): Vp8Exports {
  const exports = instance.exports as Record<string, unknown>;
  if (
    !(exports.memory instanceof WebAssembly.Memory) ||
    !(exports.memory.buffer instanceof ArrayBuffer)
  )
    throw new OwnedVp8AbiError('Owned VP8 WASM memory export is missing or shared');
  for (const name of REQUIRED_EXPORTS) {
    if (typeof exports[name] !== 'function')
      throw new OwnedVp8AbiError(`Owned VP8 ABI2 export ${name} is missing`);
  }
  const api = exports as unknown as Vp8Exports;
  if (api.vp8_v2_abi_version() !== ABI_VERSION)
    throw new OwnedVp8AbiError('Owned VP8 ABI version mismatch');
  return api;
}

function classifyFailure(error: unknown): Error {
  if (error instanceof Error && error.name.startsWith('OwnedVp8')) return error;
  if (error instanceof WebAssembly.RuntimeError)
    return new OwnedVp8TrapError('Owned VP8 WASM trapped', { cause: error });
  if (error instanceof WebAssembly.LinkError)
    return new OwnedVp8AbiError('Owned VP8 WASM linkage failed', { cause: error });
  if (error instanceof RangeError)
    return new OwnedVp8MemoryAdmissionError('Owned VP8 allocation failed', { cause: error });
  return error instanceof Error
    ? error
    : new OwnedVp8AbiError('Owned VP8 operation failed', { cause: error });
}

export class OwnedVp8Encoder {
  private api: Vp8Exports | undefined;
  private readonly generation: number;
  private frame = 0;
  private busy = false;
  private retired = false;
  private accountingReleased = false;
  private reservedLinear = 0;
  private reservedHostCopy = 0;

  constructor(
    instance: WebAssembly.Instance,
    private readonly options: OwnedVp8EncoderOptions,
    initialReservedBytes: number
  ) {
    this.generation = fixedWord(options.generation ?? 1, 'generation');
    if (this.generation === 0) throw new OwnedVp8InvalidInputError('Owned VP8 generation is zero');
    this.api = checkedExports(instance);
    this.reservedLinear = initialReservedBytes;
  }

  private active(): void {
    if (this.retired || this.options.signal?.aborted || this.options.isCurrent?.() === false)
      throw cancelled(this.options.signal);
  }

  private currentApi(): Vp8Exports {
    if (!this.api) throw cancelled(this.options.signal);
    return this.api;
  }

  private view(pointer: number, length: number): Uint8Array {
    const buffer = this.currentApi().memory.buffer;
    if (
      !Number.isSafeInteger(pointer) ||
      !Number.isSafeInteger(length) ||
      pointer <= 0 ||
      length < 0 ||
      pointer + length > buffer.byteLength
    )
      throw new OwnedVp8AbiError('Owned VP8 ABI extent is invalid');
    return new Uint8Array(buffer, pointer, length);
  }

  private record(status: number, checkTicket: boolean): ResponseRecord {
    const api = this.currentApi();
    const view = this.view(api.vp8_v2_response_ptr(), RESPONSE_BYTES);
    const words = new DataView(view.buffer, view.byteOffset, view.byteLength);
    const word = (index: number): number => words.getUint32(index * 4, true);
    if (
      word(0) !== ABI_VERSION ||
      word(1) !== status ||
      [20, 21, 22, 23].some((index) => word(index) !== 0)
    )
      throw new OwnedVp8AbiError('Owned VP8 ABI response is inconsistent');
    const record: ResponseRecord = {
      status,
      phase: word(2),
      generation: word(3),
      frame: word(4),
      inputPointer: word(5),
      inputLength: word(6),
      outputPointer: word(7),
      outputLength: word(8),
      actualCapacity: word(9),
      admittedCapacity: word(10),
      aggregateBytes: word(11),
      stage: word(12),
      progressDone: word(13),
      progressTotal: word(14),
      frameBytes: word(18),
      hostOutputCopyBytes: word(19),
    };
    if (record.phase > 6 || record.actualCapacity !== api.memory.buffer.byteLength)
      throw new OwnedVp8AbiError('Owned VP8 ABI phase or capacity is invalid');
    if (checkTicket && (record.generation !== this.generation || record.frame !== this.frame))
      throw new OwnedVp8AbiError('Owned VP8 published a stale frame ticket');
    return record;
  }

  private status(status: number, allowed: readonly number[], checkTicket = true): ResponseRecord {
    // A rejected plan has not committed its requested generation/frame yet.
    const record = this.record(status, checkTicket && allowed.includes(status));
    if (allowed.includes(status)) return record;
    switch (status) {
      case 1:
        throw new OwnedVp8InvalidInputError('Owned VP8 rejected the input');
      case 2:
        throw new OwnedVp8UnsupportedLayoutError('Owned VP8 rejected the pixel layout');
      case 3:
        throw new OwnedVp8MemoryAdmissionError('Owned VP8 rejected memory admission');
      case 4:
        throw new OwnedVp8OutputLimitError('Owned VP8 exceeded the output limit');
      case 5:
        throw new OwnedVp8PartitionLimitError('Owned VP8 exceeded the first partition limit');
      case 8:
        throw new OwnedVp8BusyError('Owned VP8 has an active lease');
      case 9:
        throw cancelled(this.options.signal);
      case 12:
        throw new OwnedVp8UnsupportedPixelsError('Owned VP8 requires opaque RGBA/BGRA pixels');
      default:
        throw new OwnedVp8AbiError(`Owned VP8 ABI returned status ${status}`);
    }
  }

  private observe(record: ResponseRecord): void {
    if (
      record.admittedCapacity > MAX_LINEAR_BYTES ||
      record.aggregateBytes > MAX_AGGREGATE_BYTES ||
      record.hostOutputCopyBytes > MAX_OUTPUT_BYTES ||
      (record.admittedCapacity !== 0 && record.admittedCapacity % COPY_CHUNK_BYTES !== 0) ||
      record.actualCapacity > record.admittedCapacity ||
      record.actualCapacity > this.reservedLinear
    )
      throw new OwnedVp8MemoryAdmissionError('Owned VP8 exceeded admitted capacity');
    this.observePhysicalCapacity(this.currentApi());
  }

  private observePhysicalCapacity(api: Vp8Exports): void {
    const actual = api.memory.buffer.byteLength;
    if (actual > this.reservedLinear || actual > MAX_LINEAR_BYTES)
      throw new OwnedVp8MemoryAdmissionError('Owned VP8 grew beyond its host reservation');
    try {
      this.options.accounting.observe?.(actual);
    } catch (error) {
      throw new OwnedVp8MemoryAdmissionError('Owned VP8 capacity observer failed', {
        cause: error,
      });
    }
  }

  private admit(record: ResponseRecord): void | Promise<void> {
    if (
      record.admittedCapacity > MAX_LINEAR_BYTES ||
      record.hostOutputCopyBytes > MAX_OUTPUT_BYTES ||
      record.actualCapacity > this.reservedLinear
    )
      throw new OwnedVp8MemoryAdmissionError('Owned VP8 plan exceeds fixed resource ceilings');
    if (
      record.admittedCapacity !== this.reservedLinear ||
      record.hostOutputCopyBytes !== this.reservedHostCopy
    ) {
      let reservation: void | Promise<void>;
      try {
        reservation = this.options.accounting.reserve(
          record.admittedCapacity,
          record.hostOutputCopyBytes
        );
      } catch (error) {
        throw new OwnedVp8MemoryAdmissionError('Owned VP8 reservation failed', { cause: error });
      }
      const admitted = (): void => {
        this.active();
        this.reservedLinear = record.admittedCapacity;
        this.reservedHostCopy = record.hostOutputCopyBytes;
        this.observe(record);
      };
      if (reservation !== undefined)
        return Promise.resolve(reservation).then(admitted, (error: unknown) => {
          throw new OwnedVp8MemoryAdmissionError('Owned VP8 reservation failed', { cause: error });
        });
      admitted();
      return;
    }
    this.observe(record);
  }

  private yieldIfDue(deadline: { at: number }, stats: { yields: number }): void | Promise<void> {
    this.active();
    if (performance.now() >= deadline.at) {
      return schedulerYield().then(() => {
        stats.yields++;
        deadline.at = performance.now() + TASK_BUDGET_MS;
        this.active();
      });
    }
    this.active();
  }

  private dispose(): void {
    if (this.accountingReleased) return;
    const api = this.api;
    try {
      api?.vp8_v2_retire();
      if (api) this.observePhysicalCapacity(api);
    } catch {
      // A trapped instance is already retired from use.
    } finally {
      this.api = undefined;
      this.retired = true;
      this.accountingReleased = true;
      this.options.accounting.release();
    }
  }

  /** Retire marks active work stale; any pending consumer finishes before release. */
  retire(): void {
    this.retired = true;
    if (!this.busy) this.dispose();
  }

  /** Keep source bytes immutable and its backing buffer attached until this settles. */
  async encode(
    pixels: Uint8Array,
    settings: OwnedVp8Settings,
    consumeFinalizedRawVp8: ConsumeFinalizedRawVp8
  ): Promise<OwnedVp8Stats> {
    if (this.busy) throw new OwnedVp8BusyError('Owned VP8 instance already has an active frame');
    this.active();
    if (this.frame === U32_MAX) throw new OwnedVp8AbiError('Owned VP8 frame ticket exhausted');
    this.busy = true;
    const frame = ++this.frame;
    const api = this.currentApi();
    let lease: 'none' | 'input' | 'output' = 'none';
    let steps = 0;
    const taskStats = { yields: 0 };
    const deadline = { at: performance.now() + TASK_BUDGET_MS };
    try {
      const frozen = { ...settings };
      const sourceBuffer = pixels.buffer;
      const sourceLength = pixels.byteLength;
      const sourceOffset = pixels.byteOffset;
      const sourceCapacity = sourceBuffer.byteLength;
      if (!(sourceBuffer instanceof ArrayBuffer) || sourceLength === 0)
        throw new OwnedVp8InvalidInputError('Owned VP8 source must be a nonempty unshared buffer');
      if (frozen.externalLiveBytes < sourceCapacity)
        throw new OwnedVp8MemoryAdmissionError('Owned VP8 source backing capacity is unaccounted');
      const checkSource = (): void => {
        if (
          pixels.buffer !== sourceBuffer ||
          pixels.byteLength !== sourceLength ||
          pixels.byteOffset !== sourceOffset ||
          sourceBuffer.byteLength !== sourceCapacity
        )
          throw new OwnedVp8InvalidInputError('Owned VP8 source backing changed during input copy');
      };
      const values = [
        ABI_VERSION,
        frozen.width,
        frozen.height,
        frozen.stride,
        frozen.layout,
        frozen.quality,
        sourceLength,
        frozen.outputLimit,
        this.generation,
        frame,
        frozen.externalLiveBytes,
        frozen.retainedOutputBytes,
      ];
      values.forEach((value, index) => fixedWord(value, `request word ${index}`));
      const request = this.view(api.vp8_v2_request_ptr(), REQUEST_BYTES);
      const words = new DataView(request.buffer, request.byteOffset, request.byteLength);
      values.forEach((value, index) => words.setUint32(index * 4, value, true));
      let admission = this.admit(this.status(api.vp8_v2_plan(), [0], true));
      if (admission !== undefined) await admission;

      let record: ResponseRecord;
      for (;;) {
        this.active();
        record = this.status(api.vp8_v2_reserve_step(this.generation, frame), [0, WORKING]);
        if (record.status === 0) lease = 'input';
        admission = this.admit(record);
        if (admission !== undefined) await admission;
        if (record.status === 0) break;
        const pendingYield = this.yieldIfDue(deadline, taskStats);
        if (pendingYield !== undefined) await pendingYield;
      }
      checkSource();
      if (record.inputLength !== sourceLength || record.inputPointer === 0)
        throw new OwnedVp8AbiError('Owned VP8 input lease does not match the request');
      const destination = this.view(record.inputPointer, record.inputLength);
      const inputBuffer = destination.buffer;
      for (let at = 0; at < sourceLength; at += COPY_CHUNK_BYTES) {
        this.active();
        checkSource();
        destination.set(pixels.subarray(at, at + COPY_CHUNK_BYTES), at);
        if (api.memory.buffer !== inputBuffer)
          throw new OwnedVp8AbiError('Owned VP8 memory grew during an input write');
        const pendingYield = this.yieldIfDue(deadline, taskStats);
        if (pendingYield !== undefined) await pendingYield;
      }
      this.active();
      checkSource();
      record = this.status(api.vp8_v2_begin(this.generation, frame), [WORKING]);
      lease = 'none';
      admission = this.admit(record);
      if (admission !== undefined) await admission;

      for (;;) {
        this.active();
        record = this.status(api.vp8_v2_step(this.generation, frame), [WORKING, OUTPUT_READY]);
        steps++;
        if (record.status === OUTPUT_READY) lease = 'output';
        admission = this.admit(record); // The output plan is reserved before the following step.
        if (admission !== undefined) await admission;
        if (record.status === OUTPUT_READY) break;
        const pendingYield = this.yieldIfDue(deadline, taskStats);
        if (pendingYield !== undefined) await pendingYield;
      }
      if (
        record.outputPointer === 0 ||
        record.outputLength <= 10 ||
        record.outputLength !== record.frameBytes ||
        record.hostOutputCopyBytes !== record.outputLength
      )
        throw new OwnedVp8AbiError('Owned VP8 finalized output extent is invalid');
      const rawVp8 = this.view(record.outputPointer, record.outputLength);
      const tag = rawVp8[0]! | (rawVp8[1]! << 8) | (rawVp8[2]! << 16);
      // ABI2 emits version-zero displayed keyframes with unscaled dimensions.
      const width = rawVp8[6]! | (rawVp8[7]! << 8);
      const height = rawVp8[8]! | (rawVp8[9]! << 8);
      if (
        (tag & 0x1f) !== 0x10 ||
        tag >>> 5 === 0 ||
        (tag >>> 5) + 10 >= rawVp8.byteLength ||
        rawVp8[3] !== 0x9d ||
        rawVp8[4] !== 0x01 ||
        rawVp8[5] !== 0x2a ||
        width !== frozen.width ||
        height !== frozen.height
      )
        throw new OwnedVp8AbiError('Owned VP8 raw keyframe header or geometry is invalid');
      this.active();
      // Await the physical consumer. Abort/retire cannot release this WASM lease
      // while the consumer still reads or copies its borrowed byte view.
      await consumeFinalizedRawVp8(rawVp8);
      this.active();
      if (rawVp8.buffer !== api.memory.buffer)
        throw new OwnedVp8AbiError('Owned VP8 memory grew while output was leased');
      const releaseStatus = api.vp8_v2_release_output(this.generation, frame);
      if (releaseStatus === 0) lease = 'none';
      this.status(releaseStatus, [0]);
      this.observePhysicalCapacity(api);
      const stats: OwnedVp8Stats = {
        frame,
        sourceCopyBytes: sourceLength,
        finalizedVp8Bytes: record.outputLength,
        hostOutputCopyReservedBytes: this.reservedHostCopy,
        actualLinearCapacityBytes: api.memory.buffer.byteLength,
        reservedLinearCapacityBytes: this.reservedLinear,
        aggregateAdmittedBytes: record.aggregateBytes,
        steps,
        hostTaskYields: taskStats.yields,
      };
      return stats;
    } catch (error) {
      const failure = classifyFailure(error);
      // All writes above are synchronous and the output consumer has settled.
      // Do not race an in-flight consume Promise with cancellation cleanup.
      try {
        api.vp8_v2_abort(this.generation, frame);
      } catch {
        // Continue trying to release a lease after an abort trap.
      }
      try {
        if (lease === 'input') api.vp8_v2_release_input(this.generation, frame);
        if (lease === 'output') api.vp8_v2_release_output(this.generation, frame);
      } catch {
        // No physical write remains pending; the instance is retired below.
      }
      try {
        this.observePhysicalCapacity(api);
      } catch {
        // Preserve the original error after attempting physical release.
      }
      this.retired = true;
      throw failure;
    } finally {
      this.busy = false;
      if (this.retired) this.dispose();
    }
  }
}

/** A compiled module may survive conversions; every conversion owns a fresh
 * mutable instance and keeps it until retire after all borrowed writes settle. */
export async function createOwnedVp8Encoder(
  options: OwnedVp8EncoderOptions
): Promise<OwnedVp8Encoder> {
  fixedWord(options.generation ?? 1, 'generation');
  if ((options.generation ?? 1) === 0)
    throw new OwnedVp8InvalidInputError('Owned VP8 generation is zero');
  if (options.signal?.aborted || options.isCurrent?.() === false) throw cancelled(options.signal);
  const assetUrl = new URL('../../crates/owned-vp8/owned-vp8.wasm', import.meta.url);
  if (assetUrl.origin !== globalThis.location?.origin && assetUrl.protocol !== 'file:')
    throw new OwnedVp8LoadError('Owned VP8 WASM asset is not same-origin');
  let compiled = compiledModule;
  if (!compiled) {
    let response: Response;
    try {
      response = await awaitAbortable(
        fetch(assetUrl, {
          ...(options.signal ? { signal: options.signal } : {}),
          redirect: 'error',
          credentials: 'same-origin',
        }),
        options.signal
      );
    } catch (error) {
      if (options.signal?.aborted) throw cancelled(options.signal);
      throw new OwnedVp8LoadError('Owned VP8 WASM fetch failed', { cause: error });
    }
    if (
      !response.ok ||
      response.redirected ||
      response.type === 'opaque' ||
      response.type === 'opaqueredirect' ||
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
        'application/wasm' ||
      (response.url !== '' && new URL(response.url).origin !== assetUrl.origin)
    )
      throw new OwnedVp8LoadError('Owned VP8 WASM response is not a same-origin WASM asset');
    const declaredLength = response.headers.get('content-length');
    if (
      declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_ASSET_BYTES)
    )
      throw new OwnedVp8LoadError('Owned VP8 WASM declared size is invalid');
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedAsset(response, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw cancelled(options.signal);
      if (error instanceof OwnedVp8LoadError) throw error;
      throw new OwnedVp8LoadError('Owned VP8 WASM response stream failed', { cause: error });
    }
    if (options.signal?.aborted || options.isCurrent?.() === false) throw cancelled(options.signal);
    const initialPages = inspectMemoryDeclaration(bytes);
    let module: WebAssembly.Module;
    try {
      module = await awaitAbortable(WebAssembly.compile(bytes as BufferSource), options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw cancelled(options.signal);
      throw new OwnedVp8LoadError('Owned VP8 WASM compilation failed', { cause: error });
    }
    if (options.signal?.aborted || options.isCurrent?.() === false) throw cancelled(options.signal);
    if (WebAssembly.Module.imports(module).length !== 0)
      throw new OwnedVp8AbiError('Owned VP8 WASM has unexpected imports');
    compiled = { module, initialPages };
  }
  const initialReservedBytes = compiled.initialPages * COPY_CHUNK_BYTES;
  try {
    await options.accounting.reserve(initialReservedBytes, 0);
  } catch (error) {
    options.accounting.release();
    throw new OwnedVp8MemoryAdmissionError('Owned VP8 initial memory reservation failed', {
      cause: error,
    });
  }
  if (options.signal?.aborted || options.isCurrent?.() === false) {
    options.accounting.release();
    throw cancelled(options.signal);
  }
  let instance: WebAssembly.Instance;
  try {
    instance = new WebAssembly.Instance(compiled.module, {});
  } catch (error) {
    options.accounting.release();
    throw classifyFailure(error);
  }
  let encoder: OwnedVp8Encoder;
  try {
    encoder = new OwnedVp8Encoder(instance, options, initialReservedBytes);
  } catch (error) {
    options.accounting.release();
    throw classifyFailure(error);
  }
  if (
    instance.exports.memory instanceof WebAssembly.Memory &&
    instance.exports.memory.buffer.byteLength > initialReservedBytes
  ) {
    encoder.retire();
    throw new OwnedVp8MemoryAdmissionError('Owned VP8 grew memory before planning');
  }
  if (options.signal?.aborted || options.isCurrent?.() === false) {
    encoder.retire();
    throw cancelled(options.signal);
  }
  compiledModule = compiled;
  return encoder;
}
