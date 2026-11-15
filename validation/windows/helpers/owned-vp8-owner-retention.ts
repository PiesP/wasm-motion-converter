// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { CDPSession, Page } from '@playwright/test';

export const OWNER_RETENTION_SCENARIO = 'owned-vp8-owner-retention';

/** Runs in the conversion Worker, in functional sessions only. */
export function installRetainedWorkerProbe() {
  const DedicatedScope = Reflect.get(globalThis, 'DedicatedWorkerGlobalScope');
  if (typeof DedicatedScope !== 'function' || !(globalThis instanceof DedicatedScope))
    throw new Error('Retained Worker probe requires a dedicated Worker scope');
  const marker = '__wmcVp8RetainedWorkerSnapshot';
  const abortObservationType = '__wmcVp8OwnerAbortObservation';
  const NativeInstance = WebAssembly.Instance;
  let requestId: string | null = null;
  const records: Array<{
    id: number;
    successfulBeginCalls: number;
    stepCalls: number;
    retireCalls: number;
    retireStatus: number | null;
    peakCapacityBytes: number;
    retirementTimeCapacityBytes: number | null;
  }> = [];
  const worker = globalThis as unknown as {
    postMessage: (message: unknown, transfer?: Transferable[]) => void;
  };
  const nativePostMessage = worker.postMessage;
  const snapshot = () => ({
    requestId,
    createdCount: records.length,
    records: records.map((record) => ({ ...record })),
  });
  let abortObserved = false;
  WebAssembly.Instance = new Proxy(NativeInstance, {
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget);
      const exported = instance.exports as Record<string, unknown>;
      if (typeof exported.vp8_v2_step !== 'function') return instance;
      if (!(exported.memory instanceof WebAssembly.Memory) || records.length >= 32)
        throw new Error('Retained Worker probe cannot account for owned Memory');
      const memory = exported.memory;
      const record = {
        id: records.length + 1,
        successfulBeginCalls: 0,
        stepCalls: 0,
        retireCalls: 0,
        retireStatus: null as number | null,
        peakCapacityBytes: memory.buffer.byteLength,
        retirementTimeCapacityBytes: null as number | null,
      };
      records.push(record);
      const wrapped = Object.fromEntries(
        Object.entries(exported).map(([key, value]) => [
          key,
          key === 'vp8_v2_begin' && typeof value === 'function'
            ? (...parameters: unknown[]) => {
                const status = Reflect.apply(value, exported, parameters) as number;
                if (status === 10) record.successfulBeginCalls++;
                return status;
              }
            : key === 'vp8_v2_step' && typeof value === 'function'
              ? (...parameters: unknown[]) => {
                  const status = Reflect.apply(value, exported, parameters) as number;
                  record.stepCalls++;
                  record.peakCapacityBytes = Math.max(
                    record.peakCapacityBytes,
                    memory.buffer.byteLength
                  );
                  return status;
                }
              : key === 'vp8_v2_retire' && typeof value === 'function'
                ? (...parameters: unknown[]) => {
                    const status = Reflect.apply(value, exported, parameters) as number;
                    record.retireCalls++;
                    record.retireStatus = status;
                    record.retirementTimeCapacityBytes = memory.buffer.byteLength;
                    return status;
                  }
                : value,
        ])
      );
      return new Proxy(instance, {
        get(source, key) {
          return key === 'exports' ? wrapped : Reflect.get(source, key);
        },
      });
    },
  });
  globalThis.addEventListener('message', (event: MessageEvent) => {
    // Worker.postMessage uses the dedicated Worker's implicit port, which has no source.
    if (event.source !== null) return;
    const message = event.data as { type?: unknown; requestId?: unknown } | null;
    if (message?.type === 'start' && typeof message.requestId === 'string' && requestId === null)
      requestId = message.requestId;
    if (
      message?.type === 'abort' &&
      requestId !== null &&
      message.requestId === requestId &&
      !abortObserved
    ) {
      abortObserved = true;
      // This prefix listener was registered before the bundled Worker's onmessage.
      // Capture before its abort handler or later encoding cleanup can retire ABI2.
      nativePostMessage.call(worker, {
        type: abortObservationType,
        requestId,
        snapshot: snapshot(),
      });
    }
  });
  Reflect.set(globalThis, '__wmcVp8RetainedWorkerProbe', {
    snapshot,
  });
  worker.postMessage = function (message: unknown, transfer?: Transferable[]) {
    const response = message as { type?: unknown; requestId?: unknown } | null;
    if (
      (response?.type === 'complete' || response?.type === 'error') &&
      response.requestId === requestId
    ) {
      return nativePostMessage.call(
        worker,
        {
          ...response,
          [marker]: snapshot(),
        },
        transfer
      );
    }
    return nativePostMessage.call(worker, message, transfer);
  };
}

