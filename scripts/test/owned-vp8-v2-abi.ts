/** Development driver for the actual ABI2 module. Mutable instances belong to one job. */
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';

export type Vp8Request = {
  width: number;
  height: number;
  stride: number;
  layout: number;
  quality: number;
  outputLimit?: number;
  externalLiveBytes?: number;
  retainedOutputBytes?: number;
};
export type Vp8Record = {
  status: number;
  phase: number;
  generation: number;
  frame: number;
  inputPointer: number;
  inputLength: number;
  outputPointer: number;
  outputLength: number;
  capacity: number;
  admittedCapacity: number;
  aggregateBytes: number;
  stage: number;
  done: number;
  total: number;
};
export interface Vp8Exports {
  memory: { buffer: ArrayBuffer };
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
const runtime = (
  globalThis as unknown as {
    WebAssembly: {
      Module: { new (bytes: Uint8Array): object; imports(module: object): unknown[] };
      Instance: new (module: object, imports: object) => { exports: Record<string, unknown> };
    };
  }
).WebAssembly;
export type CompiledVp8 = { module: object; sha256: string };
export type MaxStepMetadata = {
  before: Pick<Vp8Record, 'phase' | 'stage' | 'done' | 'total' | 'status'>;
  after: Pick<Vp8Record, 'phase' | 'stage' | 'done' | 'total' | 'status'>;
};
export function compileVp8(bytes: Uint8Array): CompiledVp8 {
  const module = new runtime.Module(bytes);
  if (runtime.Module.imports(module).length !== 0)
    throw new Error('Owned VP8 imports an external runtime');
  return { module, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export class Vp8AbiStatusError extends Error {
  readonly record: Vp8Record;
  constructor(record: Vp8Record) {
    super(`Owned VP8 ABI2 status ${record.status}, stage ${record.stage}, phase ${record.phase}`);
    this.name = 'Vp8AbiStatusError';
    this.record = record;
  }
}

export class Vp8TestJob {
  readonly api: Vp8Exports;
  private frame = 0;
  private retired = false;
  readonly generation: number;
  constructor(compiled: CompiledVp8, generation = 1) {
    this.generation = generation;
    const instance = new runtime.Instance(compiled.module, {});
    this.api = instance.exports as unknown as Vp8Exports;
    for (const name of [
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
    ])
      if (typeof instance.exports[name] !== 'function')
        throw new Error(`Missing VP8 ABI2 export ${name}`);
    if (
      this.api.vp8_v2_abi_version() !== 2 ||
      !Number.isInteger(generation) ||
      generation <= 0 ||
      generation > 0xffff_ffff
    ) {
      throw new Error('Unsupported VP8 ABI/generation');
    }
  }
  record(): Vp8Record {
    const pointer = this.api.vp8_v2_response_ptr();
    const view = this.view(pointer, 96);
    const words = new DataView(view.buffer, view.byteOffset, view.byteLength);
    if (words.getUint32(0, true) !== 2) throw new Error('Invalid VP8 response version');
    const value = (index: number): number => words.getUint32(index * 4, true);
    return {
      status: value(1),
      phase: value(2),
      generation: value(3),
      frame: value(4),
      inputPointer: value(5),
      inputLength: value(6),
      outputPointer: value(7),
      outputLength: value(8),
      capacity: value(9),
      admittedCapacity: value(10),
      aggregateBytes: value(11),
      stage: value(12),
      done: value(13),
      total: value(14),
    };
  }
  private view(pointer: number, length: number): Uint8Array {
    if (
      !Number.isSafeInteger(pointer) ||
      !Number.isSafeInteger(length) ||
      pointer <= 0 ||
      length < 0 ||
      pointer + length > this.api.memory.buffer.byteLength
    ) {
      throw new Error('Invalid VP8 ABI extent');
    }
    return new Uint8Array(this.api.memory.buffer, pointer, length);
  }
  private checked(status: number, allowed: readonly number[]): Vp8Record {
    const record = this.record();
    if (record.status !== status) throw new Error('Inconsistent VP8 status record');
    if (!allowed.includes(status)) throw new Vp8AbiStatusError(record);
    if (record.generation !== this.generation || record.frame !== this.frame)
      throw new Error('Stale VP8 publication');
    if (
      record.capacity !== this.api.memory.buffer.byteLength ||
      (record.phase !== 0 && record.phase !== 6 && record.capacity > record.admittedCapacity)
    )
      throw new Error('VP8 exceeded admitted linear capacity');
    return record;
  }
  retire(): void {
    this.api.vp8_v2_retire();
    this.retired = true;
  }
  async encode(
    pixels: Uint8Array,
    request: Vp8Request,
    signal?: AbortSignal,
    onStep?: (record: Vp8Record) => void
  ): Promise<{
    bytes: Uint8Array;
    capacity: number;
    steps: number;
    maxStepMs: number;
    maxStepMetadata: MaxStepMetadata | null;
  }> {
    if (this.retired || this.frame === 0xffff_ffff) throw new Error('VP8 instance is retired');
    this.frame++;
    const frame = this.frame;
    let lease: 'none' | 'input' | 'output' = 'none';
    let steps = 0;
    let maxStepMs = 0;
    let maxStepMetadata: MaxStepMetadata | null = null;
    let deadline = performance.now() + 4;
    const tick = async (): Promise<void> => {
      signal?.throwIfAborted();
      if (performance.now() >= deadline) {
        await setImmediate();
        deadline = performance.now() + 4;
      }
      signal?.throwIfAborted();
    };
    try {
      signal?.throwIfAborted();
      const words = [
        2,
        request.width,
        request.height,
        request.stride,
        request.layout,
        request.quality,
        pixels.length,
        request.outputLimit ?? 96 * 1024 * 1024,
        this.generation,
        frame,
        request.externalLiveBytes ?? pixels.byteLength,
        request.retainedOutputBytes ?? 0,
      ];
      if (words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff_ffff))
        throw new Error('VP8 request is not fixed-width');
      const record = this.view(this.api.vp8_v2_request_ptr(), 48);
      const requestView = new DataView(record.buffer, record.byteOffset, record.byteLength);
      words.forEach((word, index) => requestView.setUint32(index * 4, word, true));
      this.checked(this.api.vp8_v2_plan(), [0]);
      let input: Vp8Record;
      for (;;) {
        input = this.checked(this.api.vp8_v2_reserve_step(this.generation, frame), [0, 10]);
        if (input.status === 0) break;
        await tick();
      }
      lease = 'input';
      if (input.inputLength !== pixels.length) throw new Error('VP8 input lease length changed');
      const destination = this.view(input.inputPointer, input.inputLength);
      const buffer = destination.buffer;
      for (let offset = 0; offset < pixels.length; offset += 65_536) {
        destination.set(pixels.subarray(offset, offset + 65_536), offset);
        await tick();
        if (buffer !== this.api.memory.buffer)
          throw new Error('VP8 memory grew during an input write');
      }
      // Every input copy settled before begin relinquishes the destination lease.
      lease = 'none';
      let beforeStep = this.checked(this.api.vp8_v2_begin(this.generation, frame), [10]);
      let output: Vp8Record;
      for (;;) {
        const start = performance.now();
        const status = this.api.vp8_v2_step(this.generation, frame);
        const stepMs = performance.now() - start;
        output = this.checked(status, [10, 11]);
        if (stepMs > maxStepMs) {
          maxStepMs = stepMs;
          const progress = (record: Vp8Record) => ({
            phase: record.phase,
            stage: record.stage,
            done: record.done,
            total: record.total,
            status: record.status,
          });
          maxStepMetadata = { before: progress(beforeStep), after: progress(output) };
        }
        onStep?.(output);
        beforeStep = output;
        if (++steps > 1_000_000) throw new Error('VP8 step protocol did not terminate');
        if (status === 11) break;
        await tick();
      }
      lease = 'output';
      signal?.throwIfAborted();
      if (output.outputLength <= 10) throw new Error('VP8 finalized frame is empty');
      const source = this.view(output.outputPointer, output.outputLength);
      const result = new Uint8Array(source.length);
      for (let offset = 0; offset < result.length; offset += 65_536) {
        result.set(source.subarray(offset, offset + 65_536), offset);
        await tick();
        if (source.buffer !== this.api.memory.buffer)
          throw new Error('VP8 memory grew during an output copy');
      }
      this.checked(this.api.vp8_v2_release_output(this.generation, frame), [0]);
      lease = 'none';
      return {
        bytes: result,
        capacity: this.api.memory.buffer.byteLength,
        steps,
        maxStepMs,
        maxStepMetadata,
      };
    } catch (error) {
      // No copies remain physically pending: all writes above finish before tick.
      this.api.vp8_v2_abort(this.generation, frame);
      if (lease === 'input') this.api.vp8_v2_release_input(this.generation, frame);
      if (lease === 'output') this.api.vp8_v2_release_output(this.generation, frame);
      this.retire();
      throw error;
    }
  }
}
