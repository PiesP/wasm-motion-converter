// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it } from 'vite-plus/test';

import {
  verifyOwnerRetention,
  type CapacityRecord,
  type Checkpoint,
  type OwnerRetentionEvidence,
} from '../../../validation/windows/helpers/owned-vp8-owner-retention.ts';

function record(id: number): CapacityRecord {
  return {
    id,
    successfulBeginCalls: 1,
    stepCalls: 1,
    retireCalls: 1,
    retireStatus: 0,
    peakCapacityBytes: 65_536,
    retirementTimeCapacityBytes: 65_536,
    instanceLive: false,
    wrapperLive: false,
    memoryLive: false,
  };
}

function checkpoint(inventory: CapacityRecord[]): Checkpoint {
  return {
    status: 'ok',
    requests: Array.from({ length: 3 }, () => ({ elapsedMs: 1, success: true })),
    inventory,
    liveInstanceCount: inventory.filter((entry) => entry.instanceLive).length,
    liveMemoryCount: inventory.filter((entry) => entry.memoryLive).length,
    liveMutableCapacityBytes: inventory.reduce(
      (sum, entry) => sum + (entry.memoryLive ? (entry.retirementTimeCapacityBytes ?? 0) : 0),
      0
    ),
    timeOriginBefore: 123,
    timeOriginAfter: 123,
  };
}

function validEvidence(): OwnerRetentionEvidence {
  return {
    moduleCacheExcluded: true,
    negativeControl: {
      held: checkpoint([{ ...record(1), instanceLive: true, memoryLive: true }]),
      released: checkpoint([record(1)]),
    },
    main: Array.from({ length: 7 }, (_, index) => ({
      kind:
        index < 3
          ? `complete-${index + 1}`
          : ['stop', 'after-stop', 'post-step-trap', 'after-trap'][index - 3]!,
      createdCount: index + 1,
      checkpoint: checkpoint(Array.from({ length: index + 1 }, (_, id) => record(id + 1))),
      ownerReleased: true,
    })),
    worker: Array.from({ length: 5 }, (_, index) => ({
      kind: index === 3 ? 'stop' : index === 4 ? 'after-stop' : `complete-${index + 1}`,
      id: index + 1,
      requestId: `request-${index + 1}`,
      terminalType: index === 3 ? null : 'complete',
      terminatedAtMs: 1000,
      closeAtMs: 1100,
      closeProof: {
        clock: 'page-performance-now',
        workerId: index + 1,
        requestId: `request-${index + 1}`,
        requestTimeOrigin: 100,
        terminationTimeOrigin: 100,
        closeTimeOrigin: 100,
        terminatedAtMs: 900,
        postCloseReadAtMs: 1000,
        upperBoundMs: 100,
      },
      closeObserved: true,
      closeCapability: true,
      snapshot: {
        requestId: `request-${index + 1}`,
        createdCount: 1,
        records: [{ ...record(1), ...(index === 3 ? { retireCalls: 0, retireStatus: null } : {}) }],
      },
      preCloseMutableCapacityBytes: 65_536,
      postCloseReachableCapacityBytes: 0,
    })),
  };
}

