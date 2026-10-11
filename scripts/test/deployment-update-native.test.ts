// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { observeDeploymentUpdates } from '../../src/deployment-update.ts';

const sourceSha = 'a'.repeat(40);

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const until = Date.now() + 2_000;
  while (!condition()) {
    assert.ok(Date.now() < until, `Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const [name, headers] of [
  ['MIME', { 'content-type': 'text/html' }],
  ['declared length', { 'content-type': 'application/json', 'content-length': '65537' }],
] as const) {
  test(`native Fetch releases two unfinished responses rejected by ${name}`, async () => {
    const openResponses = new Set<ServerResponse>();
    let closedResponses = 0;
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      openResponses.add(response);
      response.once('close', () => {
        closedResponses += 1;
        openResponses.delete(response);
      });
      response.writeHead(200, headers);
      response.write('{"prefix":');
    });
    const nativeFetch = globalThis.fetch;
    const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
    const setGlobal = (name: string, value: unknown): void => {
      originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, value });
    };
    let cleanup: (() => void) | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const origin = `http://127.0.0.1:${address.port}`;
      const signals: AbortSignal[] = [];
      const page = new EventTarget();
      const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
      let cooldownClock = 0;
      setGlobal('location', { href: origin });
      setGlobal('window', page);
      setGlobal('document', document);
      setGlobal('navigator', { onLine: true });
      setGlobal('performance', { now: () => cooldownClock });
      setGlobal('fetch', ((...args: Parameters<typeof fetch>) => {
        const signal = args[1]?.signal;
        assert.ok(signal);
        signals.push(signal);
        return nativeFetch(...args);
      }) satisfies typeof fetch);

      let notices = 0;
      cleanup = observeDeploymentUpdates({
        sourceSha,
        onUpdate: () => {
          notices += 1;
        },
      });
      await waitFor(() => closedResponses === 1, 'first rejected response close');
      assert.equal(signals[0]?.aborted, true);
      assert.equal(openResponses.size, 0);
      assert.equal(notices, 0);

      // Simulate the 60-second cooldown; response closure still uses real elapsed time.
      cooldownClock = 60_000;
      page.dispatchEvent(new Event('online'));
      await waitFor(() => closedResponses === 2, 'second rejected response close');
      assert.equal(requests, 2);
      assert.equal(signals[1]?.aborted, true);
      assert.equal(openResponses.size, 0);
      assert.equal(notices, 0);

      cleanup();
      cleanup = undefined;
      assert.equal(openResponses.size, 0);
    } finally {
      cleanup?.();
      for (const [name, descriptor] of originalGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      for (const response of openResponses) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
}
