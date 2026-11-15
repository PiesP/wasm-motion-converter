// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { Buffer } from 'node:buffer';

import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  assertDirectOwnerSnapshot,
  runDirectOwnerActiveTermination,
  runDirectOwnerCompletion,
  type DirectOwnerSnapshot,
} from '../../../validation/windows/helpers/owned-vp8-direct-owner.ts';

function snapshot(): DirectOwnerSnapshot {
  return {
    requestId: 'direct-1',
    createdCount: 1,
    records: [
      {
        id: 1,
        successfulBeginCalls: 1,
        stepCalls: 2,
        retireCalls: 1,
        retireStatus: 0,
        peakCapacityBytes: 65_536,
        retirementTimeCapacityBytes: 65_536,
      },
    ],
  };
}

describe('direct compiled Worker ABI evidence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of [
      '__wmcVp8DirectOwnerActiveWorker',
      '__wmcVp8WorkerLifecycle',
      '__wmcVp8RetainedWorkerProbe',
    ])
      Reflect.deleteProperty(globalThis, key);
  });

  function activeHarness(mode: 'live' | 'retired' | 'terminal') {
    const messages: Array<Record<string, unknown>> = [];
    const terminated: boolean[] = [];
    const record = { requestId: null as string | null, terminalType: null as string | null };
    Reflect.set(globalThis, '__wmcVp8WorkerLifecycle', { snapshot: () => [{ ...record }] });
    let reads = 0;
    Reflect.set(globalThis, '__wmcVp8RetainedWorkerProbe', {
      snapshot: () => {
        reads++;
        const result = snapshot();
        result.records[0]!.stepCalls = reads === 1 ? 0 : 1;
        if (mode === 'retired' && reads >= 2) {
          result.records[0]!.retireCalls = 1;
        } else {
          result.records[0]!.retireCalls = 0;
          result.records[0]!.retireStatus = null;
          result.records[0]!.retirementTimeCapacityBytes = null;
        }
        if (mode === 'terminal' && reads === 3) record.terminalType = 'complete';
        return result;
      },
    });
    let resolveWorker:
      | ((worker: { url: () => string; evaluate: (fn: () => unknown) => Promise<unknown> }) => void)
      | undefined;
    const workerEvent = new Promise<{
      url: () => string;
      evaluate: (fn: () => unknown) => Promise<unknown>;
    }>((resolve) => {
      resolveWorker = resolve;
    });
    class FakeWorker {
      private readonly listeners = new Map<string, Array<(event: { data: unknown }) => void>>();
      constructor(
        readonly url: string,
        readonly options: WorkerOptions
      ) {
        resolveWorker?.({ url: () => `https://fixture.test${url}`, evaluate: async (fn) => fn() });
        queueMicrotask(() => this.emit({ type: 'ready', requestId: '' }));
      }
      addEventListener(type: string, listener: (event: { data: unknown }) => void) {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
      }
      postMessage(message: Record<string, unknown>) {
        messages.push(message);
        if (message.type === 'start') record.requestId = message.requestId as string;
      }
      terminate() {
        terminated.push(true);
      }
      private emit(data: unknown) {
        for (const listener of this.listeners.get('message') ?? []) listener({ data });
      }
    }
    vi.stubGlobal('Worker', FakeWorker);
    const page = {
      waitForEvent: () => workerEvent,
      evaluate: async (callback: (arg: unknown) => unknown, arg: unknown) => callback(arg),
    } as unknown as Page;
    const request = {
      workerPath: 'assets/worker-ABC123.js',
      inputBase64: Buffer.from([1, 2, 3]).toString('base64'),
      requestId: 'direct-1',
      config: { codec: 'vp09' },
      options: { format: 'webp' },
    };
    return { page, request, messages, terminated };
  }

  it('terminates only after a live ABI step, without waiting for completed owned progress', async () => {
    const harness = activeHarness('live');
    const result = await runDirectOwnerActiveTermination(harness.page, harness.request);
    expect(result).toMatchObject({ requestId: 'direct-1', progressCount: 0, observedStepCalls: 1 });
    expect(harness.messages.map((message) => message.type)).toEqual(['start', 'abort']);
    expect(harness.terminated).toHaveLength(1);
  });

  it.each(['retired', 'terminal'] as const)(
    'rejects a %s Worker before direct termination',
    async (mode) => {
      const harness = activeHarness(mode);
      await expect(
        runDirectOwnerActiveTermination(harness.page, harness.request)
      ).rejects.toThrow();
      expect(harness.messages.map((message) => message.type)).toEqual(['start']);
      expect(harness.terminated).toHaveLength(1);
    }
  );

  it('sends a transferred start to one bundled Worker and returns its actual output', async () => {
    const sent: Array<{ message: Record<string, unknown>; transfer: Transferable[] | undefined }> =
      [];
    const terminated: boolean[] = [];
    class FakeWorker {
      private readonly listeners = new Map<string, Array<(event: { data: unknown }) => void>>();
      constructor(
        readonly url: string,
        readonly options: WorkerOptions
      ) {
        queueMicrotask(() => this.emit({ type: 'ready', requestId: '' }));
      }
      addEventListener(type: string, listener: (event: { data: unknown }) => void) {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
      }
      postMessage(message: Record<string, unknown>, transfer?: Transferable[]) {
        sent.push({ message, transfer });
        queueMicrotask(() => {
          this.emit({ type: 'progress', requestId: message.requestId, ownedVp8Steps: 1 });
          this.emit({
            type: 'complete',
            requestId: message.requestId,
            outputBuffer: Uint8Array.from([82, 73, 70, 70]).buffer,
            durationMs: 5,
          });
        });
      }
      terminate() {
        terminated.push(true);
      }
      private emit(data: unknown) {
        for (const listener of this.listeners.get('message') ?? []) listener({ data });
      }
    }
    vi.stubGlobal('Worker', FakeWorker);
    const page = {
      evaluate: (callback: (arg: unknown) => Promise<unknown>, arg: unknown) => callback(arg),
    } as unknown as Page;
    const result = await runDirectOwnerCompletion(page, {
      workerPath: 'assets/worker-ABC123.js',
      inputBase64: Buffer.from([1, 2, 3]).toString('base64'),
      requestId: 'direct-1',
      config: { codec: 'vp09' },
      options: { format: 'webp' },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toMatchObject({ type: 'start', requestId: 'direct-1' });
    expect(sent[0]!.transfer).toEqual([sent[0]!.message.inputBuffer]);
    expect(result).toMatchObject({
      requestId: 'direct-1',
      progressCount: 1,
      ownedProgressCount: 1,
      output: [82, 73, 70, 70],
    });
    expect(terminated).toHaveLength(1);
  });

  it('accepts a complete request with matched owned begin, step, retirement and capacity', () => {
    expect(() => assertDirectOwnerSnapshot(snapshot(), 'direct-1', true)).not.toThrow();
  });

  it('accepts active pre-termination activity without pretending it retired', () => {
    const active = snapshot();
    active.records[0]!.retireCalls = 0;
    active.records[0]!.retireStatus = null;
    active.records[0]!.retirementTimeCapacityBytes = null;
    expect(() => assertDirectOwnerSnapshot(active, 'direct-1', false)).not.toThrow();
    expect(() => assertDirectOwnerSnapshot(active, 'direct-1', true)).toThrow();
    active.records[0]!.retireCalls = 1;
    expect(() => assertDirectOwnerSnapshot(active, 'direct-1', false)).toThrow();
  });

  it('rejects an unmatched request, missing step, incomplete inventory and oversized linear capacity', () => {
    expect(() => assertDirectOwnerSnapshot(null, 'direct-1', true)).toThrow();
    expect(() => assertDirectOwnerSnapshot(snapshot(), 'other', true)).toThrow();
    const noStep = snapshot();
    noStep.records[0]!.stepCalls = 0;
    expect(() => assertDirectOwnerSnapshot(noStep, 'direct-1', false)).toThrow();
    const incomplete = snapshot();
    incomplete.createdCount = 2;
    expect(() => assertDirectOwnerSnapshot(incomplete, 'direct-1', true)).toThrow();
    const tooLarge = snapshot();
    tooLarge.records[0]!.peakCapacityBytes = 192 * 1024 * 1024 + 1;
    expect(() => assertDirectOwnerSnapshot(tooLarge, 'direct-1', true)).toThrow();
  });
});
