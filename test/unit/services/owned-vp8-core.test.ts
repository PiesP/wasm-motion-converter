// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

type Core = typeof import('@services/owned-vp8-core');
const wasmBytes = Uint8Array.from(
  readFileSync(
    process.env.WMC_501_ABI_WASM ??
      new URL('../../../crates/owned-vp8/owned-vp8.wasm', import.meta.url)
  )
);
const LOAD_STAGING_BYTES = 482_273;

let core: Core;
let moduleState: typeof import('@services/owned-vp8-module-state');

function wasmResponse(bytes: Uint8Array = wasmBytes, mime = 'application/wasm'): Response {
  return new Response(Uint8Array.from(bytes).buffer as ArrayBuffer, {
    headers: { 'content-type': mime },
  });
}

function accounting() {
  return {
    assertModuleLoad: vi.fn((_bytes: number) => undefined),
    reserve: vi.fn((_linear: number, _hostCopy: number): void | Promise<void> => undefined),
    observe: vi.fn((_actual: number) => undefined),
    release: vi.fn(() => undefined),
  };
}

function pixels(width = 16, height = 16): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    const at = index * 4;
    data.set([(index * 37) & 255, (index * 13) & 255, (index * 71) & 255, 255], at);
  }
  return data;
}

function settings(width = 16, height = 16) {
  return {
    width,
    height,
    stride: width * 4,
    layout: 0,
    quality: 75 as const,
    outputLimit: 96 * 1024 * 1024,
    externalLiveBytes: width * height * 4,
    retainedOutputBytes: 0,
  };
}

