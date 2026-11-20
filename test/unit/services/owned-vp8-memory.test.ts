// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { globalBufferPool } from '@services/buffer-pool';
import { ConversionMemoryLimitError } from '@services/conversion-memory-limit-error';
import type { DemuxResult } from '@services/demuxer-service';
import { WebpFrameMemoryBudget } from '@services/frame-memory';
import {
  createOwnedVp8Encoder,
  OwnedVp8CancelledError,
  OwnedVp8MemoryAdmissionError,
} from '@services/owned-vp8-core';
import { OwnedVp8MemoryBroker } from '@services/owned-vp8-memory';
import { getOwnedVp8ModuleBytes } from '@services/owned-vp8-module-state';
import { StreamingWebpMuxer } from '@services/streaming-webp-encoder';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const MIB = 1024 * 1024;

function fixture(inputBufferBytes = 0, indexSnapshotBytes = 0, maxOutputBytes?: number) {
  const frames = new WebpFrameMemoryBudget({
    codedWidth: 8,
    codedHeight: 8,
    displayWidth: 8,
    displayHeight: 8,
    targetWidth: 8,
    targetHeight: 8,
    workerCount: 1,
    serialSoftware: true,
    sourceHeadroomFrames: 1,
  });
  const demux = {
    inputBufferBytes,
    indexSnapshotBytes,
  } as DemuxResult;
  const appGuard = vi.fn();
  const muxer = new StreamingWebpMuxer(8, 8, { maxOutputBytes });
  const broker = new OwnedVp8MemoryBroker(demux, frames, muxer, appGuard, maxOutputBytes);
  return { broker, frames, muxer, appGuard };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalBufferPool.clear();
});

