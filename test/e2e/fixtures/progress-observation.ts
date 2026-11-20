// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Page-clock observations for the real conversion route; no Worker clock is compared. */
export interface ProgressObservationRecord {
  sequence: number;
  kind: 'dom' | 'progress-attribute' | 'worker-receive';
  atMs: number;
  timeOrigin: number;
  route: string;
  runKey: string;
  requestId: string | null;
  state: string;
  cause?: string;
  messageType?: string;
  percent?: number | null;
  current?: number | null;
  total?: number | null;
  decoded?: number | null;
  selected?: number | null;
  encoded?: number | null;
  fps?: number | null;
  phase?: string | null;
  rawProgress?: string | null;
  oldProgress?: string | null;
  statusText?: string | null;
  diagnosticsText?: string | null;
  problems?: string[];
}

export interface ProgressObservation {
  route: string;
  runKey: string;
  timeOrigin: number;
  limit: number;
  dropped: number;
  firstDroppedSequence: number | null;
  gifCopyHeld: boolean;
  gifCopyReleasedForProgress: boolean;
  cleanupErrors: string[];
  records: ProgressObservationRecord[];
}

interface ActiveObservation {
  finish(): ProgressObservation;
  releaseGifCopyAfterProgress(totalFrames: number): boolean;
}

const gifCopyMessage = 'wmc-test:gif-progress-copy';
const gifCopyCleanup = `${gifCopyMessage}:cleanup`;

function paceGifFrameCopies(onHold: () => void): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(VideoFrame.prototype, 'copyTo');
  if (!descriptor) throw new Error('Missing native VideoFrame.copyTo');
  const nativeCopy = VideoFrame.prototype.copyTo;
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  let remaining = 7;
  let active = true;
  Object.defineProperty(VideoFrame.prototype, 'copyTo', {
    ...descriptor,
    value: async function (this: VideoFrame, ...args: Parameters<VideoFrame['copyTo']>) {
      const planes = await nativeCopy.apply(this, args);
      if (active && remaining > 0) {
        // Give the real producer time to report intermediate progress across
        // its 100 ms throttle. The seventh copy prevents terminal progress
        // until the page has observed a genuine intermediate DOM update.
        if (--remaining === 0) {
          onHold();
          await released;
        } else {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              released,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 120);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
      }
      return planes;
    },
  });
  return () => {
    if (!active) return;
    active = false;
    release();
    Object.defineProperty(VideoFrame.prototype, 'copyTo', descriptor);
  };
}

export function installGifProgressWorkerCopyGate(): void {
  const release = paceGifFrameCopies(() => {
    self.postMessage({ type: gifCopyMessage, state: 'held' });
  });
  const onMessage = (event: MessageEvent<unknown>) => {
    if (event.data !== gifCopyMessage && event.data !== gifCopyCleanup) return;
    event.stopImmediatePropagation();
    self.removeEventListener('message', onMessage);
    release();
    if (event.data === gifCopyMessage)
      self.postMessage({ type: gifCopyMessage, state: 'released' });
  };
  self.addEventListener('message', onMessage);
  self.postMessage({ type: gifCopyMessage, state: 'armed' });
}

