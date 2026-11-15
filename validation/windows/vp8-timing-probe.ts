/** Validation-only numeric observations; snapshots are read after UI timing seals. */
export function installVp8TimingProbe() {
  const marker = '__wmcVp8TimingSnapshot';
  const NativeInstance = WebAssembly.Instance;
  const NativeUint8Array = Uint8Array;
  const nativeSet = Uint8Array.prototype.set;
  const nativeGrow = WebAssembly.Memory.prototype.grow;
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
  if (typeof document === 'undefined') {
    globalThis.addEventListener('message', (event: MessageEvent) => {
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
  globalThis.Worker = class TimingWorker extends NativeWorker {
    private timingEpoch: string | null = null;
    private timingRequestId: string | null = null;
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener('message', (event) => {
        const response = event.data as Record<string, unknown> | null;
        if (response?.type !== 'complete' && response?.type !== 'error') return;
        if (this.timingEpoch !== current.epoch || current.epoch === null)
          current.staleWorkerEvents++;
        else if (response.type === 'complete') {
          current.workerCompletions++;
          const raw = response[marker];
          if (raw && this.timingRequestId !== null && this.timingRequestId === response.requestId) {
            workerObservation = { requestId: this.timingRequestId, state: raw as State };
            delete response[marker];
          }
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
    },
    snapshot(epoch: string) {
      const result = {
        ...current,
        epochMatches: current.epoch === epoch,
        workerObservation: workerObservation
          ? { ...workerObservation, state: { ...workerObservation.state } }
          : null,
      };
      current = blank(null);
      workerObservation = null;
      return result;
    },
  });
}
