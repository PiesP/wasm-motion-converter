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

  it('distinguishes unavailable close signal from confirmed late close', () => {
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
    stillOpen.worker[0]!.openAfterTimeout = true;
    expect(verifyOwnerRetention(stillOpen).status).toBe('FAIL');
    const late = validEvidence();
    late.worker[0]!.closeAtMs = 6001;
    expect(verifyOwnerRetention(late).status).toBe('FAIL');
  });

  it('excludes immutable Module cache only when that scope is explicit', () => {
    const evidence = validEvidence();
    evidence.moduleCacheExcluded = false;
    expect(verifyOwnerRetention(evidence).status).toBe('UNVERIFIED');
  });
});
