// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'vite-plus/test';

import {
  LEGACY_WEBP_DEPLOYMENT,
  RETIRED_WEBP_SHIM,
} from '../../scripts/test/retired-webp-assets.ts';
import {
  assertWorkerUpdateOutcome,
  hasLegacyWebpLoader,
  selectCachedRetiredExecutableKeys,
  selectGraceWorkerVersion,
  selectPipelineDependency,
  softwareWebpInventory,
} from '../../validation/windows/offline-recovery.ts';
import { startStaticServer } from '../../validation/windows/profile.ts';

const prior = 'a'.repeat(64);
const current = 'b'.repeat(64);

const owned = { path: 'assets/owned-vp8-BKNGl6BO.wasm', size: 20, sha256: current };
const legacy = {
  path: 'assets/webp-wasm-DhoM6Y9t.wasm',
  size: 20,
  sha256: '4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22',
};
const demux = { path: 'assets/owned-demux-vJnqndga.wasm', size: 20, sha256: prior };

test('retirement origin records real alias targets and projects the original three paths', async () => {
  const bundle = await mkdtemp(join(tmpdir(), 'wmc-retirement-origin-'));
  try {
    await mkdir(join(bundle, 'dist'));
    await writeFile(
      join(bundle, 'dist', '_headers'),
      "/*\n  Content-Security-Policy: default-src 'self'\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n"
    );
    const started = await startStaticServer(bundle, { recordRetirementOrigin: true });
    try {
      assert.deepEqual(started.archivedOriginSnapshot(true).requests, []);
      const expected = [];
      for (const [index, asset] of [RETIRED_WEBP_SHIM, ...LEGACY_WEBP_DEPLOYMENT.files].entries()) {
        const path = '/' + asset.path;
        const target = `${path}?offline-acceptance=retired-alias`;
        const response = await fetch(`${started.url}${target}`, {
          headers: { 'cache-control': 'no-cache' },
        });
        assert.equal(response.status, 404);
        await response.text();
        expected.push({
          sequence: index + 1,
          path,
          target,
          method: 'GET',
          distribution: 'dist',
          requestCacheControl: 'no-cache',
          status: 404,
          contentType: response.headers.get('content-type') ?? '',
          cacheControl: response.headers.get('cache-control') ?? '',
          disposition: 'finished',
        });
      }
      const all = started.archivedOriginSnapshot(true);
      assert.equal(all.overflow, false);
      assert.deepEqual(
        all.paths,
        expected.map(({ path }) => path)
      );
      assert.deepEqual(all.requests, expected);
      const original = started.archivedOriginSnapshot(false);
      assert.deepEqual(original.paths, all.paths.slice(1));
      assert.deepEqual(
        original.requests,
        expected.slice(1).map((row, index) => ({ ...row, sequence: index + 1 }))
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        started.server.closeIdleConnections();
        started.server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});

test('software WebP inventory distinguishes legacy, retained legacy and owned-only builds', () => {
  assert.equal(softwareWebpInventory([legacy, demux]).family, 'wasm-webp');
  const transitional = softwareWebpInventory([legacy, owned, demux]);
  assert.equal(transitional.family, 'owned-vp8');
  assert.equal(transitional.ownedOnly, false);
  const removed = softwareWebpInventory([owned, demux]);
  assert.equal(removed.ownedOnly, true);
  assert.equal(removed.asset, owned);
});

test('unrelated WASM cannot substitute for VP8 or hide a duplicate or renamed legacy module', () => {
  assert.throws(() => softwareWebpInventory([demux]), /No inventoried software WebP/);
  assert.throws(
    () => softwareWebpInventory([owned, { ...owned, path: 'assets/other--abcdefgh.wasm' }]),
    /more than once/
  );
  const renamed = { ...legacy, path: 'assets/codec.abcdefgh.wasm' };
  const inventory = softwareWebpInventory([owned, renamed]);
  assert.equal(inventory.ownedOnly, false);
  assert.deepEqual(inventory.legacyExecutables, [renamed]);
});

test('retirement cache evidence retains canonical and query keys in the app cache only', () => {
  const cache = 'dropconvert-dynamic-v20261008-documents';
  const origin = 'http://127.0.0.1';
  const wasm = '/assets/webp-wasm-DhoM6Y9t.wasm';
  const shim = '/assets/__vite-browser-external-Cz17a1zo.js';
  const alias = '?offline-acceptance=retired-alias';
  assert.deepEqual(
    selectCachedRetiredExecutableKeys([
      { cache, request: origin + wasm },
      { cache, request: origin + wasm + alias },
      { cache, request: origin + shim + alias },
      { cache, request: origin + '/assets/owned-vp8-BKNGl6BO.wasm' },
      { cache: 'unrelated', request: origin + wasm },
    ]),
    [
      { cache, path: shim, search: alias },
      { cache, path: wasm, search: '' },
      { cache, path: wasm, search: alias },
    ]
  );
});

test('grace worker selection binds an activated running registration to both retained page targets', () => {
  const scriptURL = 'http://127.0.0.1/service-worker.js';
  const targets = ['old-result', 'old-conversion'];
  const candidate = {
    versionId: '42',
    registrationId: '15',
    scriptURL,
    status: 'activated',
    runningStatus: 'running',
    controlledClients: targets,
  };
  const wrong = { ...candidate, versionId: '32', registrationId: 'other' };
  const stopped = { ...candidate, runningStatus: 'stopped' };
  const orphan = { ...candidate, versionId: '41', controlledClients: [targets[0] ?? ''] };
  assert.equal(
    selectGraceWorkerVersion([wrong, orphan, stopped, candidate], '15', scriptURL, targets),
    candidate
  );
  assert.equal(
    selectGraceWorkerVersion([wrong, orphan, stopped], '15', scriptURL, targets),
    undefined
  );
  assert.equal(
    selectGraceWorkerVersion([candidate, { ...candidate }], '15', scriptURL, targets),
    undefined
  );
  assert.equal(
    selectGraceWorkerVersion([candidate], '15', scriptURL, [targets[0] ?? '', targets[0] ?? '']),
    undefined
  );
});

test('legacy runtime audit distinguishes module references and compiled loader markers from attribution', () => {
  assert.equal(hasLegacyWebpLoader(Buffer.from('import("./webp-wasm-ABCDEFGH.js")')), true);
  assert.equal(
    hasLegacyWebpLoader(Buffer.from('const deps=["assets/wasm-webp.Wg4Zhl1L.js"];')),
    true
  );
  assert.equal(
    hasLegacyWebpLoader(Buffer.from('const deps=["assets/owned-vp8.Wg4Zhl1L.wasm"];')),
    false
  );
  assert.equal(
    hasLegacyWebpLoader(Buffer.from('emscripten_resize_heap wasmMemory __wasm_call_ctors')),
    true
  );
  assert.equal(
    hasLegacyWebpLoader(Buffer.from('MIT; https://github.com/nieyuyao/webp-wasm')),
    false
  );
});

test('first-pipeline expectations preserve historical GIF preload and verify the owned demux family', () => {
  const gifenc = { ...legacy, path: 'assets/gifenc.abcdefgh.js' };
  const snapshot = { ...demux, path: 'assets/owned-demux-index-snapshot.C5u6Fa5D.js' };
  assert.deepEqual(selectPipelineDependency([gifenc]), { asset: gifenc, firstConversion: true });
  assert.deepEqual(selectPipelineDependency([snapshot]), {
    asset: snapshot,
    firstConversion: false,
  });
  assert.throws(() => selectPipelineDependency([owned, demux]), /one known first-pipeline preload/);
});

test('byte-identical update keeps both old tabs on their actual controllers', () => {
  assert.equal(
    assertWorkerUpdateOutcome(prior, prior, {
      resultControllerChanged: false,
      activeControllerChanged: false,
    }),
    'byte-identical-kept-controller'
  );
  assert.throws(
    () =>
      assertWorkerUpdateOutcome(prior, prior, {
        resultControllerChanged: false,
        activeControllerChanged: true,
      }),
    /Active conversion tab controller/
  );
  assert.throws(
    () =>
      assertWorkerUpdateOutcome(prior, prior, {
        resultControllerChanged: true,
        activeControllerChanged: false,
      }),
    /Retained result tab controller/
  );
});

test('changed worker must claim both old tabs', () => {
  assert.equal(
    assertWorkerUpdateOutcome(prior, current, {
      resultControllerChanged: true,
      activeControllerChanged: true,
    }),
    'changed-worker-claimed'
  );
  assert.throws(
    () =>
      assertWorkerUpdateOutcome(prior, current, {
        resultControllerChanged: false,
        activeControllerChanged: false,
      }),
    /Retained result tab controller/
  );
  assert.throws(
    () =>
      assertWorkerUpdateOutcome(prior, current, {
        resultControllerChanged: true,
        activeControllerChanged: false,
      }),
    /Active conversion tab controller/
  );
});