/** Observes actual product Worker identity and termination without keeping a Worker. */
export function installWorkerLifecycleObserver() {
  const marker = '__wmcVp8RetainedWorkerSnapshot';
  const NativeWorker = Worker;
  const records: Array<{
    id: number;
    requestId: string | null;
    createdAtMs: number;
    terminalType: string | null;
    terminalSnapshot: unknown;
    terminatedAtMs: number | null;
    invalidSnapshot: boolean;
  }> = [];
  globalThis.Worker = class ObservedWorker extends NativeWorker {
    private readonly record: (typeof records)[number] | null;
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      const path = new URL(String(url), location.href).pathname;
      this.record = /^\/assets\/worker-[\w-]+\.js$/.test(path)
        ? {
            id: records.length + 1,
            requestId: null,
            createdAtMs: performance.now(),
            terminalType: null,
            terminalSnapshot: null,
            terminatedAtMs: null,
            invalidSnapshot: false,
          }
        : null;
      if (this.record) records.push(this.record);
      this.addEventListener('message', (event) => {
        if (!this.record) return;
        const response = event.data as Record<string, unknown> | null;
        if (!response || (response.type !== 'complete' && response.type !== 'error')) return;
        this.record.terminalType = response.type;
        const snapshot = Object.getOwnPropertyDescriptor(response, marker);
        if (!snapshot || !('value' in snapshot) || !Reflect.deleteProperty(response, marker)) {
          this.record.invalidSnapshot = true;
          event.stopImmediatePropagation();
          return;
        }
        this.record.terminalSnapshot = snapshot.value;
      });
    }
    override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      const request = message as { type?: unknown; requestId?: unknown } | null;
      if (this.record && request?.type === 'start') {
        if (this.record.requestId !== null || typeof request.requestId !== 'string')
          this.record.invalidSnapshot = true;
        else this.record.requestId = request.requestId;
      }
      return transfer === undefined
        ? super.postMessage(message)
        : super.postMessage(message, transfer as Transferable[]);
    }
    override terminate() {
      if (this.record) this.record.terminatedAtMs = performance.now();
      return super.terminate();
    }
  };
  Reflect.set(globalThis, '__wmcVp8WorkerLifecycle', {
    snapshot: () => records.map((record) => ({ ...record })),
  });
}

export type CapacityRecord = {
  id: number;
  successfulBeginCalls: number;
  stepCalls: number;
  retireCalls: number;
  retireStatus: number | null;
  peakCapacityBytes: number;
  retirementTimeCapacityBytes: number | null;
  instanceLive?: boolean;
  wrapperLive?: boolean;
  memoryLive?: boolean;
};
export type Checkpoint = {
  status: 'ok' | 'unverified';
  requests: Array<{ elapsedMs: number; success: boolean; error?: string }>;
  inventory: CapacityRecord[] | null;
  liveInstanceCount: number | null;
  liveMemoryCount: number | null;
  liveMutableCapacityBytes: number | null;
  timeOriginBefore: number | null;
  timeOriginAfter: number | null;
  error?: string;
};

