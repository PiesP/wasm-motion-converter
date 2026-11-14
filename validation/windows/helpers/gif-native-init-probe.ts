// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import type { CDPSession, Page } from '@playwright/test';

const BINDING = '__wmcGifNativeInitProbe_v1';
const EXPECTED_RGBA_BYTES = 160 * 90 * 4;
const CHILD_COMMAND_TIMEOUT_MS = 1500;
const MAX_ERRORS = 12;

/** Static worker-realm diagnostic. It neither pauses the Worker nor substitutes WASM. */
const INSTALL_EXPRESSION = String.raw`(() => {
  const proto = WebAssembly.Instance.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'exports');
  if (!descriptor || !descriptor.configurable || typeof descriptor.get !== 'function')
    return { status: 'unavailable', reason: 'native-exports-getter-not-configurable' };
  const nativeGet = descriptor.get;
  const facadeByInstance = new WeakMap();
  let reported = false;
  const restore = () => {
    if (Object.getOwnPropertyDescriptor(proto, 'exports')?.get === observedGet)
      Object.defineProperty(proto, 'exports', descriptor);
  };
  function observedGet() {
    const native = nativeGet.call(this);
    if (facadeByInstance.has(this)) return facadeByInstance.get(this);
    try {
      if (typeof native.abi_version !== 'function' ||
          typeof native.enable_retained !== 'function' ||
          native.abi_version() !== 3) return native;
      const descriptors = Object.getOwnPropertyDescriptors(native);
      const enable = native.enable_retained;
      descriptors.enable_retained = {
        ...descriptors.enable_retained,
        value: function (...args) {
          const status = Reflect.apply(enable, native, args);
          if (!reported && args[0] === 57600 && status === 0) {
            reported = true;
            try {
              globalThis.__wmcGifNativeInitProbe_v1(JSON.stringify({
                type: 'retained-init',
                length: args[0],
                status,
                abi: native.abi_version(),
                memoryBytes: native.memory.buffer.byteLength,
                workerClockMs: performance.now(),
              }));
            } catch { /* Observation must not alter the native return. */ }
            try { restore(); } catch { /* The facade still owns the original exports. */ }
          }
          return status;
        },
      };
      const facade = Object.create(Object.getPrototypeOf(native));
      Object.defineProperties(facade, descriptors);
      facadeByInstance.set(this, facade);
      return facade;
    } catch {
      // Instrumentation failure leaves the original native exports untouched.
      return native;
    }
  }
  Object.defineProperty(proto, 'exports', { ...descriptor, get: observedGet });
  globalThis.__wmcGifNativeInitProbeRestore_v1 = restore;
  return { status: 'installed', configurable: descriptor.configurable };
})()`;

export type GifNativeInitEvidence = {
  type: 'retained-init';
  length: number;
  status: number;
  abi: number;
  memoryBytes: number;
  workerClockMs: number;
  workerUrl: string;
  sourceAssetSha256: string;
};

type StopResult = { clicked: boolean; reason: string };
type PendingCommand = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type GifNativeInitProbe = {
  snapshot: () => Record<string, unknown>;
  settle: () => Promise<void>;
  dispose: () => Promise<void>;
};

