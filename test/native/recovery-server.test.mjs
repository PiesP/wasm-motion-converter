// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startStaticServer } from '../../validation/windows/profile.mjs';

test('owned Pages-compatible server injects one real asset failure at a time', async () => {
  const bundleRoot = await mkdtemp(join(tmpdir(), 'wmc-recovery-server-'));
  let started;
  try {
    const distRoot = join(bundleRoot, 'dist');
    await mkdir(join(distRoot, 'assets'), { recursive: true });
    await writeFile(join(distRoot, 'index.html'), '<!doctype html><title>Recovery</title>');
    await writeFile(join(distRoot, 'assets', 'es.Abc123_X.js'), 'export default "es";');
    await writeFile(
      join(distRoot, '_headers'),
      "/*\n  Content-Security-Policy: default-src 'self'\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n"
    );
    started = await startStaticServer(bundleRoot);
    const path = '/assets/es.Abc123_X.js';
    const url = `${started.url}${path}`;
    assert.equal(await (await fetch(url)).text(), 'export default "es";');
    for (const [mode, status, contentType] of [
      ['404', 404, 'text/plain'],
      ['wrong-mime', 200, 'text/html'],
    ]) {
      started.setAssetFailure({ path, mode });
      const response = await fetch(url);
      assert.equal(response.status, status);
      assert(response.headers.get('content-type').startsWith(contentType));
      assert.deepEqual(started.assetFailureRequests, [{ path, mode }]);
      assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    }
    started.setAssetFailure({ path, mode: 'network' });
    await assert.rejects(fetch(url));
    assert.deepEqual(started.assetFailureRequests, [{ path, mode: 'network' }]);
    started.setAssetFailure(null);
    assert.equal(await (await fetch(url)).text(), 'export default "es";');
    assert.deepEqual(started.assetFailureRequests, []);
    assert.deepEqual(started.observedAssetRequests, [path, path, path, path, path]);
    const nextRoot = join(bundleRoot, 'next');
    await mkdir(nextRoot);
    await writeFile(join(nextRoot, 'index.html'), '<!doctype html><title>Next</title>');
    await writeFile(
      join(nextRoot, '_headers'),
      "/*\n  Content-Security-Policy: default-src 'self'\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n"
    );
    await started.setDistribution('next');
    assert.equal((await fetch(url)).status, 404);
    assert.deepEqual(started.missingAssetResponses, [{ path, status: 404 }]);
    assert.throws(() => started.setAssetFailure({ path: '/index.html', mode: '404' }));
    assert.throws(() => started.setAssetFailure({ path, mode: 'script' }));
  } finally {
    if (started)
      await new Promise((resolve, reject) => {
        started.server.closeIdleConnections?.();
        started.server.close((error) => (error ? reject(error) : resolve()));
      });
    await rm(bundleRoot, { recursive: true, force: true });
  }
});
