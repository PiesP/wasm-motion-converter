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

function realm(extra: Record<string, unknown>, scope: 'page' | 'dedicated' | 'shared' = 'page') {
  const context: Record<string, unknown> = {
    WebAssembly: { Instance: FakeInstance, Memory: FakeMemory },
    Uint8Array: FakeBytes,
    WeakRef,
    WeakSet,
    Worker: FakeWorker,
    ...extra,
  };
  if (scope === 'page') context.document = {};
  if (scope === 'dedicated')
    runInNewContext(
      'globalThis.DedicatedWorkerGlobalScope = class {}; Object.setPrototypeOf(globalThis, DedicatedWorkerGlobalScope.prototype)',
      context
    );
  if (scope === 'shared') context.onconnect = null;
  const install = runInNewContext(`(${installVp8TimingProbe.toString()})`, context) as () => void;
  install();
  return context;
}

const requestId = '11111111-2222-4333-8444-555555555555';
function workerState() {
  return {
    epoch: requestId,
    ownedInstances: 0,
    successfulBeginCalls: 0,
    stepCalls: 0,
    retireCalls: 0,
    inputCopyBytes: 0,
    outputCopyBytes: 0,
    inputCopyEvents: 0,
    outputCopyEvents: 0,
    unknownCopyKinds: 0,
    legacyIndexedCopyEvents: 0,
    peakLinearCapacityBytes: 0,
    capacityAtJobEndBytes: 0,
    workerStarts: 0,
    workerCompletions: 0,
    workerErrors: 0,
    staleWorkerEvents: 0,
  };
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
  worker.postMessage({ type: 'start', requestId });
  let productMessage: Record<string, unknown> | null = null;
  worker.onmessage = (event) => {
    productMessage = event.data as Record<string, unknown>;
  };
  const numeric = { ...workerState(), successfulBeginCalls: 1 };
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
  assert.equal(observed.workerSnapshotStatus, 'valid');
  assert.equal((observed.workerObservation as { state: typeof numeric }).state.epoch, requestId);
  assert.equal(probe.snapshot('unique-epoch').epochMatches, false);
});

test('malformed worker metadata never reaches product or receipt', () => {
  const variants: Array<[string, Record<string, unknown>]> = [
    ['extra private field', { ...workerState(), privatePixels: [1, 2] }],
    ['typed array field', { ...workerState(), pixels: new Uint8Array([1, 2]) }],
    ['nonfinite counter', { ...workerState(), inputCopyBytes: Number.NaN }],
    ['oversized counter', { ...workerState(), inputCopyBytes: Number.MAX_SAFE_INTEGER + 1 }],
    ['wrong epoch', { ...workerState(), epoch: 'wrong' }],
  ];
  for (const [label, state] of variants) {
    const context = realm({});
    const probe = context.__wmcVp8TimingProbe as {
      begin: (epoch: string) => void;
      snapshot: (epoch: string) => Record<string, unknown>;
    };
    probe.begin('job');
    const worker = new (context.Worker as typeof FakeWorker)('worker.js');
    worker.postMessage({ type: 'start', requestId });
    const outputBuffer = new ArrayBuffer(4);
    let productMessage: Record<string, unknown> | null = null;
    worker.onmessage = (event) => {
      productMessage = event.data as Record<string, unknown>;
    };
    worker.emit({ type: 'complete', requestId, outputBuffer, __wmcVp8TimingSnapshot: state });
    assert(productMessage, label);
    const delivered = productMessage as Record<string, unknown>;
    assert.equal(delivered.outputBuffer, outputBuffer, label);
    assert.equal('__wmcVp8TimingSnapshot' in delivered, false, label);
    const observed = probe.snapshot('job');
    assert.equal(observed.workerSnapshotStatus, 'invalid', label);
    assert.equal(observed.workerObservation, null, label);
    const receipt = JSON.stringify(observed);
    assert(!receipt.includes('privatePixels') && !receipt.includes('pixels'), label);
  }
});

test('stale and mismatched completions strip reserved metadata before product handler', () => {
  for (const mode of ['stale', 'mismatched'] as const) {
    const context = realm({});
    const probe = context.__wmcVp8TimingProbe as {
      begin: (epoch: string) => void;
      snapshot: (epoch: string) => Record<string, unknown>;
    };
    probe.begin('first-job');
    const worker = new (context.Worker as typeof FakeWorker)('worker.js');
    worker.postMessage({ type: 'start', requestId });
    if (mode === 'stale') probe.begin('second-job');
    let productMessage: Record<string, unknown> | null = null;
    worker.onmessage = (event) => {
      productMessage = event.data as Record<string, unknown>;
    };
    worker.emit({
      type: 'complete',
      requestId: mode === 'mismatched' ? 'other-request' : requestId,
      __wmcVp8TimingSnapshot: workerState(),
    });
    assert(productMessage);
    assert.equal('__wmcVp8TimingSnapshot' in productMessage, false);
    const observed = probe.snapshot(mode === 'stale' ? 'second-job' : 'first-job');
    assert.equal(observed.workerObservation, null);
    assert.equal(observed.workerSnapshotStatus, mode === 'stale' ? 'none' : 'invalid');
    assert.equal(observed.staleWorkerEvents, mode === 'stale' ? 1 : 0);
  }
});

test('timing probe refuses a shared Worker scope before instrumenting it', () => {
  const wasm = { Instance: FakeInstance, Memory: FakeMemory };
  assert.throws(
    () => realm({ WebAssembly: wasm }, 'shared'),
    /requires a page or a dedicated Worker/
  );
  assert.equal(wasm.Instance, FakeInstance);
});

test('worker prefix admits owner messages and adds only bounded state to the completion transfer', () => {
  type Input = { data: unknown; isTrusted: boolean; origin: string; source: unknown };
  const handlers: Array<(event: Input) => void> = [];
  const sent: Array<{ message: Record<string, unknown>; transfer?: unknown }> = [];
  const context = realm(
    {
      addEventListener: (_type: string, handler: (event: Input) => void) => handlers.push(handler),
      postMessage: (message: Record<string, unknown>, transfer?: unknown) =>
        sent.push({ message, transfer }),
    },
    'dedicated'
  );
  const owner = { isTrusted: true, origin: '', source: null };
  handlers[0]!({ ...owner, data: { type: 'start', requestId } });
  for (const other of [{ origin: 'https://example.test' }, { source: {} }, { isTrusted: false }]) {
    handlers[0]!({
      ...owner,
      ...other,
      get data(): never {
        throw new Error('Read a message outside the owner channel');
      },
    });
  }
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