describe('owned VP8 conversion-wide admission', () => {
  function largeFixture(inputBufferBytes: number, muxBytes: number, guard = vi.fn()) {
    const width = 3840;
    const height = 2160;
    const frames = new WebpFrameMemoryBudget({
      codedWidth: width,
      codedHeight: height,
      displayWidth: width,
      displayHeight: height,
      targetWidth: width,
      targetHeight: height,
      workerCount: 1,
      serialSoftware: true,
      sourceHeadroomFrames: 1,
    });
    // The mux owns bytes here; the test does not allocate a 90 MiB output.
    const muxer = { retainedBytes: muxBytes } as unknown as StreamingWebpMuxer;
    const broker = new OwnedVp8MemoryBroker(
      { inputBufferBytes } as DemuxResult,
      frames,
      muxer,
      guard
    );
    return { broker, frames, guard };
  }

  it('rejects a new 4K source before retaining it while an encoder target is held', async () => {
    const { broker, frames } = largeFixture(26 * MIB, 90 * MIB);
    const target = await frames.acquireTarget();
    broker.reserve(82.1875 * MIB, 0);
    expect(broker.frameLiveBytes / MIB).toBe(126.921875);
    expect(() => frames.tryReserveSource(63.28125 * MIB)).toThrow(OwnedVp8MemoryAdmissionError);
    expect(frames.usage.sourceBytes).toBe(0);
    expect(frames.usage.targetBytes).toBeGreaterThan(0);
    target.release();
    broker.dispose();
    frames.dispose();
  });

  it('applies the stricter app guard to a Blob-input source before retention', async () => {
    const guard = vi.fn((additionalBytes: number) => {
      if (Math.ceil(additionalBytes / MIB) >= 512 * 0.9)
        throw new ConversionMemoryLimitError('application memory limit');
    });
    const { broker, frames } = largeFixture(0, 90 * MIB, guard);
    const target = await frames.acquireTarget();
    broker.reserve(82.1875 * MIB, 0);
    expect(() => frames.tryReserveSource(63.28125 * MIB)).toThrow(ConversionMemoryLimitError);
    expect(frames.usage.sourceBytes).toBe(0);
    target.release();
    broker.dispose();
    frames.dispose();
  });

  it('admits a below-limit source and checks new pooled bytes before allocation', async () => {
    const { broker, frames } = largeFixture(0, 20 * MIB);
    const target = await frames.acquireTarget();
    broker.reserve(82.1875 * MIB, 0);
    const source = frames.tryReserveSource(63.28125 * MIB);
    expect(source).not.toBeNull();
    source?.release();
    target.release();
    broker.dispose();
    frames.dispose();

    const nearLimit = fixture(0);
    nearLimit.broker.reserve(383 * MIB, 0);
    expect(() => globalBufferPool.acquire(2 * MIB)).toThrow(OwnedVp8MemoryAdmissionError);
    expect(globalBufferPool.totalRetainedMemory).toBe(0);
    expect(() => globalBufferPool.release(new Uint8Array(2 * MIB))).toThrow(
      OwnedVp8MemoryAdmissionError
    );
    expect(globalBufferPool.totalRetainedMemory).toBe(0);
    nearLimit.broker.dispose();
    nearLimit.frames.dispose();
    expect(globalBufferPool.acquire(2 * MIB).byteLength).toBe(2 * MIB);
  });

  it('guards target, analysis, and result growth without changing native budgets', async () => {
    const { broker, frames } = fixture();
    broker.reserve(384 * MIB - 512, 0);
    await expect(frames.acquireTarget()).rejects.toThrow(OwnedVp8MemoryAdmissionError);
    expect(frames.usage.targetBytes).toBe(0);
    expect(() => frames.reserveAnalysis(2 * MIB)).toThrow(OwnedVp8MemoryAdmissionError);
    expect(frames.usage.analysisBytes).toBe(0);
    broker.dispose();
    frames.dispose();

    const next = fixture();
    const target = await next.frames.acquireTarget();
    next.broker.reserve(383 * MIB, 0);
    expect(() => target.reserveResultBytes(2 * MIB)).toThrow(OwnedVp8MemoryAdmissionError);
    expect(next.frames.usage.resultBytes).toBe(0);
    target.release();
    next.broker.dispose();
    next.frames.dispose();

    const native = new WebpFrameMemoryBudget({
      codedWidth: 8,
      codedHeight: 8,
      displayWidth: 8,
      displayHeight: 8,
      targetWidth: 8,
      targetHeight: 8,
      workerCount: 1,
    });
    expect(native.tryReserveSource(2 * MIB)).not.toBeNull();
    native.dispose();
  });
  it('charges original input outside demux and all idle pooled bytes before reserve', () => {
    const idle = globalBufferPool.acquire(16 * MIB);
    globalBufferPool.release(idle);
    const { broker, frames } = fixture(180 * MIB);
    expect(() => broker.reserve(192 * MIB, 0)).toThrow(OwnedVp8MemoryAdmissionError);
    broker.dispose();
    frames.dispose();
  });

  it('counts two index copies within demux once and credits an active target pool buffer', async () => {
    const { broker, frames, appGuard } = fixture(0, 60 * MIB);
    const target = await frames.acquireTarget();
    const pixels = globalBufferPool.acquire(8 * 8 * 3);
    expect(broker.frameLiveBytes).toBe(frames.usage.totalBytes);
    broker.reserve(65_536, 0);
    const fullEstimate = 128 * MIB + frames.usage.totalBytes + 65_536;
    expect(appGuard).toHaveBeenLastCalledWith(fullEstimate - 120 * MIB - pixels.byteLength);
    target.release();
    globalBufferPool.release(pixels);
    broker.dispose();
    frames.dispose();
  });

  it('admits the existing large RGB workload without charging retained RGBA scratch twice', async () => {
    const width = 4096,
      height = 2457;
    const frames = new WebpFrameMemoryBudget({
      codedWidth: width,
      codedHeight: height,
      displayWidth: width,
      displayHeight: height,
      targetWidth: width,
      targetHeight: height,
      workerCount: 1,
      serialSoftware: true,
      sourceHeadroomFrames: 1,
    });
    const target = await frames.acquireTarget();
    const muxer = new StreamingWebpMuxer(width, height);
    const broker = new OwnedVp8MemoryBroker(
      { inputBufferBytes: 0 } as DemuxResult,
      frames,
      muxer,
      () => undefined
    );
    broker.reserve(112 * MIB, 0);
    const rgb = globalBufferPool.acquire(width * height * 3);
    const rgba = globalBufferPool.acquire(width * height * 4);
    globalBufferPool.release(rgba);
    expect(globalBufferPool.totalPooledMemory).toBe(64 * MIB);
    expect(globalBufferPool.totalActiveMemory).toBe(32 * MIB);
    expect(broker.frameLiveBytes).toBe(frames.usage.totalBytes);
    expect(() => broker.observe(112 * MIB)).not.toThrow();
    target.release();
    globalBufferPool.release(rgb);
    // After the target reservation ends, both retained buffers remain charged.
    expect(broker.frameLiveBytes).toBe(frames.usage.totalBytes + 96 * MIB);
    broker.dispose();
    frames.dispose();
  });

  it('settles the stricter application guard before accepting a linear reservation', () => {
    const { broker, frames, appGuard } = fixture();
    appGuard.mockImplementationOnce(() => {
      throw new Error('application limit');
    });
    expect(() => broker.reserve(65_536, 0)).toThrow('application limit');
    expect(() => broker.observe(1)).toThrow(OwnedVp8MemoryAdmissionError);
    broker.reserve(65_536, 0);
    broker.observe(65_536);
    broker.dispose();
    frames.dispose();
  });

  it('charges the copied output once as ownership moves to the mux', () => {
    const { broker, frames, muxer, appGuard } = fixture();
    const raw = new Uint8Array([0x30, 0, 0, 0x9d, 1, 0x2a, 8, 0, 8, 0, 0, 0]);
    broker.reserve(65_536, raw.byteLength);
    const beforeCopy = appGuard.mock.lastCall?.[0];
    muxer.addPresentationFrame(raw, { startUs: 0, endUs: 50_000 });
    broker.presentationCopySettled();
    broker.observe(65_536);
    expect(appGuard).toHaveBeenLastCalledWith(beforeCopy);
    broker.release();
    broker.assertFinishPresentation(50_000);
    muxer.finishPresentation(50_000);
    broker.assertFinalization();
    const finalCharge = appGuard.mock.lastCall?.[0];
    appGuard.mockClear();
    const buffer = globalBufferPool.acquire(1);
    expect(appGuard.mock.lastCall?.[0]).toBeGreaterThanOrEqual(finalCharge);
    globalBufferPool.release(buffer);
    broker.dispose();
    frames.dispose();
  });

  it('refuses the overlapping mux memory when the final container fits its byte limit', () => {
    const { broker, frames, muxer } = fixture(0, 0, 1024);
    const raw = new Uint8Array(600);
    // A synthetic packet with a valid frame tag and geometry for the mux header check.
    raw.set([0x30, 0, 0, 0x9d, 1, 0x2a, 8, 0, 8, 0]);
    try {
      broker.reserve(65_536, raw.byteLength);
      broker.assertPresentationCopy(0);
      muxer.addPresentationFrame(raw, { startUs: 0, endUs: 50_000 });
      broker.presentationCopySettled();
      broker.release();

      expect(muxer.retainedBytes).toBe(600);
      expect(muxer.retainedBeforeFinishPresentation(50_000)).toBe(1276);
      const admit = () => broker.assertFinishPresentation(50_000);
      expect(admit).toThrow(OwnedVp8MemoryAdmissionError);
      expect(admit).toThrow('live mux memory exceeds 1024 bytes (1276 bytes required)');

      // The file-only mux limit admits the frame when the broker is bypassed.
      muxer.finishPresentation(50_000);
      expect(muxer.retainedBytes).toBe(676);
    } finally {
      broker.dispose();
      frames.dispose();
    }
  });

  it('includes pending duplication, ANMF headers, and final emitted chunks in preflight', () => {
    const { broker, frames, muxer } = fixture();
    const first = new Uint8Array([0x30, 0, 0, 0x9d, 1, 0x2a, 8, 0, 8, 0, 0, 0]);
    const second = Uint8Array.from(first);
    second[10] = 1;
    muxer.addPresentationFrame(first, { startUs: 0, endUs: 50_000 });
    expect(muxer.frameBytes).toBe(first.byteLength);
    expect(muxer.retainedBytes).toBe(first.byteLength);
    const firstPeak = muxer.retainedBeforePresentationCopy(50_000);
    expect(firstPeak).toBeGreaterThan(muxer.retainedBytes + first.byteLength + 32);
    broker.reserve(65_536, second.byteLength);
    broker.assertPresentationCopy(50_000);
    muxer.addPresentationFrame(second, { startUs: 50_000, endUs: 100_000 });
    expect(muxer.retainedBeforeFinishPresentation(100_000)).toBeGreaterThan(muxer.retainedBytes);
    broker.release();
    broker.assertFinishPresentation(100_000);
    muxer.finishPresentation(100_000);
    broker.assertFinalization();
    broker.dispose();
    frames.dispose();
  });

  it('preserves the cold charge during broker teardown and admits it once in a replacement', async () => {
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 5, 1, 1, 1, 128, 24]);
    const entered = Promise.withResolvers<void>();
    const physical = Promise.withResolvers<WebAssembly.Module>();
    vi.spyOn(WebAssembly, 'compile').mockImplementationOnce(() => {
      entered.resolve();
      return physical.promise;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(bytes, {
          headers: { 'content-type': 'application/wasm' },
        })
      )
    );
    const first = fixture();
    const controller = new AbortController();
    const task = createOwnedVp8Encoder({ accounting: first.broker, signal: controller.signal });
    await entered.promise;
    controller.abort();
    await expect(task).rejects.toBeInstanceOf(OwnedVp8CancelledError);
    first.broker.dispose();
    first.frames.dispose();

    const replacement = fixture();
    try {
      const stagingAndLogicalBytes = 482_273 + bytes.byteLength;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(getOwnedVp8ModuleBytes()).toBe(stagingAndLogicalBytes);
      const available = 384 * MIB - replacement.frames.usage.totalBytes;
      expect(() => replacement.broker.reserve(available - stagingAndLogicalBytes + 1, 0)).toThrow(
        OwnedVp8MemoryAdmissionError
      );
      replacement.broker.reserve(available - stagingAndLogicalBytes, 0);
      expect(replacement.appGuard).toHaveBeenLastCalledWith(512 * MIB - stagingAndLogicalBytes);
      physical.reject(new WebAssembly.CompileError('late compiler rejection'));
      await vi.waitFor(() => expect(getOwnedVp8ModuleBytes()).toBe(0));
      replacement.broker.reserve(available, 0);
    } finally {
      replacement.broker.dispose();
      replacement.frames.dispose();
    }
  });
});
