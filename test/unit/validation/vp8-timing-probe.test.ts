import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { test } from 'vite-plus/test';

import { installVp8TimingProbe } from '../../../validation/windows/vp8-timing-probe.ts';

class FakeMemory {
  buffer = new ArrayBuffer(64);
  grow() {
    const old = this.buffer.byteLength;
    this.buffer = new ArrayBuffer(old + 64);
    return old;
  }
}
class FakeInstance {
  exports = {
    memory: new FakeMemory(),
    vp8_v2_begin: () => 10,
    vp8_v2_step: () => 1,
    vp8_v2_retire: () => 0,
  };
}
class FakeBytes extends Uint8Array {}
class FakeWorker extends EventTarget {
  onmessage: ((event: Event & { data: unknown }) => void) | null = null;
  lastMessage: unknown;
  constructor(_url: string | URL, _options?: WorkerOptions) {
    super();
  }
  postMessage(message: unknown) {
    this.lastMessage = message;
  }
  emit(data: Record<string, unknown>) {
    const event = new Event('message') as Event & { data: unknown };
    Object.defineProperty(event, 'data', { value: data });
    this.dispatchEvent(event);
    this.onmessage?.(event);
  }
}

function realm(extra: Record<string, unknown>) {
  const context: Record<string, unknown> = {
    WebAssembly: { Instance: FakeInstance, Memory: FakeMemory },
    Uint8Array: FakeBytes,
    WeakRef,
    WeakSet,
    Worker: FakeWorker,
    document: {},
    ...extra,
  };
  const install = runInNewContext(`(${installVp8TimingProbe.toString()})`, context) as () => void;
  install();
  return context;
}

test('validation listener strips fixed worker snapshot before product handler', () => {
  const context = realm({});
  const probe = context.__wmcVp8TimingProbe as {
    begin: (epoch: string) => void;
    snapshot: (epoch: string) => Record<string, unknown>;
  };
  probe.begin('unique-epoch');
  const WorkerClass = context.Worker as typeof FakeWorker;
  const worker = new WorkerClass('worker.js');
  const requestId = '11111111-2222-4333-8444-555555555555';
  worker.postMessage({ type: 'start', requestId });
  let productMessage: Record<string, unknown> | null = null;
  worker.onmessage = (event) => {
    productMessage = event.data as Record<string, unknown>;
  };
  const numeric = { epoch: requestId, successfulBeginCalls: 1 };
  worker.emit({
    type: 'complete',
    requestId,
    outputBuffer: new ArrayBuffer(4),
    __wmcVp8TimingSnapshot: numeric,
  });
  assert(productMessage);
  assert.equal('__wmcVp8TimingSnapshot' in productMessage, false);
  const observed = probe.snapshot('unique-epoch');
  assert.equal(observed.workerCompletions, 1);
  assert.equal((observed.workerObservation as { state: typeof numeric }).state.epoch, requestId);
  assert.equal(probe.snapshot('unique-epoch').epochMatches, false);
});

test('worker prefix adds only bounded scalar state to existing completion transfer', () => {
  const handlers: Array<(event: { data: unknown }) => void> = [];
  const sent: Array<{ message: Record<string, unknown>; transfer?: unknown }> = [];
  const context = realm({
    document: undefined,
    addEventListener: (_type: string, handler: (event: { data: unknown }) => void) =>
      handlers.push(handler),
    postMessage: (message: Record<string, unknown>, transfer?: unknown) =>
      sent.push({ message, transfer }),
  });
  const requestId = '11111111-2222-4333-8444-555555555555';
  handlers[0]!({ data: { type: 'start', requestId } });
  const transfer = [new ArrayBuffer(4)];
  const complete = { type: 'complete', requestId, outputBuffer: transfer[0] };
  (context.postMessage as (message: unknown, transfer: unknown) => void)(complete, transfer);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.transfer, transfer);
  assert.equal(sent[0]!.message.outputBuffer, transfer[0]);
  assert.equal('__wmcVp8TimingSnapshot' in complete, false);
  const snapshot = sent[0]!.message.__wmcVp8TimingSnapshot as Record<string, unknown>;
  assert.equal(snapshot.epoch, requestId);
  assert(JSON.stringify(snapshot).length < 1024);
});

test('owned ABI and successful memory-boundary copies are counted without retaining pixels', () => {
  const context = realm({});
  const probe = context.__wmcVp8TimingProbe as {
    begin: (epoch: string) => void;
    snapshot: (epoch: string) => Record<string, number>;
  };
  probe.begin('owned-job');
  const Instance = (context.WebAssembly as { Instance: typeof FakeInstance }).Instance;
  const instance = new Instance();
  const exports = instance.exports;
  const Bytes = context.Uint8Array as typeof FakeBytes;
  const wasm = new Bytes(exports.memory.buffer);
  wasm.set(new Bytes([1, 2, 3, 4]));
  exports.vp8_v2_begin();
  exports.vp8_v2_step();
  const copied = new Bytes(wasm.subarray(0, 4));
  assert.deepEqual([...copied], [1, 2, 3, 4]);
  exports.vp8_v2_retire();
  const result = probe.snapshot('owned-job');
  assert.equal(result.successfulBeginCalls, 1);
  assert.equal(result.stepCalls, 1);
  assert.equal(result.retireCalls, 1);
  assert.equal(result.inputCopyBytes, 4);
  assert.equal(result.outputCopyBytes, 4);
  assert.equal(result.peakLinearCapacityBytes, 64);
});

test('legacy callback admits only a completed in-range indexed heap copy', () => {
  const context = realm({});
  const probe = context.__wmcVp8TimingProbe as {
    begin: (epoch: string) => void;
    snapshot: (epoch: string) => Record<string, number>;
  };
  const legacyCopy = context.__wmcVp8LegacyCopy as (
    heap: Uint8Array,
    memory: FakeMemory,
    offset: number,
    iterations: number,
    source: Uint8Array
  ) => void;
  probe.begin('legacy-job');
  const memory = new FakeMemory();
  const Bytes = context.Uint8Array as typeof FakeBytes;
  const heap = new Bytes(memory.buffer);
  const input = new Bytes([8, 9, 10]);
  let completed = 0;
  for (; completed < input.length; completed++) heap[4 + completed] = input[completed]!;
  legacyCopy(heap, memory, 4, completed, input);
  new Bytes(heap.subarray(4, 7));
  legacyCopy(heap, memory, 62, 3, input);
  const result = probe.snapshot('legacy-job');
  assert.equal(result.legacyIndexedCopyEvents, 1);
  assert.equal(result.inputCopyBytes, 3);
  assert.equal(result.outputCopyBytes, 3);
  assert.equal(result.unknownCopyKinds, 1);
});