export function installProgressObservation(route: string): void {
  const host = globalThis as typeof globalThis & { __wmcProgressObservation?: ActiveObservation };
  if (host.__wmcProgressObservation) throw new Error('Progress observation is already active');

  const limit = 512;
  const runKey = `${route}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const timeOrigin = performance.timeOrigin;
  const records: ProgressObservationRecord[] = [];
  let sequence = 0;
  let dropped = 0;
  let firstDroppedSequence: number | null = null;
  let requestId: string | null = null;
  let lastDomKey: string | null = null;
  let active = true;
  let gifCopyStatus: 'waiting' | 'held' | 'releasing' | 'released' = 'waiting';
  let releaseMainCopy: (() => void) | undefined;
  let gifWorker: Worker | undefined;
  const cleanupErrors: string[] = [];
  const workerListeners: Array<{
    worker: Worker;
    listener: (event: MessageEvent<unknown>) => void;
  }> = [];

  const state = (): string => {
    try {
      return (
        (
          globalThis as typeof globalThis & { __TEST_HELPERS__?: { getAppState(): string } }
        ).__TEST_HELPERS__?.getAppState() ?? 'unknown'
      );
    } catch {
      return 'state-read-error';
    }
  };
  const numberField = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const record = (
    entry: Pick<ProgressObservationRecord, 'kind'> & Partial<ProgressObservationRecord>
  ): void => {
    if (!active) return;
    sequence++;
    if (records.length >= limit) {
      dropped++;
      firstDroppedSequence ??= sequence;
      return;
    }
    records.push({
      ...entry,
      sequence,
      atMs: performance.now(),
      timeOrigin,
      route,
      runKey,
      requestId: entry.requestId ?? requestId,
      state: state(),
    });
  };

  const captureDom = (cause: string): void => {
    const bar = document.querySelector('[role="progressbar"]');
    const diagnostics = document.querySelector('[data-testid="progress-diagnostics"]');
    const rawProgress = bar?.getAttribute('data-progress') ?? null;
    const fullDiagnosticsText = diagnostics?.textContent ?? null;
    const diagnosticsText = fullDiagnosticsText?.slice(0, 240) ?? null;
    const statusText =
      document
        .querySelector('[data-testid="progress-status-message"]')
        ?.textContent?.slice(0, 160) ?? null;
    const count = fullDiagnosticsText ? /Frame\s+(\d+)\/(\d+)/i.exec(fullDiagnosticsText) : null;
    const rate = fullDiagnosticsText ? /@\s+([\d.]+)\s+fps/i.exec(fullDiagnosticsText) : null;
    const phase = fullDiagnosticsText ? (/—\s+(\w+)/.exec(fullDiagnosticsText)?.[1] ?? null) : null;
    const percent = rawProgress === null || rawProgress.trim() === '' ? null : Number(rawProgress);
    const problems: string[] = [];
    if (!bar) problems.push('missing-progressbar');
    else if (rawProgress === null) problems.push('missing-progress-attribute');
    else if (!Number.isFinite(percent)) problems.push('invalid-progress-attribute');
    if (!diagnostics) problems.push('missing-diagnostics');
    else if (!count) problems.push('unparsed-frame-count');
    if (diagnostics && !phase) problems.push('unparsed-phase');
    const current = count ? Number(count[1]) : null;
    const total = count ? Number(count[2]) : null;
    const fps = rate ? Number(rate[1]) : null;
    const key = JSON.stringify([
      rawProgress,
      current,
      total,
      fps,
      phase,
      statusText,
      problems,
      state(),
    ]);
    if (cause === 'mutation' && key === lastDomKey) return;
    lastDomKey = key;
    record({
      kind: 'dom',
      cause,
      percent: Number.isFinite(percent) ? percent : null,
      current,
      total,
      fps: Number.isFinite(fps) ? fps : null,
      phase,
      rawProgress,
      statusText,
      diagnosticsText,
      problems,
    });
  };

  const captureMutations = (mutations: MutationRecord[]): void => {
    for (const mutation of mutations) {
      if (
        mutation.type !== 'attributes' ||
        mutation.attributeName !== 'data-progress' ||
        !(mutation.target instanceof Element) ||
        mutation.target.getAttribute('role') !== 'progressbar'
      ) {
        continue;
      }
      record({
        kind: 'progress-attribute',
        oldProgress: mutation.oldValue,
        rawProgress: mutation.target.getAttribute('data-progress'),
      });
    }
    captureDom('mutation');
  };
  const observer = new MutationObserver(captureMutations);
  const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  let workerWrapped = false;
  const cleanup = (): void => {
    active = false;
    observer.disconnect();
    try {
      releaseMainCopy?.();
      if (gifWorker && (gifCopyStatus === 'waiting' || gifCopyStatus === 'held')) {
        gifWorker.postMessage(gifCopyCleanup);
      }
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    for (const { worker, listener } of workerListeners) {
      try {
        worker.removeEventListener('message', listener);
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    }
    workerListeners.length = 0;
    try {
      if (workerWrapped) {
        if (originalWorkerDescriptor) {
          Object.defineProperty(globalThis, 'Worker', originalWorkerDescriptor);
        } else if (!Reflect.deleteProperty(globalThis, 'Worker')) {
          cleanupErrors.push('Worker constructor could not be restored');
        }
      }
    } catch (error) {
      cleanupErrors.push(String(error));
    } finally {
      delete host.__wmcProgressObservation;
    }
  };

  try {
    observer.observe(document.body, {
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
      childList: true,
      subtree: true,
    });
    captureDom('start');

    if (route === 'gif-main') {
      releaseMainCopy = paceGifFrameCopies(() => {
        gifCopyStatus = 'held';
      });
    } else if (route === 'gif-worker') {
      const NativeWorker = globalThis.Worker;
      class ObservedWorker extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          const listener = (event: MessageEvent<unknown>): void => {
            if (!event.data || typeof event.data !== 'object') return;
            const message = event.data as Record<string, unknown>;
            if (message.type === gifCopyMessage) {
              event.stopImmediatePropagation();
              if (message.state === 'armed' && !gifWorker) {
                gifWorker = this;
              } else if (message.state === 'held' && this === gifWorker) {
                gifCopyStatus = 'held';
              } else if (
                message.state === 'released' &&
                this === gifWorker &&
                gifCopyStatus === 'releasing'
              ) {
                gifCopyStatus = 'released';
              }
              return;
            }
            if (
              message.type !== 'progress' &&
              message.type !== 'complete' &&
              message.type !== 'error'
            ) {
              return;
            }
            const messageRequestId =
              typeof message.requestId === 'string' ? message.requestId : null;
            requestId ??= messageRequestId;
            record({
              kind: 'worker-receive',
              messageType: message.type,
              requestId: messageRequestId,
              percent: numberField(message.percent),
              current: numberField(message.currentFrame),
              total: numberField(message.totalFrames),
              decoded: numberField(message.decodedFrames),
              selected: numberField(message.selectedFrames),
              encoded: numberField(message.encodedFrames),
              fps: numberField(message.fps),
              phase: typeof message.phase === 'string' ? message.phase : null,
            });
          };
          this.addEventListener('message', listener);
          workerListeners.push({ worker: this, listener });
        }
      }
      Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        writable: true,
        value: ObservedWorker,
      });
      workerWrapped = true;
    }

    host.__wmcProgressObservation = {
      releaseGifCopyAfterProgress(totalFrames) {
        if (gifCopyStatus === 'released') return true;
        if (gifCopyStatus !== 'held') return false;
        const observed = records.some(
          (sample) =>
            sample.kind === 'dom' &&
            sample.state === 'converting' &&
            (sample.current ?? 0) > 1 &&
            (sample.current ?? totalFrames) < totalFrames &&
            (sample.percent ?? 100) < 100 &&
            (sample.fps ?? 0) > 0
        );
        if (!observed) return false;
        if (releaseMainCopy) {
          releaseMainCopy();
          gifCopyStatus = 'released';
          return true;
        } else if (gifWorker) {
          gifWorker.postMessage(gifCopyMessage);
          gifCopyStatus = 'releasing';
        }
        return false;
      },
      finish: () => {
        try {
          captureMutations(observer.takeRecords());
          captureDom('final');
          return {
            route,
            runKey,
            timeOrigin,
            limit,
            dropped,
            firstDroppedSequence,
            gifCopyHeld: gifCopyStatus !== 'waiting',
            gifCopyReleasedForProgress: gifCopyStatus === 'released',
            cleanupErrors,
            records,
          };
        } finally {
          cleanup();
        }
      },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Self-contained companion for page.waitForFunction. */
export function releaseGifCopyAfterProgress(totalFrames: number): boolean {
  const host = globalThis as typeof globalThis & { __wmcProgressObservation?: ActiveObservation };
  if (!host.__wmcProgressObservation) throw new Error('Progress observation is not active');
  return host.__wmcProgressObservation.releaseGifCopyAfterProgress(totalFrames);
}

/** Self-contained companion to installProgressObservation for page.evaluate. */
export function finishProgressObservation(): ProgressObservation {
  const host = globalThis as typeof globalThis & { __wmcProgressObservation?: ActiveObservation };
  if (!host.__wmcProgressObservation) throw new Error('Progress observation is not active');
  return host.__wmcProgressObservation.finish();
}
