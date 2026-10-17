// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertWorkerUpdateOutcome } from '../../validation/windows/offline-recovery.mjs';

const prior = 'a'.repeat(64);
const current = 'b'.repeat(64);

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
