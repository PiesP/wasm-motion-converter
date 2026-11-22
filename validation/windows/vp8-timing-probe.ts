/** Validation-only numeric observations; snapshots are read after UI timing seals. */
export function installVp8TimingProbe() {
  const DedicatedScope = Reflect.get(globalThis, 'DedicatedWorkerGlobalScope');
  const isDedicatedWorker =
    typeof DedicatedScope === 'function' && globalThis instanceof DedicatedScope;
  if (!isDedicatedWorker && typeof document === 'undefined')
    throw new Error('VP8 timing probe requires a page or a dedicated Worker scope');
  const marker = '__wmcVp8TimingSnapshot';
  const NativeInstance = WebAssembly.Instance;
  const NativeUint8Array = Uint8Array;
  const nativeSet = Uint8Array.prototype.set;
  const nativeGrow = WebAssembly.Memory.prototype.grow;
  const numericKeys = [
    'ownedInstances',
    'successfulBeginCalls',
    'stepCalls',
    'retireCalls',
    'inputCopyBytes',
    'outputCopyBytes',
    'inputCopyEvents',
    'outputCopyEvents',
    'unknownCopyKinds',
    'legacyIndexedCopyEvents',
    'peakLinearCapacityBytes',
    'capacityAtJobEndBytes',
    'workerStarts',
    'workerCompletions',
    'workerErrors',
    'staleWorkerEvents',
  ] as const;
  // Exact ASCII keys, a 36-byte UUID, and at most 16 decimal digits per safe
  // counter keep the Worker state below 1024 UTF-8 bytes without serializing it.
  const maximumEncodedBytes =
    2 +
    '"epoch":""'.length +
    36 +
    numericKeys.reduce((size, key) => size + 1 + key.length + 3 + 16, 0);
  if (maximumEncodedBytes > 1024) throw new Error('Timing snapshot schema exceeds byte cap');
  type State = {
    epoch: string | null;
    ownedInstances: number;
    successfulBeginCalls: number;
    stepCalls: number;
    retireCalls: number;
    inputCopyBytes: number;
    outputCopyBytes: number;
    inputCopyEvents: number;
    outputCopyEvents: number;
    unknownCopyKinds: number;
    legacyIndexedCopyEvents: number;
    peakLinearCapacityBytes: number;
    capacityAtJobEndBytes: number;
    workerStarts: number;
    workerCompletions: number;
    workerErrors: number;
    staleWorkerEvents: number;
  };
  const blank = (epoch: string | null): State => ({
    epoch,
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
  });
  function admitWorkerState(value: unknown, requestId: string): State | null {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)
    )
      return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== numericKeys.length + 1 ||
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          (key !== 'epoch' && !numericKeys.includes(key as (typeof numericKeys)[number]))
      )
    )
      return null;
    const epoch = Object.getOwnPropertyDescriptor(value, 'epoch');
    if (!epoch || !('value' in epoch) || epoch.value !== requestId) return null;
    const admitted = blank(requestId);
    for (const key of numericKeys) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !('value' in field) || !Number.isSafeInteger(field.value) || field.value < 0)
        return null;
      admitted[key] = field.value as number;
    }
    return admitted;
  }
  let current = blank(null);
  const memories: Array<WeakRef<WebAssembly.Memory>> = [];
  const knownMemories = new WeakSet<WebAssembly.Memory>();
  function trackMemory(memory: WebAssembly.Memory) {
    if (!knownMemories.has(memory)) {
      knownMemories.add(memory);
      memories.push(new WeakRef(memory));
    }
  }
  function observedMemory(buffer: ArrayBufferLike): WebAssembly.Memory | undefined {
    for (let index = memories.length - 1; index >= 0; index--) {
      const memory = memories[index]!.deref();
      if (!memory) memories.splice(index, 1);
      else if (memory.buffer === buffer) return memory;
    }
    return undefined;
  }
  function capacity(memory: WebAssembly.Memory) {
    if (current.epoch === null) return;
    const bytes = memory.buffer.byteLength;
    current.peakLinearCapacityBytes = Math.max(current.peakLinearCapacityBytes, bytes);
    current.capacityAtJobEndBytes = bytes;
  }
  WebAssembly.Instance = new Proxy(NativeInstance, {
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget);
      const exports = instance.exports as Record<string, unknown>;
      if (
        typeof exports.vp8_v2_begin !== 'function' ||
        !(exports.memory instanceof WebAssembly.Memory)
      )
        return instance;
      const memory = exports.memory;
      trackMemory(memory);
      if (current.epoch !== null) {
        current.ownedInstances++;
        capacity(memory);
      }
      // WASM exports are nonconfigurable. Give the app a wrapped namespace,
      // while the probe retains only a WeakRef to its app-owned memory.
      const wrapped = Object.fromEntries(
        Object.entries(exports).map(([key, value]) => [
          key,
          key === 'vp8_v2_begin' && typeof value === 'function'
            ? (...parameters: unknown[]) => {
                const status = Reflect.apply(value, exports, parameters) as number;
                if (current.epoch !== null && status === 10) {
                  current.successfulBeginCalls++;
                  capacity(memory);
                }
                return status;
              }
            : key === 'vp8_v2_step' && typeof value === 'function'
              ? (...parameters: unknown[]) => {
                  const status = Reflect.apply(value, exports, parameters) as number;
                  if (current.epoch !== null) current.stepCalls++;
                  return status;
                }
              : key === 'vp8_v2_retire' && typeof value === 'function'
                ? (...parameters: unknown[]) => {
                    const status = Reflect.apply(value, exports, parameters) as number;
                    if (current.epoch !== null) {
                      if (status === 0) current.retireCalls++;
                      capacity(memory);
                    }
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
  // Only successful explicit JS copies crossing a known ABI2 memory boundary.
  // DataView request metadata, codec-internal copies and pixel index writes
  // are not included in these counters.
  Uint8Array.prototype.set = function (source: ArrayLike<number>, offset?: number) {
    const result = nativeSet.call(this, source, offset);
    if (current.epoch !== null) {
      const destinationMemory = observedMemory(this.buffer);
      const sourceMemory = source instanceof NativeUint8Array && observedMemory(source.buffer);
      if (destinationMemory && !sourceMemory) {
        current.inputCopyBytes += source.length;
        current.inputCopyEvents++;
        capacity(destinationMemory);
      } else if (sourceMemory && !destinationMemory) {
        current.outputCopyBytes += source.length;
        current.outputCopyEvents++;
        capacity(sourceMemory);
      } else if (destinationMemory && sourceMemory) current.unknownCopyKinds++;
    }
    return result;
  };
  Reflect.set(
    globalThis,
    'Uint8Array',
    new Proxy(NativeUint8Array, {
      construct(target, args, newTarget) {
        const result = Reflect.construct(target, args, newTarget) as Uint8Array;
        const source = args[0];
        if (current.epoch !== null && source instanceof NativeUint8Array) {
          const memory = observedMemory(source.buffer);
          if (memory && result.buffer !== source.buffer) {
            current.outputCopyBytes += source.byteLength;
            current.outputCopyEvents++;
            capacity(memory);
          }
        }
        return result;
      },
    })
  );
  WebAssembly.Memory.prototype.grow = function (delta: number) {
    const previous = nativeGrow.call(this, delta);
    if (observedMemory(this.buffer)) capacity(this);
    return previous;
  };
  Reflect.set(
    globalThis,
    '__wmcVp8LegacyCopy',
    (
      heap: Uint8Array,
      memory: WebAssembly.Memory,
      offset: number,
      iterations: number,
      source: Uint8Array
    ) => {
      if (current.epoch === null) return;
      if (
        !(memory instanceof WebAssembly.Memory) ||
        !(heap instanceof NativeUint8Array) ||
        !(source instanceof NativeUint8Array) ||
        heap.buffer !== memory.buffer ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(iterations) ||
        iterations <= 0 ||
        iterations !== source.length ||
        offset + iterations > heap.length
      ) {
        current.unknownCopyKinds++;
        return;
      }
      trackMemory(memory);
      current.inputCopyBytes += iterations;
      current.inputCopyEvents++;
      current.legacyIndexedCopyEvents++;
      capacity(memory);
    }
  );
  if (isDedicatedWorker) {
    globalThis.addEventListener('message', (event: MessageEvent) => {
      // The owner's implicit port delivers trusted events with empty origin and null source.
      if (!event.isTrusted || event.origin !== '' || event.source !== null) return;
      const message = event.data as Record<string, unknown> | null;
      if (message?.type === 'start' && typeof message.requestId === 'string')
        current = blank(message.requestId);
    });
    const owner = globalThis as unknown as {
      postMessage: (message: unknown, transfer?: Transferable[]) => void;
    };
    const nativePostMessage = owner.postMessage;
    owner.postMessage = function (message: unknown, transfer?: Transferable[]) {
      const response = message as Record<string, unknown> | null;
      if (response?.type === 'complete' && current.epoch !== null) {
        // Add fixed scalar fields to the already mandatory completion transfer.
        // No extra message, hash, pixel view, or retained buffer is created.
        const tagged = { ...response, [marker]: { ...current } };
        return nativePostMessage.call(owner, tagged, transfer);
      }
      return nativePostMessage.call(owner, message, transfer);
    };
    return;
  }
  // Observe the actual product Worker route without querying, delaying or
  // keeping a Worker after the product terminates it on complete.
  const NativeWorker = Worker;
  let workerObservation: { requestId: string; state: State } | null = null;
  let workerSnapshotStatus: 'none' | 'valid' | 'invalid' | 'missing' = 'none';
  globalThis.Worker = class TimingWorker extends NativeWorker {
    private timingEpoch: string | null = null;
    private timingRequestId: string | null = null;
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener('message', (event) => {
        const response = event.data as Record<string, unknown> | null;
        if (!response || typeof response !== 'object') return;
        const tagged = Object.getOwnPropertyDescriptor(response, marker);
        const raw = tagged && 'value' in tagged ? tagged.value : undefined;
        if (tagged && !Reflect.deleteProperty(response, marker)) {
          workerSnapshotStatus = 'invalid';
          event.stopImmediatePropagation();
          return;
        }
        if (response?.type !== 'complete' && response?.type !== 'error') return;
        if (this.timingEpoch !== current.epoch || current.epoch === null)
          current.staleWorkerEvents++;
        else if (response.type === 'complete') {
          current.workerCompletions++;
          if (!tagged) workerSnapshotStatus = 'missing';
          else if (this.timingRequestId !== null && this.timingRequestId === response.requestId) {
            const admitted = admitWorkerState(raw, this.timingRequestId);
            if (admitted) {
              workerObservation = { requestId: this.timingRequestId, state: admitted };
              workerSnapshotStatus = 'valid';
            } else workerSnapshotStatus = 'invalid';
          } else workerSnapshotStatus = 'invalid';
        } else current.workerErrors++;
      });
    }
    override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      if ((message as { type?: unknown } | null)?.type === 'start' && current.epoch !== null) {
        this.timingEpoch = current.epoch;
        this.timingRequestId = (message as { requestId?: string }).requestId ?? null;
        current.workerStarts++;
      }
      return transfer === undefined
        ? super.postMessage(message)
        : super.postMessage(message, transfer as Transferable[]);
    }
  };
  Reflect.set(globalThis, '__wmcVp8TimingProbe', {
    begin(epoch: string) {
      current = blank(epoch);
      workerObservation = null;
      workerSnapshotStatus = 'none';
    },
    snapshot(epoch: string) {
      const result = {
        ...current,
        epochMatches: current.epoch === epoch,
        workerSnapshotStatus,
        workerObservation: workerObservation
          ? { ...workerObservation, state: { ...workerObservation.state } }
          : null,
      };
      current = blank(null);
      workerObservation = null;
      workerSnapshotStatus = 'none';
      return result;
    },
  });
}
