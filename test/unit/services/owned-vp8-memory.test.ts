// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { globalBufferPool } from '@services/buffer-pool';
import type { DemuxResult } from '@services/demuxer-service';
import { WebpFrameMemoryBudget } from '@services/frame-memory';
import { OwnedVp8MemoryAdmissionError } from '@services/owned-vp8-core';
import { OwnedVp8MemoryBroker } from '@services/owned-vp8-memory';
import { StreamingWebpMuxer } from '@services/streaming-webp-encoder';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const MIB = 1024 * 1024;

function fixture(inputBufferBytes = 0, indexSnapshotBytes = 0) {
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
  const muxer = new StreamingWebpMuxer(8, 8);
  const broker = new OwnedVp8MemoryBroker(demux, frames, muxer, appGuard);
  return { broker, frames, muxer, appGuard };
}

afterEach(() => globalBufferPool.clear());

describe('owned VP8 conversion-wide admission', () => {
  it('charges original input outside demux and all idle pooled bytes before reserve', () => {
    const { broker, frames } = fixture(180 * MIB);
    broker.reserve(192 * MIB, 0);
    const idle = globalBufferPool.acquire(16 * MIB);
    globalBufferPool.release(idle);
    expect(() => broker.reserve(192 * MIB, 0)).toThrow(OwnedVp8MemoryAdmissionError);
    broker.release();
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
    broker.release();
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
    broker.release();
    frames.dispose();
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
    frames.dispose();
  });
});
