// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

interface CaptureSamplesOptions<T, Sample> {
  sample: () => Promise<Sample>;
  waitForInterval: () => Promise<void>;
  operation: () => Promise<T>;
}

export async function captureSamplesDuringOperation<T, Sample>({
  sample,
  waitForInterval,
  operation,
}: CaptureSamplesOptions<T, Sample>): Promise<{ result: T; samples: Sample[] }> {
  const samples = [await sample()];
  let sampling = true;
  let samplingFailure: unknown;
  let hasSamplingFailure = false;
  const sampler = (async () => {
    while (sampling) {
      await waitForInterval();
      if (sampling) samples.push(await sample());
    }
  })().catch((error: unknown) => {
    samplingFailure = error;
    hasSamplingFailure = true;
    sampling = false;
  });

  let result: T | undefined;
  let operationFailure: unknown;
  let hasOperationFailure = false;
  try {
    result = await operation();
  } catch (error) {
    operationFailure = error;
    hasOperationFailure = true;
  } finally {
    sampling = false;
    await sampler;
  }

  if (!hasSamplingFailure) {
    try {
      samples.push(await sample());
    } catch (error) {
      samplingFailure = error;
      hasSamplingFailure = true;
    }
  }

  if (hasOperationFailure && hasSamplingFailure) {
    throw new AggregateError(
      [operationFailure, samplingFailure],
      'Resource operation and sampling both failed',
    );
  }
  if (hasOperationFailure) throw operationFailure;
  if (hasSamplingFailure) throw samplingFailure;

  return { result: result as T, samples };
}