describe('owned VP8 post-owner reachability decision', () => {
  it('passes complete zero-live evidence with a discriminating control', () => {
    expect(verifyOwnerRetention(validEvidence())).toEqual({ status: 'PASS', reasons: [] });
  });

  it('fails a live mutable Memory or Instance after a valid checkpoint', () => {
    const evidence = validEvidence();
    evidence.main[2]!.checkpoint.inventory![2]!.memoryLive = true;
    evidence.main[2]!.checkpoint.liveMemoryCount = 1;
    evidence.main[2]!.checkpoint.liveMutableCapacityBytes = 65_536;
    expect(verifyOwnerRetention(evidence).status).toBe('FAIL');
  });

  it('keeps duplicate and missing instance IDs unverified', () => {
    const duplicate = validEvidence();
    duplicate.main[1]!.checkpoint.inventory![1]!.id = 1;
    expect(verifyOwnerRetention(duplicate).status).toBe('UNVERIFIED');
    const missing = validEvidence();
    missing.worker[0]!.snapshot!.createdCount = 2;
    expect(verifyOwnerRetention(missing).status).toBe('UNVERIFIED');
  });

  it('keeps an invalid negative control or unavailable CDP unverified', () => {
    const control = validEvidence();
    control.negativeControl!.held.inventory![0]!.memoryLive = false;
    expect(verifyOwnerRetention(control).status).toBe('UNVERIFIED');
    const release = validEvidence();
    release.negativeControl!.released.inventory![0]!.memoryLive = true;
    release.negativeControl!.released.liveMutableCapacityBytes = 65_536;
    expect(verifyOwnerRetention(release).status).toBe('UNVERIFIED');
    const cdp = validEvidence();
    cdp.main[0]!.checkpoint.status = 'unverified';
    expect(verifyOwnerRetention(cdp).status).toBe('UNVERIFIED');
  });

  it('accepts reversed forensic wall clocks when same-page close bound is valid', () => {
    const evidence = validEvidence();
    evidence.worker[0]!.closeAtMs = 998;
    expect(verifyOwnerRetention(evidence)).toEqual({ status: 'PASS', reasons: [] });
  });

  it('keeps missing or invalid same-clock proof unverified', () => {
    const missing = validEvidence();
    missing.worker[0]!.closeProof = null;
    expect(verifyOwnerRetention(missing).status).toBe('UNVERIFIED');
    const negative = validEvidence();
    negative.worker[0]!.closeProof!.postCloseReadAtMs = 899;
    negative.worker[0]!.closeProof!.upperBoundMs = -1;
    expect(verifyOwnerRetention(negative).status).toBe('UNVERIFIED');
    const nonfinite = validEvidence();
    nonfinite.worker[0]!.closeProof!.upperBoundMs = Number.NaN;
    expect(verifyOwnerRetention(nonfinite).status).toBe('UNVERIFIED');
    const mismatchedWorker = validEvidence();
    mismatchedWorker.worker[0]!.closeProof!.workerId = 2;
    expect(verifyOwnerRetention(mismatchedWorker).status).toBe('UNVERIFIED');
    const mismatchedRequest = validEvidence();
    mismatchedRequest.worker[0]!.closeProof!.requestId = 'other';
    expect(verifyOwnerRetention(mismatchedRequest).status).toBe('UNVERIFIED');
    const mismatchedOrigin = validEvidence();
    mismatchedOrigin.worker[0]!.closeProof!.closeTimeOrigin = 101;
    expect(verifyOwnerRetention(mismatchedOrigin).status).toBe('UNVERIFIED');
    const invalidWorker = validEvidence();
    invalidWorker.worker[0]!.id = 0;
    expect(verifyOwnerRetention(invalidWorker).status).toBe('UNVERIFIED');
  });

  it('distinguishes unavailable close signal from confirmed open Worker', () => {
    const unavailable = validEvidence();
    unavailable.worker[0]!.closeCapability = false;
    expect(verifyOwnerRetention(unavailable).status).toBe('UNVERIFIED');
    const noSignal = validEvidence();
    noSignal.worker[0]!.closeObserved = false;
    noSignal.worker[0]!.closeAtMs = null;
    noSignal.worker[0]!.openAfterTimeout = false;
    expect(verifyOwnerRetention(noSignal).status).toBe('UNVERIFIED');
    const stillOpen = validEvidence();
    stillOpen.worker[0]!.closeObserved = false;
    stillOpen.worker[0]!.closeAtMs = null;
    stillOpen.worker[0]!.closeProof = null;
    stillOpen.worker[0]!.openAfterTimeout = true;
    expect(verifyOwnerRetention(stillOpen).status).toBe('FAIL');
    const closedAfterObservedOpen = validEvidence();
    closedAfterObservedOpen.worker[0]!.openAfterTimeout = true;
    expect(verifyOwnerRetention(closedAfterObservedOpen).status).toBe('FAIL');
    const late = validEvidence();
    late.worker[0]!.closeProof!.postCloseReadAtMs = 6001;
    late.worker[0]!.closeProof!.upperBoundMs = 5101;
    expect(verifyOwnerRetention(late).status).toBe('UNVERIFIED');
  });

  it('excludes immutable Module cache only when that scope is explicit', () => {
    const evidence = validEvidence();
    evidence.moduleCacheExcluded = false;
    expect(verifyOwnerRetention(evidence).status).toBe('UNVERIFIED');
  });
});
