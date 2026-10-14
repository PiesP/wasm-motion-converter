// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  finishProgressObservation,
  installProgressObservation,
} from '../e2e/fixtures/progress-observation';

class FixtureWorker extends EventTarget {
  constructor(_url: string | URL, _options?: WorkerOptions) {
    super();
  }
}

describe('progress observation evidence', () => {
  afterEach(() => {
    try {
      finishProgressObservation();
    } catch {
      // The test already finalized its observer.
    }
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('keeps missing DOM distinct from numeric zero and captures useful changes at the same count', async () => {
    document.body.innerHTML = '<div role="progressbar"></div>';
    installProgressObservation('gif-main');
    const bar = document.querySelector('[role="progressbar"]')!;
    bar.setAttribute('data-progress', 'invalid');
    await Promise.resolve();
    bar.setAttribute('data-progress', '12');
    const details = document.createElement('details');
    details.dataset.testid = 'progress-diagnostics';
    details.textContent = 'Frame 2/360 — Decoding @ 5 fps';
    document.body.append(details);
    await Promise.resolve();
    bar.setAttribute('data-progress', '13');
    details.textContent = 'Frame 2/360 — Decoding @ 7 fps';
    await Promise.resolve();
    details.textContent = 'Frame 2/360 — Encoding @ 7 fps';
    await Promise.resolve();

    const observation = finishProgressObservation();
    const dom = observation.records.filter((record) => record.kind === 'dom');
    expect(dom[0]).toMatchObject({ percent: null, current: null });
    expect(dom[0]?.problems).toContain('missing-progress-attribute');
    expect(dom.some((record) => record.problems?.includes('invalid-progress-attribute'))).toBe(
      true
    );
    expect(
      dom.some((record) => record.percent === 12 && record.current === 2 && record.fps === 5)
    ).toBe(true);
    expect(
      dom.some((record) => record.percent === 13 && record.current === 2 && record.fps === 7)
    ).toBe(true);
    expect(dom.some((record) => record.phase === 'Encoding' && record.current === 2)).toBe(true);
    expect(observation.dropped).toBe(0);
    expect(observation.records.map((record) => record.sequence)).toEqual(
      observation.records.map((_, index) => index + 1)
    );
  });

  it('drains a pending attribute mutation before disconnecting', () => {
    document.body.innerHTML = '<div role="progressbar" data-progress="1"></div>';
    installProgressObservation('gif-main');
    document.querySelector('[role="progressbar"]')?.setAttribute('data-progress', '77');
    const observation = finishProgressObservation();
    expect(observation.records).toContainEqual(
      expect.objectContaining({ kind: 'progress-attribute', oldProgress: '1', rawProgress: '77' })
    );
    expect(observation.records).toContainEqual(
      expect.objectContaining({ kind: 'dom', cause: 'final', percent: 77 })
    );
    expect('__wmcProgressObservation' in globalThis).toBe(false);
  });

  it('observes real Worker message delivery without swallowing the consumer listener', () => {
    vi.stubGlobal('Worker', FixtureWorker);
    const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    document.body.innerHTML = '<div role="progressbar" data-progress="1"></div>';
    installProgressObservation('gif-worker');
    const worker = new Worker('/conversion-worker.js');
    expect(worker).toBeInstanceOf(FixtureWorker);
    const receiver = vi.fn();
    worker.addEventListener('message', receiver);
    worker.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'progress',
          requestId: 'request-1',
          percent: 42,
          currentFrame: 12,
          totalFrames: 360,
          decodedFrames: 12,
          selectedFrames: 4,
          encodedFrames: 3,
          fps: 18,
          phase: 'decoding',
        },
      })
    );
    expect(receiver).toHaveBeenCalledOnce();
    const observation = finishProgressObservation();
    expect(observation.records.find((record) => record.kind === 'worker-receive')).toMatchObject({
      requestId: 'request-1',
      percent: 42,
      current: 12,
      total: 360,
      decoded: 12,
      selected: 4,
      encoded: 3,
      fps: 18,
      phase: 'decoding',
    });
    expect(globalThis.Worker).toBe(FixtureWorker);
    expect(Object.getOwnPropertyDescriptor(globalThis, 'Worker')).toEqual(originalWorkerDescriptor);
    expect('__wmcProgressObservation' in globalThis).toBe(false);
    worker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'progress', requestId: 'request-1', percent: 99 },
      })
    );
    expect(receiver).toHaveBeenCalledTimes(2);
    expect(observation.records.filter((record) => record.kind === 'worker-receive')).toHaveLength(
      1
    );
  });

  it('disconnects an installed observer when Worker wrapping fails during setup', () => {
    const NativeMutationObserver = globalThis.MutationObserver;
    const disconnect = vi.fn();
    class ObservedMutationObserver extends NativeMutationObserver {
      override disconnect(): void {
        disconnect();
        super.disconnect();
      }
    }
    vi.stubGlobal('MutationObserver', ObservedMutationObserver);
    vi.stubGlobal('Worker', undefined);
    document.body.innerHTML = '<div role="progressbar" data-progress="1"></div>';

    expect(() => installProgressObservation('gif-worker')).toThrow();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(globalThis.Worker).toBeUndefined();
    expect('__wmcProgressObservation' in globalThis).toBe(false);
    expect(() => finishProgressObservation()).toThrow('not active');
  });

  it('records bounded overflow without an asynchronous throw and drains pending mutations on finish', () => {
    vi.stubGlobal('Worker', FixtureWorker);
    document.body.innerHTML = '<div role="progressbar" data-progress="1"></div>';
    installProgressObservation('gif-worker');
    const worker = new Worker('/conversion-worker.js');
    for (let index = 0; index < 520; index++) {
      worker.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'progress', requestId: 'request-2', currentFrame: index, percent: index },
        })
      );
    }
    document.querySelector('[role="progressbar"]')?.setAttribute('data-progress', '99');
    const observation = finishProgressObservation();
    expect(observation.records).toHaveLength(observation.limit);
    expect(observation.dropped).toBeGreaterThan(0);
    expect(observation.firstDroppedSequence).toBe(observation.limit + 1);
    expect(globalThis.Worker).toBe(FixtureWorker);
    expect('__wmcProgressObservation' in globalThis).toBe(false);
  });
});