/** Auto-attach before Convert; every child Runtime command is passive and bounded. */
export async function armGifNativeInitProbe(
  page: Page,
  sourceAssetSha256: string,
  onNativeInit: (evidence: GifNativeInitEvidence) => Promise<StopResult>
): Promise<GifNativeInitProbe> {
  const errors: string[] = [];
  const recordError = (error: unknown) => {
    if (errors.length < MAX_ERRORS)
      errors.push(
        error instanceof Error
          ? `${error.name}: ${error.message}`.slice(0, 300)
          : String(error).slice(0, 300)
      );
  };
  let session: CDPSession | null = null;
  let autoAttachArmed = false;
  let childSessionId: string | null = null;
  let workerUrl: string | null = null;
  let attachedAtMs: number | null = null;
  let waitingForDebugger: boolean | null = null;
  let installedAtMs: number | null = null;
  let installResult: Record<string, unknown> | null = null;
  let nativeEvidence: GifNativeInitEvidence | null = null;
  let stopResult: StopResult | null = null;
  let callbackTask: Promise<void> | null = null;
  let callbackSettled = false;
  let disposed = false;
  let nextId = 1;
  const pending = new Map<number, PendingCommand>();
  const expectedOrigin = new URL(page.url()).origin;

  const sendChild = (method: string, params: Record<string, unknown> = {}) => {
    const target = childSessionId;
    if (!session || !target || disposed)
      return Promise.reject(new Error('Native GIF probe target unavailable'));
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Native GIF probe ${method} timed out`));
      }, CHILD_COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      void session!
        .send('Target.sendMessageToTarget', {
          sessionId: target,
          message: JSON.stringify({ id, method, params }),
        })
        .catch((error: unknown) => {
          const command = pending.get(id);
          if (!command) return;
          pending.delete(id);
          clearTimeout(command.timer);
          command.reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  };

  const received = ({ sessionId, message }: { sessionId: string; message: string }) => {
    if (sessionId !== childSessionId || disposed) return;
    let packet: Record<string, unknown>;
    try {
      packet = JSON.parse(message) as Record<string, unknown>;
    } catch (error) {
      recordError(error);
      return;
    }
    if (typeof packet.id === 'number') {
      const command = pending.get(packet.id);
      if (!command) return;
      pending.delete(packet.id);
      clearTimeout(command.timer);
      if (packet.error) command.reject(new Error(JSON.stringify(packet.error).slice(0, 300)));
      else command.resolve((packet.result ?? {}) as Record<string, unknown>);
      return;
    }
    if (packet.method !== 'Runtime.bindingCalled') return;
    const params = packet.params as { name?: unknown; payload?: unknown } | undefined;
    if (params?.name !== BINDING || typeof params.payload !== 'string' || nativeEvidence) return;
    try {
      const value = JSON.parse(params.payload) as Record<string, unknown>;
      if (
        value.type !== 'retained-init' ||
        value.length !== EXPECTED_RGBA_BYTES ||
        value.status !== 0 ||
        value.abi !== 3 ||
        typeof value.memoryBytes !== 'number' ||
        !Number.isSafeInteger(value.memoryBytes) ||
        value.memoryBytes < EXPECTED_RGBA_BYTES ||
        typeof value.workerClockMs !== 'number' ||
        !Number.isFinite(value.workerClockMs) ||
        !workerUrl
      ) {
        recordError('Invalid native GIF initialization evidence');
        return;
      }
      nativeEvidence = {
        type: 'retained-init',
        length: EXPECTED_RGBA_BYTES,
        status: 0,
        abi: 3,
        memoryBytes: value.memoryBytes,
        workerClockMs: value.workerClockMs,
        workerUrl,
        sourceAssetSha256,
      };
      callbackTask = onNativeInit(nativeEvidence).then(
        (result) => {
          stopResult = result;
          callbackSettled = true;
        },
        (error: unknown) => {
          recordError(error);
          callbackSettled = true;
        }
      );
    } catch (error) {
      recordError(error);
    }
  };

  const attached = (event: {
    sessionId: string;
    targetInfo: { type: string; url: string };
    waitingForDebugger: boolean;
  }) => {
    if (disposed || event.targetInfo.type !== 'worker') return;
    let url: URL;
    try {
      url = new URL(event.targetInfo.url);
    } catch {
      return;
    }
    if (url.origin !== expectedOrigin || !/^\/assets\/worker-[\w-]+\.js$/.test(url.pathname))
      return;
    if (childSessionId) {
      recordError('Multiple conversion Worker targets attached');
      return;
    }
    childSessionId = event.sessionId;
    workerUrl = url.href;
    attachedAtMs = performance.now();
    waitingForDebugger = event.waitingForDebugger;
    if (event.waitingForDebugger) {
      recordError('Conversion Worker was unexpectedly waiting for debugger');
      // The requested mode never pauses. Resume only an unexpected protocol
      // violation so the product cannot be stranded by this diagnostic.
      void sendChild('Runtime.runIfWaitingForDebugger').catch(recordError);
      return;
    }
    void (async () => {
      const enabled = sendChild('Runtime.enable');
      const binding = sendChild('Runtime.addBinding', { name: BINDING });
      await Promise.all([enabled, binding]);
      const response = await sendChild('Runtime.evaluate', {
        expression: INSTALL_EXPRESSION,
        returnByValue: true,
      });
      if (response.exceptionDetails) throw new Error('Native GIF probe injection threw');
      const result = response.result as { value?: Record<string, unknown> } | undefined;
      installResult = result?.value ?? { status: 'unavailable', reason: 'missing-runtime-result' };
      if (installResult.status === 'installed') installedAtMs = performance.now();
      else recordError(`Native GIF probe ${String(installResult.reason ?? 'unavailable')}`);
    })().catch(recordError);
  };

  try {
    session = await page.context().newCDPSession(page);
    session.on('Target.receivedMessageFromTarget', received);
    session.on('Target.attachedToTarget', attached);
    await session.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: false,
    });
    autoAttachArmed = true;
  } catch (error) {
    recordError(error);
  }

  return {
    snapshot: () => ({
      status: nativeEvidence
        ? stopResult?.clicked
          ? 'clicked'
          : 'native-observed'
        : installedAtMs !== null
          ? 'injected'
          : childSessionId
            ? 'attached'
            : autoAttachArmed
              ? 'armed'
              : 'unavailable',
      sourceAssetSha256,
      expectedRgbaBytes: EXPECTED_RGBA_BYTES,
      workerUrl,
      attachedAtMs,
      waitingForDebugger,
      installedAtMs,
      installResult,
      nativeEvidence,
      stopResult,
      callbackPending: callbackTask !== null && !callbackSettled,
      errors: [...errors],
    }),
    settle: async () => {
      if (!callbackTask) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          callbackTask,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              recordError('Native GIF Stop callback did not settle within deadline');
              resolve();
            }, CHILD_COMMAND_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    dispose: async () => {
      if (disposed) return;
      if (childSessionId && installedAtMs !== null && !nativeEvidence) {
        try {
          await sendChild('Runtime.evaluate', {
            expression: 'globalThis.__wmcGifNativeInitProbeRestore_v1?.()',
          });
        } catch (error) {
          recordError(error);
        }
      }
      disposed = true;
      for (const command of pending.values()) {
        clearTimeout(command.timer);
        command.reject(new Error('Native GIF probe disposed'));
      }
      pending.clear();
      if (!session) return;
      session.off('Target.receivedMessageFromTarget', received);
      session.off('Target.attachedToTarget', attached);
      try {
        if (autoAttachArmed)
          await session.send('Target.setAutoAttach', {
            autoAttach: false,
            waitForDebuggerOnStart: false,
            flatten: false,
          });
      } finally {
        await session.detach();
      }
    },
  };
}
