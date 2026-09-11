// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it, vi } from 'vitest';

import { captureSamplesDuringOperation } from '../e2e/fixtures/resource-sampling';

describe('resource sampling orchestration', () => {
  it('preserves the operation failure when concurrent sampling also fails', async () => {
    const operationFailure = new Error('operation failed');
    const samplingFailure = new Error('sampling failed');
    let announceSamplingFailure!: () => void;
    const samplingFailed = new Promise<void>((resolve) => {
      announceSamplingFailure = resolve;
    });
    const sample = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockImplementationOnce(async () => {
        announceSamplingFailure();
        throw samplingFailure;
      });
    const operation = vi.fn(async () => {
      await samplingFailed;
      throw operationFailure;
    });

    let thrown: unknown;
    try {
      await captureSamplesDuringOperation({
        sample,
        waitForInterval: async () => {},
        operation,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([operationFailure, samplingFailure]);
    expect(sample).toHaveBeenCalledTimes(2);
    expect(operation).toHaveBeenCalledOnce();
  });
});
