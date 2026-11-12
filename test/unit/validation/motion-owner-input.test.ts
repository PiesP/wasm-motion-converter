// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it } from 'vite-plus/test';

import {
  assertUsefulOutput,
  type MotionOutputSample,
  type MotionWorkload,
} from '../../../validation/windows/motion-signature.ts';

const ownerWorkload: MotionWorkload = {
  id: 'primary-enabled',
  fixture: 'private-owner-input',
  inputSha256: 'c1ebdf56c8af5d830c6b86689d2bff05cbc3f371da3b1c898c4cfad8a335373c',
  width: 720,
  height: 720,
  smartFrameSkip: 'low',
  quality: 'medium',
  scale: 1,
  oracleKind: 'owner-video',
  expectedDurationUs: 11_157_178,
  durationToleranceUs: 250_000,
  minimumFrameCount: 3,
  minimumDistinctFrames: 2,
};

const ownerOutput = (): MotionOutputSample => ({
  workload: 'primary-enabled',
  decoded: {
    durationUs: 11_160_000,
    frames: [
      { durationUs: 3_720_000, pixelSha256: 'a' },
      { durationUs: 3_720_000, pixelSha256: 'a' },
      { durationUs: 3_720_000, pixelSha256: 'b' },
    ],
  },
});

describe('owner-video GIF output oracle', () => {
  it('accepts repeated adjacent frames when the video timeline and visible motion survive', () => {
    expect(() => assertUsefulOutput(ownerOutput(), ownerWorkload)).not.toThrow();
  });

  it('rejects duration outside the frozen video timeline tolerance', () => {
    const sample = ownerOutput();
    sample.decoded.durationUs = 11_410_000;
    expect(() => assertUsefulOutput(sample, ownerWorkload)).toThrow('source-duration tolerance');
  });

  it('rejects nonpositive frame duration and a visually static result', () => {
    const nonpositive = ownerOutput();
    nonpositive.decoded.frames[1]!.durationUs = 0;
    expect(() => assertUsefulOutput(nonpositive, ownerWorkload)).toThrow('nonpositive');

    const staticOutput = ownerOutput();
    staticOutput.decoded.frames[2]!.pixelSha256 = 'a';
    expect(() => assertUsefulOutput(staticOutput, ownerWorkload)).toThrow('visible motion');
  });

  it('keeps the historical synthetic primary frame-change gate', () => {
    const synthetic: MotionWorkload = {
      id: 'primary-enabled',
      fixture: 'synthetic-primary',
      inputSha256: 'synthetic',
      width: 320,
      height: 180,
      smartFrameSkip: 'low',
    };
    const output = ownerOutput();
    output.decoded.durationUs = 3_000_000;
    expect(() => assertUsefulOutput(output, synthetic)).toThrow('fewer than 16 frames');
    output.decoded.frames = Array.from({ length: 16 }, (_, index) => ({
      durationUs: 187_500,
      pixelSha256: index === 0 ? 'b' : 'a',
    }));
    expect(() => assertUsefulOutput(output, synthetic)).toThrow('fewer than 15 adjacent');
  });
});