/** A page CDP GC opportunity, with no weakref dereference until a later task. */
export async function collectGarbageCheckpoint(page: Page): Promise<Checkpoint> {
  const result: Checkpoint = {
    status: 'unverified',
    requests: [],
    inventory: null,
    liveInstanceCount: null,
    liveMemoryCount: null,
    liveMutableCapacityBytes: null,
    timeOriginBefore: null,
    timeOriginAfter: null,
  };
  let session: CDPSession | undefined;
  try {
    result.timeOriginBefore = await page.evaluate(() => performance.timeOrigin);
    session = await page.context().newCDPSession(page);
    for (let index = 0; index < 3; index++) {
      if (index)
        await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
      const started = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          session.send('HeapProfiler.collectGarbage'),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('CDP collection timeout')), 5_000);
          }),
        ]);
        result.requests.push({ elapsedMs: performance.now() - started, success: true });
      } catch (error) {
        result.requests.push({
          elapsedMs: performance.now() - started,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
    result.inventory = await page.evaluate(() => {
      const probe = Reflect.get(globalThis, '__wmcVp8AbiProbe') as
        | { inventory: () => CapacityRecord[] }
        | undefined;
      if (!probe) throw new Error('Owned ABI weakref inventory unavailable');
      return probe.inventory();
    });
    result.liveInstanceCount = result.inventory.filter((record) => record.instanceLive).length;
    result.liveMemoryCount = result.inventory.filter((record) => record.memoryLive).length;
    result.liveMutableCapacityBytes = result.inventory.reduce(
      (sum, record) => sum + (record.memoryLive ? (record.retirementTimeCapacityBytes ?? 0) : 0),
      0
    );
    result.timeOriginAfter = await page.evaluate(() => performance.timeOrigin);
    if (result.timeOriginBefore !== result.timeOriginAfter)
      throw new Error('Document changed during GC checkpoint');
    result.status = 'ok';
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (session) {
      try {
        await session.detach();
      } catch (error) {
        result.status = 'unverified';
        result.error = error instanceof Error ? error.message : String(error);
      }
    }
  }
  return result;
}

type MainAttempt = {
  kind: string;
  createdCount: number;
  checkpoint: Checkpoint;
  ownerReleased: boolean;
  outputBytes?: number;
};
type WorkerAttempt = {
  kind: string;
  id: number;
  requestId: string | null;
  terminalType: string | null;
  terminatedAtMs: number | null;
  closeAtMs: number | null;
  closeObserved: boolean;
  closeCapability: boolean;
  openAfterTimeout?: boolean | null;
  snapshot: { requestId: string | null; createdCount: number; records: CapacityRecord[] } | null;
  preCloseMutableCapacityBytes?: number | null;
  postCloseReachableCapacityBytes?: number | null;
  outputBytes?: number;
};
export type OwnerRetentionEvidence = {
  moduleCacheExcluded: boolean;
  negativeControl: { held: Checkpoint; released: Checkpoint } | null;
  main: MainAttempt[];
  worker: WorkerAttempt[];
};

/** Pure decision rule. Missing or ambiguous evidence never passes. */
export function verifyOwnerRetention(evidence: OwnerRetentionEvidence): {
  status: 'PASS' | 'FAIL' | 'UNVERIFIED';
  reasons: string[];
} {
  const unknown: string[] = [];
  const failed: string[] = [];
  const checkpointComplete = (checkpoint: Checkpoint) =>
    checkpoint.status === 'ok' &&
    checkpoint.requests.length === 3 &&
    checkpoint.requests.every(
      (request) => request.success && Number.isFinite(request.elapsedMs) && request.elapsedMs >= 0
    ) &&
    checkpoint.timeOriginBefore !== null &&
    checkpoint.timeOriginBefore === checkpoint.timeOriginAfter &&
    checkpoint.inventory !== null;
  const validRecords = (records: CapacityRecord[], createdCount: number, label: string) => {
    if (
      !Number.isSafeInteger(createdCount) ||
      createdCount < 1 ||
      records.length !== createdCount ||
      new Set(records.map((record) => record.id)).size !== createdCount ||
      records.some(
        (record) => !Number.isSafeInteger(record.id) || record.id < 1 || record.id > createdCount
      )
    )
      unknown.push(`${label}: duplicate or missing owned instance ID`);
    for (const record of records) {
      if (
        !Number.isSafeInteger(record.peakCapacityBytes) ||
        record.peakCapacityBytes <= 0 ||
        record.peakCapacityBytes > 192 * 1024 * 1024 ||
        (record.retirementTimeCapacityBytes !== null &&
          record.retirementTimeCapacityBytes > 192 * 1024 * 1024)
      )
        failed.push(`${label}: 192 MiB linear capacity ceiling`);
    }
  };
  if (evidence.moduleCacheExcluded !== true) unknown.push('compiled Module cache scope is unknown');
  const control = evidence.negativeControl;
  if (!control || !checkpointComplete(control.held) || !checkpointComplete(control.released))
    unknown.push('negative control checkpoint unavailable');
  else {
    const held = control.held.inventory;
    const released = control.released.inventory;
    if (
      !held ||
      !released ||
      held.length !== 1 ||
      released.length !== 1 ||
      held[0]?.id !== released[0]?.id
    )
      unknown.push('negative control instance inventory invalid');
    else if (
      !held[0]!.instanceLive ||
      !held[0]!.memoryLive ||
      !held[0]!.retirementTimeCapacityBytes ||
      held[0]!.retirementTimeCapacityBytes <= 0 ||
      control.held.liveMutableCapacityBytes === null ||
      control.held.liveMutableCapacityBytes <= 0 ||
      control.released.liveMutableCapacityBytes !== 0 ||
      released[0]!.instanceLive ||
      released[0]!.wrapperLive ||
      released[0]!.memoryLive
    )
      unknown.push('negative control did not distinguish held and released owners');
  }
  if (evidence.main.length !== 7) unknown.push('main attempt matrix incomplete');
  let previousCreated = 0;
  for (const [index, attempt] of evidence.main.entries()) {
    const label = `main ${index + 1} ${attempt.kind}`;
    if (!attempt.ownerReleased || attempt.createdCount <= previousCreated)
      unknown.push(`${label}: owner release or owned instance creation unbound`);
    previousCreated = attempt.createdCount;
    if (!checkpointComplete(attempt.checkpoint)) {
      unknown.push(`${label}: GC checkpoint unavailable`);
      continue;
    }
    const inventory = attempt.checkpoint.inventory!;
    validRecords(inventory, attempt.createdCount, label);
    if (
      attempt.checkpoint.liveInstanceCount !==
        inventory.filter((record) => record.instanceLive).length ||
      attempt.checkpoint.liveMemoryCount !==
        inventory.filter((record) => record.memoryLive).length ||
      attempt.checkpoint.liveMutableCapacityBytes !==
        inventory.reduce(
          (sum, record) =>
            sum + (record.memoryLive ? (record.retirementTimeCapacityBytes ?? 0) : 0),
          0
        ) ||
      inventory.some((record) => record.memoryLive && record.retirementTimeCapacityBytes === null)
    )
      unknown.push(`${label}: live mutable capacity inventory invalid`);
    const latest = inventory.filter(
      (record) => record.id > (index ? evidence.main[index - 1]!.createdCount : 0)
    );
    if (
      latest.length === 0 ||
      latest.some(
        (record) =>
          record.successfulBeginCalls < 1 ||
          record.stepCalls < 1 ||
          record.retireCalls < 1 ||
          record.retireStatus !== 0 ||
          record.retirementTimeCapacityBytes === null
      )
    )
      unknown.push(`${label}: begin, step, or retirement missing`);
    const live = inventory.filter(
      (record) => record.instanceLive || record.wrapperLive || record.memoryLive
    );
    if (live.length) failed.push(`${label}: ${live.length} mutable owner(s) live after checkpoint`);
    if (attempt.outputBytes !== undefined && attempt.outputBytes > 96 * 1024 * 1024)
      failed.push(`${label}: 96 MiB output ceiling`);
  }
  if (evidence.worker.length !== 5) unknown.push('Worker attempt matrix incomplete');
  const seenRequests = new Set<string>();
  const seenWorkers = new Set<number>();
  for (const [index, attempt] of evidence.worker.entries()) {
    const label = `worker ${index + 1} ${attempt.kind}`;
    if (!attempt.requestId || seenRequests.has(attempt.requestId) || seenWorkers.has(attempt.id))
      unknown.push(`${label}: Worker or request identity missing or duplicate`);
    if (attempt.requestId) seenRequests.add(attempt.requestId);
    seenWorkers.add(attempt.id);
    if (!attempt.snapshot || attempt.snapshot.requestId !== attempt.requestId)
      unknown.push(`${label}: owned ABI scalar snapshot missing or unmatched`);
    else {
      validRecords(attempt.snapshot.records, attempt.snapshot.createdCount, label);
      const expectedCapacity = attempt.snapshot.records.reduce(
        (sum, record) => sum + (record.retirementTimeCapacityBytes ?? record.peakCapacityBytes),
        0
      );
      if (
        attempt.preCloseMutableCapacityBytes !== expectedCapacity ||
        (attempt.closeObserved && attempt.postCloseReachableCapacityBytes !== 0)
      )
        unknown.push(`${label}: isolate capacity accounting incomplete`);
      if (
        attempt.snapshot.records.some(
          (record) =>
            record.successfulBeginCalls < 1 ||
            record.stepCalls < 1 ||
            (attempt.kind !== 'stop' && (record.retireCalls < 1 || record.retireStatus !== 0))
        )
      )
        unknown.push(`${label}: begin, step, or retirement missing`);
    }
    if (!attempt.terminatedAtMs) unknown.push(`${label}: observed termination missing`);
    if (attempt.kind !== 'stop' && attempt.terminalType !== 'complete')
      unknown.push(`${label}: completion response missing`);
    if (!attempt.closeCapability) unknown.push(`${label}: Worker close capability unavailable`);
    else if (!attempt.closeObserved && attempt.openAfterTimeout === true)
      failed.push(`${label}: Worker remained open beyond 5 seconds`);
    else if (!attempt.closeObserved) unknown.push(`${label}: Worker close signal unavailable`);
    else if (
      attempt.closeAtMs === null ||
      attempt.terminatedAtMs === null ||
      attempt.closeAtMs < attempt.terminatedAtMs
    )
      unknown.push(`${label}: Worker close cannot be bound to termination`);
    else if (attempt.closeAtMs - attempt.terminatedAtMs > 5_000)
      failed.push(`${label}: Worker close exceeded 5 seconds`);
    if (attempt.outputBytes !== undefined && attempt.outputBytes > 96 * 1024 * 1024)
      failed.push(`${label}: 96 MiB output ceiling`);
  }
  if (unknown.length) return { status: 'UNVERIFIED', reasons: [...unknown, ...failed] };
  if (failed.length) return { status: 'FAIL', reasons: failed };
  return { status: 'PASS', reasons: [] };
}
