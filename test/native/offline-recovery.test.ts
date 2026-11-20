// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';

import { test } from 'vite-plus/test';

import {
  assertWorkerUpdateOutcome,
  hasLegacyWebpLoader,
  selectPipelineDependency,
  softwareWebpInventory,
} from '../../validation/windows/offline-recovery.ts';

const prior = 'a'.repeat(64);
const current = 'b'.repeat(64);

const owned = { path: 'assets/owned-vp8-BKNGl6BO.wasm', size: 20, sha256: current };
const legacy = {
  path: 'assets/webp-wasm-DhoM6Y9t.wasm',
  size: 20,
  sha256: '4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22',
};
const demux = { path: 'assets/owned-demux-vJnqndga.wasm', size: 20, sha256: prior };

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

test('legacy runtime audit distinguishes module references and compiled loader markers from attribution', () => {
  assert.equal(hasLegacyWebpLoader(Buffer.from('import("./webp-wasm-ABCDEFGH.js")')), true);
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
