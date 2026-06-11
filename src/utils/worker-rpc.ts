// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Lightweight Comlink-compatible worker RPC.
 *
 * Drop-in replacement for Comlink's `expose` / `wrap` / `proxy`.
 * Eliminates the 5.3K comlink dependency.
 *
 * @module utils/worker-rpc
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Tagged union discriminant */

/** Base fields shared by all RPC messages */
interface RpcBase {
  __rpc: true;
  id: number;
}

/** Worker → Main: invoke a method on the exposed API */
export interface RpcCall extends RpcBase {
  kind: 'call';
  method: string;
  args: unknown[];
}

/** Main → Worker: successful response */
export interface RpcResponse extends RpcBase {
  kind: 'response';
  value: unknown;
}

/** Main → Worker: error response */
export interface RpcError extends RpcBase {
  kind: 'error';
  error: string;
}

/** Release a proxy callback */
export interface RpcRelease extends RpcBase {
  kind: 'release';
}

export type RpcMessage = RpcCall | RpcResponse | RpcError | RpcRelease;

// ── Worker side: expose ──────────────────────────────────────────────────────

/**
 * Expose a handler object on the worker global.
 * Replaces `Comlink.expose(api)`.
 */
export function expose(api: Record<string, unknown>): void {
  self.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as RpcMessage | null;
    if (!msg || !msg.__rpc || msg.kind !== 'call') return;

    const handler = api[msg.method];
    if (typeof handler !== 'function') {
      self.postMessage({
        __rpc: true,
        id: msg.id,
        kind: 'error',
        error: `Unknown method: ${msg.method}`,
      } satisfies RpcError);
      return;
    }

    try {
      const result = handler.apply(api, msg.args);
      if (result instanceof Promise) {
        result
          .then((value: unknown) => {
            self.postMessage({
              __rpc: true,
              id: msg.id,
              kind: 'response',
              value,
            } satisfies RpcResponse);
          })
          .catch((err: unknown) => {
            self.postMessage({
              __rpc: true,
              id: msg.id,
              kind: 'error',
              error: String(err),
            } satisfies RpcError);
          });
      } else {
        self.postMessage({
          __rpc: true,
          id: msg.id,
          kind: 'response',
          value: result,
        } satisfies RpcResponse);
      }
    } catch (err: unknown) {
      self.postMessage({
        __rpc: true,
        id: msg.id,
        kind: 'error',
        error: String(err),
      } satisfies RpcError);
    }
  });
}

// ── Main side: wrap ──────────────────────────────────────────────────────────

class PendingCall {
  constructor(
    public resolve: (value: unknown) => void,
    public reject: (reason: unknown) => void
  ) {}
}

/**
 * Wrap a worker in a proxy that forwards method calls as RPC.
 * Replaces `Comlink.wrap<T>(worker)`.
 */
export function wrap<T extends object>(worker: Worker): T {
  let nextId = 1;
  const pending = new Map<number, PendingCall>();

  worker.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as RpcMessage | null;
    if (!msg || !msg.__rpc) return;
    if (msg.kind === 'call' || msg.kind === 'release') return;

    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);

    if (msg.kind === 'response') {
      entry.resolve(msg.value);
    } else {
      entry.reject(new Error(msg.error));
    }
  });

  const proxy = new Proxy({} as T, {
    get(_target, prop: string) {
      if (prop === 'then') return undefined; // prevent Promise-like coercion
      return (...args: unknown[]) => {
        return new Promise<unknown>((resolve, reject) => {
          const id = nextId++;
          pending.set(id, new PendingCall(resolve, reject));
          const msg: RpcCall = { __rpc: true, id, kind: 'call', method: prop, args };
          worker.postMessage(msg);
        });
      };
    },
  });

  return proxy;
}

// ── Main side: proxy (callbacks passed into worker calls) ────────────────────

let proxyHandlerId = 0;
const proxyHandlers = new Map<number, (...args: never[]) => unknown>();
let proxyListenerAttached = false;
let proxyCallId = 0;
const pendingProxyCalls = new Map<number, PendingCall>();

function ensureProxyListener(): void {
  if (proxyListenerAttached) return;
  proxyListenerAttached = true;

  self.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as RpcMessage | null;
    if (!msg || !msg.__rpc) return;

    // Response to one of our proxy calls
    if (msg.kind === 'response' || msg.kind === 'error') {
      const entry = pendingProxyCalls.get(msg.id);
      if (!entry) return;
      pendingProxyCalls.delete(msg.id);
      if (msg.kind === 'response') {
        entry.resolve(msg.value);
      } else {
        entry.reject(new Error(msg.error));
      }
      return;
    }

    // Incoming call targeting a proxied callback
    if (msg.kind === 'call') {
      const handlerId = Number(msg.method);
      const fn = proxyHandlers.get(handlerId);
      if (!fn) return;

      try {
        const result = (fn as (...args: unknown[]) => unknown)(...msg.args);
        if (result instanceof Promise) {
          result
            .then((value: unknown) => {
              self.postMessage({
                __rpc: true,
                id: msg.id,
                kind: 'response',
                value,
              } satisfies RpcResponse);
            })
            .catch((err: unknown) => {
              self.postMessage({
                __rpc: true,
                id: msg.id,
                kind: 'error',
                error: String(err),
              } satisfies RpcError);
            });
        } else {
          self.postMessage({
            __rpc: true,
            id: msg.id,
            kind: 'response',
            value: result,
          } satisfies RpcResponse);
        }
      } catch (err: unknown) {
        self.postMessage({
          __rpc: true,
          id: msg.id,
          kind: 'error',
          error: String(err),
        } satisfies RpcError);
      }
      return;
    }

    // Release a proxied callback
    if (msg.kind === 'release') {
      proxyHandlers.delete(msg.id);
    }
  });
}

/**
 * Wrap a callback so it can be called across the worker boundary.
 * Replaces `Comlink.proxy(callback)`.
 */
export function proxyFn<T extends (...args: never[]) => unknown>(
  callback: T
): (...args: Parameters<T>) => Promise<unknown> {
  ensureProxyListener();
  const handlerId = ++proxyHandlerId;
  proxyHandlers.set(handlerId, callback as (...args: never[]) => unknown);

  return (...args: unknown[]) => {
    return new Promise<unknown>((resolve, reject) => {
      const callId = ++proxyCallId;
      pendingProxyCalls.set(callId, new PendingCall(resolve, reject));
      const msg: RpcCall = {
        __rpc: true,
        id: callId,
        kind: 'call',
        method: String(handlerId),
        args,
      };
      self.postMessage(msg);
    });
  };
}