beforeEach(async () => {
  vi.resetModules();
  core = await import('@services/owned-vp8-core');
  moduleState = await import('@services/owned-vp8-module-state');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('owned VP8 conversion-owned host adapter', () => {
  it('preserves budgeted chroma proposals along an even-height metric boundary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(wasmResponse()));
    const encoder = await core.createOwnedVp8Encoder({ accounting: accounting() });
    const palette = [
      [244, 29, 171],
      [35, 227, 91],
      [89, 61, 239],
      [22, 94, 198],
    ];
    // The second chroma patch is outside the direct metric window but still consumes
    // an ordered joint proposal. Omitting it changes the saved bitstream.
    const rows = [
      '210001020',
      '001321111',
      '021102213',
      '311133102',
      '320333231',
      '030030012',
      '333202001',
      '002000200',
    ];
    const rgb = Uint8Array.from(
      rows
        .join('')
        .split('')
        .flatMap((index) => palette[Number(index)]!)
    );
    try {
      const result = await encoder.encode(
        rgb,
        {
          ...settings(9, 8),
          stride: 27,
          layout: 4,
          externalLiveBytes: rgb.byteLength,
        },
        (bytes) => {
          expect(createHash('sha256').update(bytes).digest('hex')).toBe(
            'b7bfefce0e0ae47590a12d7c70f2cf60f915b9cce92c262fcb77a976107aac29'
          );
        }
      );
      expect(result.steps).toBe(391);
      expect(result.finalizedVp8Bytes).toBe(119);
    } finally {
      encoder.retire();
    }
  });

  it('does not cache a failed load, then reuses compiled code with separate instances', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(wasmResponse(wasmBytes, 'text/plain'))
      .mockResolvedValue(wasmResponse());
    vi.stubGlobal('fetch', fetchMock);
    await expect(core.createOwnedVp8Encoder({ accounting: accounting() })).rejects.toBeInstanceOf(
      core.OwnedVp8LoadError
    );
    const firstAccounting = accounting();
    const secondAccounting = accounting();
    const first = await core.createOwnedVp8Encoder({ accounting: firstAccounting });
    const second = await core.createOwnedVp8Encoder({ accounting: secondAccounting });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first).not.toBe(second);
    let firstBuffer: ArrayBufferLike | undefined;
    let secondBuffer: ArrayBufferLike | undefined;
    const source = pixels();
    const a = await first.encode(source, settings(), (raw) => {
      firstBuffer = raw.buffer;
    });
    const b = await second.encode(source, settings(), (raw) => {
      secondBuffer = raw.buffer;
    });
    expect(firstBuffer).not.toBe(secondBuffer);
    expect(a.finalizedVp8Bytes).toBeGreaterThan(10);
    expect(a.finalizedVp8Bytes).toBe(b.finalizedVp8Bytes);
    expect(firstAccounting.reserve).toHaveBeenCalled();
    expect(firstAccounting.release).not.toHaveBeenCalled();
    first.retire();
    second.retire();
    expect(firstAccounting.release).toHaveBeenCalledTimes(1);
    expect(secondAccounting.release).toHaveBeenCalledTimes(1);
  });

  it.each(['http-failure', 'invalid-module'] as const)(
    'types %s at initialization and recovers on a later explicit request',
    async (mode) => {
      const invalid =
        mode === 'http-failure'
          ? new Response('', { status: 503, headers: { 'content-type': 'application/wasm' } })
          : wasmResponse(new TextEncoder().encode('invalid owned VP8 module'));
      const fetchMock = vi.fn().mockResolvedValueOnce(invalid).mockResolvedValue(wasmResponse());
      vi.stubGlobal('fetch', fetchMock);
      const failedLedger = accounting();
      const failure = core.createOwnedVp8Encoder({ accounting: failedLedger });
      if (mode === 'http-failure') {
        await expect(failure).rejects.toBeInstanceOf(core.OwnedVp8LoadError);
        await expect(failure).rejects.toThrow('HTTP 503');
      } else {
        await expect(failure).rejects.toBeInstanceOf(core.OwnedVp8InitializationAbiError);
      }
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(failedLedger.reserve).not.toHaveBeenCalled();

      const recovered = await core.createOwnedVp8Encoder({ accounting: accounting() });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      recovered.retire();
    }
  );

  it.each(['resolve', 'reject'] as const)(
    'abandons the caller promptly while cancelled fetch headers later %s',
    async (outcome) => {
      const headers = Promise.withResolvers<Response>();
      const cancelBody = vi.fn();
      const unusedBody = new ReadableStream<Uint8Array>({ cancel: cancelBody });
      const fetchMock = vi
        .fn()
        .mockReturnValueOnce(headers.promise)
        .mockResolvedValue(wasmResponse());
      vi.stubGlobal('fetch', fetchMock);
      const controller = new AbortController();
      const ledger = accounting();
      const first = core.createOwnedVp8Encoder({ accounting: ledger, signal: controller.signal });
      controller.abort();
      await expect(first).rejects.toBeInstanceOf(core.OwnedVp8CancelledError);
      const next = core.createOwnedVp8Encoder({ accounting: accounting() });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(moduleState.getOwnedVp8ModuleBytes()).toBe(0);
      expect(fetchMock).toHaveBeenCalledOnce();
      if (outcome === 'resolve')
        headers.resolve(
          new Response(unusedBody, { headers: { 'content-type': 'application/wasm' } })
        );
      else headers.reject(new TypeError('late fetch failure'));
      const recovered = await next;
      recovered.retire();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(ledger.assertModuleLoad).not.toHaveBeenCalled();
      expect(cancelBody).toHaveBeenCalledTimes(outcome === 'resolve' ? 1 : 0);
    }
  );

  it('rejects a cold load before allocating its staging buffer', async () => {
    const stream = new ReadableStream<Uint8Array>();
    const response = new Response(stream, { headers: { 'content-type': 'application/wasm' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const allocate = vi.fn();
    vi.stubGlobal(
      'Uint8Array',
      new Proxy(Uint8Array, {
        construct(target, args, newTarget) {
          allocate(args[0]);
          return Reflect.construct(target, args, newTarget);
        },
      })
    );
    const compile = vi.spyOn(WebAssembly, 'compile');
    const ledger = accounting();
    const denial = new Error('Cold load budget denied');
    ledger.assertModuleLoad.mockImplementation(() => {
      throw denial;
    });

    await expect(core.createOwnedVp8Encoder({ accounting: ledger })).rejects.toMatchObject({
      name: new core.OwnedVp8MemoryAdmissionError().name,
      cause: denial,
    });
    expect(ledger.assertModuleLoad).toHaveBeenCalledExactlyOnceWith(LOAD_STAGING_BYTES);
    expect(allocate).not.toHaveBeenCalledWith(LOAD_STAGING_BYTES);
    expect(compile).not.toHaveBeenCalled();
    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(moduleState.getOwnedVp8ModuleBytes()).toBe(0);
    expect(stream.locked).toBe(false);
  });

  it('charges the stream backing separately from its logical view and shares a successful load', async () => {
    const backing = new Uint8Array(wasmBytes.byteLength + 17);
    const payload = backing.subarray(8, 8 + wasmBytes.byteLength);
    payload.set(wasmBytes);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(stream, {
          headers: { 'content-type': 'application/wasm' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const entered = Promise.withResolvers<BufferSource>();
    const physical = Promise.withResolvers<WebAssembly.Module>();
    const module = await WebAssembly.compile(wasmBytes);
    const compile = vi.spyOn(WebAssembly, 'compile').mockImplementation((bytes) => {
      entered.resolve(bytes);
      return physical.promise;
    });
    const firstLedger = accounting();
    const secondLedger = accounting();
    const first = core.createOwnedVp8Encoder({ accounting: firstLedger });
    const second = core.createOwnedVp8Encoder({ accounting: secondLedger });
    const staged = await entered.promise;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(compile).toHaveBeenCalledOnce();
    expect(firstLedger.assertModuleLoad.mock.calls).toEqual([
      [LOAD_STAGING_BYTES],
      [LOAD_STAGING_BYTES + backing.byteLength],
      [LOAD_STAGING_BYTES + payload.byteLength],
    ]);
    expect(secondLedger.assertModuleLoad).not.toHaveBeenCalled();
    expect(staged).toMatchObject({ byteLength: payload.byteLength });
    expect(moduleState.getOwnedVp8ModuleBytes()).toBe(LOAD_STAGING_BYTES + wasmBytes.byteLength);
    expect(firstLedger.reserve).not.toHaveBeenCalled();

    physical.resolve(module);
    const [firstEncoder, secondEncoder] = await Promise.all([first, second]);
    expect(firstEncoder).not.toBe(secondEncoder);
    expect(moduleState.getOwnedVp8ModuleBytes()).toBe(wasmBytes.byteLength);
    expect(firstLedger.reserve).toHaveBeenCalledOnce();
    expect(secondLedger.reserve).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(compile).toHaveBeenCalledOnce();
    firstEncoder.retire();
    secondEncoder.retire();
    expect(firstLedger.release).toHaveBeenCalledOnce();
    expect(secondLedger.release).toHaveBeenCalledOnce();
  });

  it('keeps the staging charge through cancellation of a physically pending read', async () => {
    const entered = Promise.withResolvers<void>();
    const underlyingCancel = Promise.withResolvers<void>();
    const cancel = vi.fn(() => underlyingCancel.promise);
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          entered.resolve();
        },
        cancel,
      },
      { highWaterMark: 0 }
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(stream, { headers: { 'content-type': 'application/wasm' } })
      )
      .mockResolvedValueOnce(wasmResponse());
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const first = core.createOwnedVp8Encoder({
      signal: controller.signal,
      accounting: accounting(),
    });
    await entered.promise;
    controller.abort();
    await expect(first).rejects.toBeInstanceOf(core.OwnedVp8CancelledError);
    const waiting = core.createOwnedVp8Encoder({ accounting: accounting() });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(moduleState.getOwnedVp8ModuleBytes()).toBe(LOAD_STAGING_BYTES);
    underlyingCancel.resolve();
    const second = await waiting;
    expect(moduleState.getOwnedVp8ModuleBytes()).toBe(wasmBytes.byteLength);
    expect(stream.locked).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    second.retire();
  });

  it.each(['resolve', 'reject'])(
    'waits for an abandoned compile to physically %s before reloading',
    async (outcome) => {
      const module = await WebAssembly.compile(wasmBytes);
      const inFlight = Promise.withResolvers<WebAssembly.Module>();
      const entered = Promise.withResolvers<void>();
      const compile = vi
        .spyOn(WebAssembly, 'compile')
        .mockImplementationOnce(() => {
          entered.resolve();
          return inFlight.promise;
        })
        .mockResolvedValue(module);
      const fetchMock = vi.fn(async () => wasmResponse());
      vi.stubGlobal('fetch', fetchMock);
      const controller = new AbortController();
      const ledger = accounting();
      const first = core.createOwnedVp8Encoder({
        signal: controller.signal,
        accounting: ledger,
      });
      await entered.promise;
      expect(moduleState.getOwnedVp8ModuleBytes()).toBe(LOAD_STAGING_BYTES + wasmBytes.byteLength);
      controller.abort();
      await expect(first).rejects.toBeInstanceOf(core.OwnedVp8CancelledError);
      const next = core.createOwnedVp8Encoder({ accounting: accounting() });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(compile).toHaveBeenCalledOnce();
      expect(ledger.reserve).not.toHaveBeenCalled();
      expect(moduleState.getOwnedVp8ModuleBytes()).toBe(LOAD_STAGING_BYTES + wasmBytes.byteLength);
      if (outcome === 'resolve') inFlight.resolve(module);
      else inFlight.reject(new Error('late compile failure'));
      const recovered = await next;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(compile).toHaveBeenCalledTimes(2);
      expect(ledger.reserve).not.toHaveBeenCalled();
      expect(moduleState.getOwnedVp8ModuleBytes()).toBe(wasmBytes.byteLength);
      recovered.retire();
    }
  );

  it('classifies a failed response stream as a load failure and permits a retry', async () => {
    const broken = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError('network stream failed'));
        },
      }),
      { headers: { 'content-type': 'application/wasm' } }
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(broken).mockResolvedValue(wasmResponse());
    vi.stubGlobal('fetch', fetchMock);
    await expect(core.createOwnedVp8Encoder({ accounting: accounting() })).rejects.toBeInstanceOf(
      core.OwnedVp8LoadError
    );
    const recovered = await core.createOwnedVp8Encoder({ accounting: accounting() });
    recovered.retire();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps deterministic raw VP8 bytes across frames and reserves output before consumption', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(wasmResponse()));
    const ledger = accounting();
    const encoder = await core.createOwnedVp8Encoder({ accounting: ledger });
    const source = pixels(17, 13);
    const request = settings(17, 13);
    const outputs: Uint8Array[] = [];
    const consume = (raw: Uint8Array): void => {
      expect(ledger.reserve.mock.lastCall?.[1]).toBe(raw.byteLength);
      outputs.push(Uint8Array.from(raw));
    };
    const first = await encoder.encode(source, request, consume);
    const second = await encoder.encode(source, request, consume);
    expect(outputs[0]).toEqual(outputs[1]);
    expect(Array.from(outputs[0]!.subarray(3, 6))).toEqual([0x9d, 0x01, 0x2a]);
    expect(first.sourceCopyBytes).toBe(source.byteLength);
    expect(first.finalizedVp8Bytes).toBe(outputs[0]!.byteLength);
    expect(second.frame).toBe(2);
    expect(first.actualLinearCapacityBytes).toBeLessThanOrEqual(first.reservedLinearCapacityBytes);
    expect(first.reservedLinearCapacityBytes).toBeLessThanOrEqual(192 * 1024 * 1024);
    expect(ledger.observe).toHaveBeenCalled();
    expect(ledger.release).not.toHaveBeenCalled();
    encoder.retire();
    expect(ledger.release).toHaveBeenCalledTimes(1);
  });

  it('rejects a source detached after a partial copy and retires without publication', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(wasmResponse()));
    const source = pixels(256, 256);
    const backing = source.buffer;
    const originalSubarray = source.subarray.bind(source);
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    let enterYield!: () => void;
    let finishYield!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterYield = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finishYield = resolve;
    });
    vi.stubGlobal('scheduler', {
      yield: vi.fn(() => {
        enterYield();
        return pending;
      }),
    });
    const copiedStarts: number[] = [];
    vi.spyOn(source, 'subarray').mockImplementation((start, end) => {
      const chunk = originalSubarray(start, end);
      copiedStarts.push(start ?? 0);
      if (start === 0) now = 10;
      return chunk;
    });
    const ledger = accounting();
    const encoder = await core.createOwnedVp8Encoder({ accounting: ledger });
    const consume = vi.fn();
    const task = encoder.encode(source, { ...settings(256, 256), layout: 2 }, consume);
    await entered;
    expect(copiedStarts).toEqual([0]);
    structuredClone(backing, { transfer: [backing] });
    finishYield();
    await expect(task).rejects.toBeInstanceOf(core.OwnedVp8InvalidInputError);
    expect(copiedStarts).toEqual([0]);
    expect(consume).not.toHaveBeenCalled();
    expect(ledger.release).toHaveBeenCalledTimes(1);
  });

  it('snapshots settings and charges the whole retained source backing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(wasmResponse()));
    const source = pixels();
    const request = settings();
    const encoder = await core.createOwnedVp8Encoder({ accounting: accounting() });
    const task = encoder.encode(source, request, () => undefined);
    request.width = 1;
    request.height = 1;
    await expect(task).resolves.toMatchObject({ sourceCopyBytes: source.byteLength });
    encoder.retire();
    const pooled = new Uint8Array(source.byteLength * 2);
    pooled.set(source);
    const ledger = accounting();
    const undercharged = await core.createOwnedVp8Encoder({ accounting: ledger });
    await expect(
      undercharged.encode(pooled.subarray(0, source.byteLength), settings(), () => undefined)
    ).rejects.toBeInstanceOf(core.OwnedVp8MemoryAdmissionError);
    expect(ledger.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['valid', 0, 0x90, true],
    ['relocated response and replaced buffer', 0, 0x90, true],
    ['bad release response', 0, 0x90, true],
    ['bad release extent', 0, 0x90, true],
    ['unsupported version', 0, 0x92, false],
    ['scaled width', 7, 0x40, false],
    ['scaled height', 9, 0x80, false],
    ['hidden keyframe', 0, 0x80, false],
    ['interframe', 0, 0x91, false],
    ['invalid start code', 3, 0, false],
    ['first partition exceeds extent', 1, 0xff, false],
  ] as const)(
    'admits output before the next step and checks its header (%s)',
    async (scenario, offset, byte, valid) => {
      const memory = new WebAssembly.Memory({ initial: 1, maximum: 3_072 });
      let responsePointer = 128;
      let response = new DataView(memory.buffer, responsePointer, 96);
      const raw = new Uint8Array(memory.buffer, 2048, 100);
      raw.set([0x90, 0x02, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0]);
      raw[offset] = byte;
      const put = (index: number, value: number): void =>
        response.setUint32(index * 4, value, true);
      const publish = (status: number, phase: number, admitted: number, hostCopy = 0): number => {
        put(0, 2);
        put(1, status);
        put(2, phase);
        put(3, 1);
        put(4, 1);
        put(5, phase === 3 ? 1024 : 0);
        put(6, phase === 3 ? 4 : 0);
        put(7, phase === 5 ? 2048 : 0);
        put(8, phase === 5 ? 100 : 0);
        put(9, 65_536);
        put(10, admitted);
        put(11, 256 * 1024);
        put(18, hostCopy);
        put(19, hostCopy);
        return status;
      };
      const ledger = accounting();
      let completeReservation!: () => void;
      const reservation = new Promise<void>((resolve) => {
        completeReservation = resolve;
      });
      ledger.reserve.mockImplementation((linear, hostCopy) =>
        linear === 4 * 65_536 && hostCopy === 100 ? reservation : undefined
      );
      const step = vi
        .fn()
        .mockImplementationOnce(() => {
          if (scenario === 'relocated response and replaced buffer') {
            memory.grow(0);
            response = new DataView(memory.buffer, responsePointer, 96);
          }
          return publish(10, 4, 4 * 65_536, 100);
        })
        .mockImplementationOnce(() => {
          expect(ledger.reserve).toHaveBeenLastCalledWith(4 * 65_536, 100);
          return publish(11, 5, 4 * 65_536, 100);
        });
      const fake = {
        memory,
        vp8_v2_abi_version: () => 2,
        vp8_v2_request_ptr: () => 64,
        vp8_v2_response_ptr: () => responsePointer,
        vp8_v2_plan: () => publish(0, 1, 2 * 65_536),
        vp8_v2_reserve_step: () => {
          if (scenario === 'relocated response and replaced buffer') {
            responsePointer = 256;
            response = new DataView(memory.buffer, responsePointer, 96);
          }
          return publish(0, 3, 2 * 65_536);
        },
        vp8_v2_begin: () => publish(10, 4, 2 * 65_536),
        vp8_v2_step: step,
        vp8_v2_abort: () => publish(9, 0, 0),
        vp8_v2_release_input: () => publish(0, 0, 0),
        vp8_v2_release_output: vi.fn(() => {
          const status = publish(0, 0, 0);
          if (scenario === 'bad release response') put(0, 3);
          if (scenario === 'bad release extent') responsePointer = memory.buffer.byteLength - 95;
          return status;
        }),
        vp8_v2_retire: () => 0,
      };
      ledger.reserve(65_536, 0);
      const encoder = new core.OwnedVp8Encoder(
        { exports: fake } as unknown as WebAssembly.Instance,
        { accounting: ledger },
        65_536
      );
      const source = new Uint8Array([128, 128, 128, 255]);
      const consume = vi.fn();
      const task = encoder.encode(source, settings(1, 1), consume);
      await vi.waitFor(() => expect(ledger.reserve).toHaveBeenLastCalledWith(4 * 65_536, 100));
      expect(step).toHaveBeenCalledTimes(1);
      completeReservation();
      if (scenario === 'bad release response' || scenario === 'bad release extent') {
        await expect(task).rejects.toBeInstanceOf(core.OwnedVp8AbiError);
        expect(consume).toHaveBeenCalledOnce();
      } else if (valid) {
        await expect(task).resolves.toMatchObject({ finalizedVp8Bytes: 100 });
        expect(consume).toHaveBeenCalledOnce();
      } else {
        await expect(task).rejects.toBeInstanceOf(core.OwnedVp8AbiError);
        expect(consume).not.toHaveBeenCalled();
      }
      expect(fake.vp8_v2_release_output).toHaveBeenCalledOnce();
      expect(step).toHaveBeenCalledTimes(2);
      encoder.retire();
      expect(ledger.release).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps a real host yield and cancellation between unchanged-capacity ABI steps', async () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 3_072 });
    const response = new DataView(memory.buffer, 128, 96);
    const put = (index: number, value: number): void => response.setUint32(index * 4, value, true);
    const publish = (status: number, phase: number): number => {
      put(0, 2);
      put(1, status);
      put(2, phase);
      put(3, 1);
      put(4, 1);
      put(5, phase === 3 ? 1024 : 0);
      put(6, phase === 3 ? 4 : 0);
      put(9, 65_536);
      put(10, 65_536);
      put(11, 256 * 1024);
      return status;
    };
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    let enteredYield!: () => void;
    let finishYield!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredYield = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finishYield = resolve;
    });
    const yieldTask = vi.fn(() => {
      enteredYield();
      return pending;
    });
    vi.stubGlobal('scheduler', { yield: yieldTask });
    const controller = new AbortController();
    const ledger = accounting();
    let stepCalls = 0;
    const step = vi.fn(() => {
      stepCalls++;
      if (stepCalls === 2) now = 10;
      return publish(10, 4);
    });
    const fake = {
      memory,
      vp8_v2_abi_version: () => 2,
      vp8_v2_request_ptr: () => 64,
      vp8_v2_response_ptr: () => 128,
      vp8_v2_plan: () => publish(0, 1),
      vp8_v2_reserve_step: () => publish(0, 3),
      vp8_v2_begin: () => publish(10, 4),
      vp8_v2_step: step,
      vp8_v2_abort: vi.fn(() => publish(9, 0)),
      vp8_v2_release_input: vi.fn(() => publish(0, 0)),
      vp8_v2_release_output: vi.fn(() => publish(0, 0)),
      vp8_v2_retire: vi.fn(() => 0),
    };
    ledger.reserve(65_536, 0);
    const encoder = new core.OwnedVp8Encoder(
      { exports: fake } as unknown as WebAssembly.Instance,
      { accounting: ledger, signal: controller.signal },
      65_536
    );
    const consume = vi.fn();
    const task = encoder.encode(new Uint8Array([128, 128, 128, 255]), settings(1, 1), consume);
    await entered;
    expect(step).toHaveBeenCalledTimes(2);
    expect(ledger.reserve).toHaveBeenCalledTimes(1);
    expect(ledger.observe).toHaveBeenCalledTimes(5);
    controller.abort();
    finishYield();
    await expect(task).rejects.toBeInstanceOf(core.OwnedVp8CancelledError);
    expect(yieldTask).toHaveBeenCalledTimes(1);
    expect(step).toHaveBeenCalledTimes(2);
    expect(consume).not.toHaveBeenCalled();
    expect(ledger.release).toHaveBeenCalledTimes(1);
  });

  it('translates a synchronous output reservation failure before consumption', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(wasmResponse()));
    const ledger = accounting();
    ledger.reserve.mockImplementation((_linear, hostCopy) => {
      if (hostCopy > 0) throw new Error('denied');
    });
    const encoder = await core.createOwnedVp8Encoder({ accounting: ledger });
    const consume = vi.fn();
    await expect(encoder.encode(pixels(), settings(), consume)).rejects.toThrow(
      'Owned VP8 reservation failed'
    );
    expect(ledger.reserve.mock.calls.some(([, hostCopy]) => hostCopy > 0)).toBe(true);
    expect(consume).not.toHaveBeenCalled();
    expect(ledger.release).toHaveBeenCalledTimes(1);
  });

  it.each(['fulfill', 'reject'])(
    'holds the aborted output lease until the consumer settles (%s)',
    async (outcome) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(wasmResponse()));
      const controller = new AbortController();
      const ledger = accounting();
      const encoder = await core.createOwnedVp8Encoder({
        accounting: ledger,
        signal: controller.signal,
      });
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let finish!: () => void;
      const lateFailure = new Error('late consumer rejection');
      const pending = new Promise<void>((resolve, reject) => {
        finish = outcome === 'fulfill' ? resolve : () => reject(lateFailure);
      });
      let borrowed: Uint8Array | undefined;
      const task = encoder.encode(pixels(), settings(), (raw) => {
        borrowed = raw;
        enter();
        return pending;
      });
      await entered;
      let settled = false;
      void task.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await expect(encoder.encode(pixels(), settings(), () => undefined)).rejects.toBeInstanceOf(
        core.OwnedVp8BusyError
      );
      const original = Uint8Array.from(borrowed!);
      controller.abort();
      encoder.retire();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(ledger.release).not.toHaveBeenCalled();
      expect(borrowed).toEqual(original);
      finish();
      if (outcome === 'fulfill')
        await expect(task).rejects.toBeInstanceOf(core.OwnedVp8CancelledError);
      else await expect(task).rejects.toBe(lateFailure);
      expect(ledger.release).toHaveBeenCalledTimes(1);
      const next = await core.createOwnedVp8Encoder({ accounting: accounting() });
      await expect(next.encode(pixels(), settings(), () => undefined)).resolves.toMatchObject({
        frame: 1,
      });
      next.retire();
    }
  );

  it('rejects stale publication after async consume settles', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(wasmResponse()));
    let current = true;
    const ledger = accounting();
    const encoder = await core.createOwnedVp8Encoder({
      accounting: ledger,
      isCurrent: () => current,
    });
    const task = encoder.encode(pixels(), settings(), async () => {
      current = false;
      await Promise.resolve();
    });
    await expect(task).rejects.toBeInstanceOf(core.OwnedVp8CancelledError);
    expect(ledger.release).toHaveBeenCalledTimes(1);
  });

  it('cancels at a real scheduler task and permits a fresh instance to recover', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(wasmResponse()));
    const controller = new AbortController();
    const yieldTask = vi.fn(async () => {
      controller.abort();
    });
    vi.stubGlobal('scheduler', { yield: yieldTask });
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 10));
    const ledger = accounting();
    const encoder = await core.createOwnedVp8Encoder({
      accounting: ledger,
      signal: controller.signal,
    });
    await expect(encoder.encode(pixels(), settings(), () => undefined)).rejects.toBeInstanceOf(
      core.OwnedVp8CancelledError
    );
    expect(yieldTask).toHaveBeenCalled();
    expect(ledger.release).toHaveBeenCalledTimes(1);
    const recovered = await core.createOwnedVp8Encoder({ accounting: accounting() });
    await expect(recovered.encode(pixels(), settings(), () => undefined)).resolves.toBeDefined();
    recovered.retire();
  });

  it('keeps input, layout, opacity, memory, and output outcomes distinct', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(wasmResponse()));
    const cases = [
      [{ ...settings(), stride: 1 }, core.OwnedVp8InvalidInputError],
      [{ ...settings(), layout: 99 }, core.OwnedVp8UnsupportedLayoutError],
      [
        { ...settings(), externalLiveBytes: 192 * 1024 * 1024 + 1 },
        core.OwnedVp8MemoryAdmissionError,
      ],
      [{ ...settings(), outputLimit: 1 }, core.OwnedVp8OutputLimitError],
    ] as const;
    for (const [request, error] of cases) {
      const encoder = await core.createOwnedVp8Encoder({ accounting: accounting() });
      await expect(encoder.encode(pixels(), request, () => undefined)).rejects.toBeInstanceOf(
        error
      );
    }
    const transparent = pixels();
    transparent[3] = 254;
    const encoder = await core.createOwnedVp8Encoder({ accounting: accounting() });
    await expect(encoder.encode(transparent, settings(), () => undefined)).rejects.toBeInstanceOf(
      core.OwnedVp8UnsupportedPixelsError
    );
  });

  it('rejects an oversized or shared-memory asset before instantiation', async () => {
    const oversized = new Uint8Array(482_274);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(wasmResponse(oversized))
      .mockResolvedValueOnce(
        wasmResponse(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 5, 5, 1, 3, 1, 0x80, 0x18]))
      )
      .mockResolvedValue(wasmResponse());
    vi.stubGlobal('fetch', fetchMock);
    await expect(core.createOwnedVp8Encoder({ accounting: accounting() })).rejects.toBeInstanceOf(
      core.OwnedVp8LoadError
    );
    await expect(core.createOwnedVp8Encoder({ accounting: accounting() })).rejects.toBeInstanceOf(
      core.OwnedVp8AbiError
    );
    const recovered = await core.createOwnedVp8Encoder({ accounting: accounting() });
    recovered.retire();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('classifies partition failure and a WASM trap without publishing output', async () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 3_072 });
    const response = new DataView(memory.buffer, 128, 96);
    const put = (index: number, value: number): void => response.setUint32(index * 4, value, true);
    put(0, 2);
    put(1, 5);
    put(2, 0);
    put(3, 1);
    put(4, 1);
    put(9, 65_536);
    put(10, 65_536);
    const fakeExports = {
      memory,
      vp8_v2_abi_version: () => 2,
      vp8_v2_request_ptr: () => 64,
      vp8_v2_response_ptr: () => 128,
      vp8_v2_plan: () => 5,
      vp8_v2_reserve_step: () => 0,
      vp8_v2_begin: () => 10,
      vp8_v2_step: () => 10,
      vp8_v2_abort: vi.fn(() => 9),
      vp8_v2_release_input: () => 0,
      vp8_v2_release_output: () => 0,
      vp8_v2_retire: vi.fn(() => 0),
    };
    const ledger = accounting();
    const instance = { exports: fakeExports } as unknown as WebAssembly.Instance;
    const partition = new core.OwnedVp8Encoder(instance, { accounting: ledger }, 65_536);
    await expect(partition.encode(pixels(), settings(), () => undefined)).rejects.toBeInstanceOf(
      core.OwnedVp8PartitionLimitError
    );
    expect(fakeExports.vp8_v2_retire).toHaveBeenCalledTimes(1);
    expect(ledger.release).toHaveBeenCalledTimes(1);
    fakeExports.vp8_v2_plan = () => {
      throw new WebAssembly.RuntimeError('trap');
    };
    const trapped = new core.OwnedVp8Encoder(instance, { accounting: accounting() }, 65_536);
    await expect(trapped.encode(pixels(), settings(), () => undefined)).rejects.toBeInstanceOf(
      core.OwnedVp8TrapError
    );
  });
});
