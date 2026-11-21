// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vite-plus/test';

import { installRetainedWorkerProbe } from '../../../validation/windows/helpers/owned-vp8-owner-retention.ts';

class FakeMemory {
  buffer = new ArrayBuffer(65_536);
}

class FakeInstance {
  exports = {
    memory: new FakeMemory(),
    vp8_v2_begin: () => 10,
    vp8_v2_step: () => 0,
    vp8_v2_retire: () => 0,
  };
}

function realm(kind: 'dedicated' | 'window' | 'shared' | 'unsupported') {
  const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
  const sent: Array<{ message: unknown; transfer: unknown }> = [];
  const tasks: Array<() => void> = [];
  const nativePostMessage = (message: unknown, transfer: unknown) => {
    sent.push({ message, transfer });
  };
  const context: Record<string, unknown> = {
    WebAssembly: { Instance: FakeInstance, Memory: FakeMemory },
    addEventListener: (
      _type: string,
      listener: (event: { source: unknown; data: unknown }) => void
    ) => {
      listeners.push(listener);
    },
    postMessage: nativePostMessage,
    setTimeout: (callback: () => void, delay: number) => {
      expect(delay).toBe(0);
      tasks.push(callback);
      return tasks.length;
    },
  };
  if (kind === 'window') context.window = context;
  if (kind === 'shared') context.onconnect = null;
  if (kind === 'window' || kind === 'shared')
    context.DedicatedWorkerGlobalScope = class DedicatedWorkerGlobalScope {};
  if (kind === 'dedicated') {
    runInNewContext(
      'globalThis.DedicatedWorkerGlobalScope = class DedicatedWorkerGlobalScope {}; Object.setPrototypeOf(globalThis, globalThis.DedicatedWorkerGlobalScope.prototype)',
      context
    );
  }
  const install = runInNewContext(
    `(${installRetainedWorkerProbe.toString()})`,
    context
  ) as () => void;
  return {
    context,
    install,
    listeners,
    sent,
    nativePostMessage,
    runNextTask: () => tasks.shift()?.(),
  };
}

describe('retained Worker probe scope and parent channel', () => {
  it.each(['window', 'shared', 'unsupported'] as const)(
    'fails closed in a %s scope before changing WebAssembly or installing a listener',
    (kind) => {
      const { context, install, listeners, nativePostMessage } = realm(kind);
      const wasm = context.WebAssembly as { Instance: typeof FakeInstance };
      expect(() => install()).toThrow('requires a dedicated Worker scope');
      expect(wasm.Instance).toBe(FakeInstance);
      expect(context.postMessage).toBe(nativePostMessage);
      expect(listeners).toHaveLength(0);
      expect(context).not.toHaveProperty('__wmcVp8RetainedWorkerProbe');
    }
  );

  it('accepts parent start and preserves owned Instance instrumentation and terminal transfer', () => {
    const { context, install, listeners, sent, nativePostMessage } = realm('dedicated');
    install();
    expect(listeners).toHaveLength(1);
    const wasm = context.WebAssembly as { Instance: typeof FakeInstance };
    expect(wasm.Instance).not.toBe(FakeInstance);
    const instance = new wasm.Instance();
    const exports = instance.exports;
    expect(exports.vp8_v2_begin()).toBe(10);
    expect(exports.vp8_v2_step()).toBe(0);
    expect(exports.vp8_v2_retire()).toBe(0);

    listeners[0]!({ source: null, data: { type: 'start', requestId: 'parent-request' } });
    const probe = context.__wmcVp8RetainedWorkerProbe as {
      snapshot: () => {
        requestId: string | null;
        createdCount: number;
        records: Array<Record<string, unknown>>;
      };
    };
    expect(probe.snapshot()).toMatchObject({
      requestId: 'parent-request',
      createdCount: 1,
      records: [{ successfulBeginCalls: 1, stepCalls: 1, retireCalls: 1, retireStatus: 0 }],
    });

    const transfer = [new ArrayBuffer(8)];
    const complete = { type: 'complete', requestId: 'parent-request', output: 'unchanged' };
    (context.postMessage as typeof nativePostMessage)(complete, transfer);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.transfer).toBe(transfer);
    expect(sent[0]!.message).toMatchObject({
      ...complete,
      __wmcVp8RetainedWorkerSnapshot: { requestId: 'parent-request', createdCount: 1 },
    });
    expect(complete).not.toHaveProperty('__wmcVp8RetainedWorkerSnapshot');
  });

  it('rejects a foreign source before reading data or replacing the parent request ID', () => {
    const { context, install, listeners, sent, nativePostMessage } = realm('dedicated');
    install();
    const listener = listeners[0]!;
    listener({ source: null, data: { type: 'start', requestId: 'parent-request' } });
    for (const source of [{}, { postMessage: () => undefined }, { id: 'service-worker' }]) {
      listener({ source, data: { type: 'start', requestId: 'foreign-request' } });
    }
    listener({
      source: {},
      get data(): never {
        throw new Error('foreign data was read');
      },
    });
    const probe = context.__wmcVp8RetainedWorkerProbe as {
      snapshot: () => { requestId: string | null };
    };
    expect(probe.snapshot().requestId).toBe('parent-request');

    const unmatched = { type: 'complete', requestId: 'foreign-request' };
    (context.postMessage as typeof nativePostMessage)(unmatched, undefined);
    expect(sent[0]!.message).toBe(unmatched);
    expect(sent[0]!.transfer).toBeUndefined();
  });

  it('captures the actual parent abort before the later product handler retires ABI2', () => {
    const { context, install, listeners, sent, runNextTask } = realm('dedicated');
    install();
    const wasm = context.WebAssembly as { Instance: typeof FakeInstance };
    const instance = new wasm.Instance();
    instance.exports.vp8_v2_begin();
    instance.exports.vp8_v2_step();
    listeners[0]!({ source: null, data: { type: 'start', requestId: 'direct-1' } });
    listeners.push((event) => {
      if ((event.data as { type?: string }).type === 'abort') {
        expect(sent).toHaveLength(0);
        instance.exports.vp8_v2_retire();
      }
    });
    for (const listener of listeners)
      listener({ source: null, data: { type: 'abort', requestId: 'direct-1' } });
    expect(sent).toHaveLength(0);
    runNextTask();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toMatchObject({
      type: '__wmcVp8OwnerAbortObservation',
      requestId: 'direct-1',
      snapshot: {
        requestId: 'direct-1',
        records: [{ successfulBeginCalls: 1, stepCalls: 1, retireCalls: 0 }],
      },
    });
    const probe = context.__wmcVp8RetainedWorkerProbe as {
      snapshot: () => { records: Array<{ retireCalls: number }> };
    };
    expect(probe.snapshot().records[0]!.retireCalls).toBe(1);
    listeners[0]!({ source: null, data: { type: 'abort', requestId: 'other' } });
    expect(sent).toHaveLength(1);
  });
});
