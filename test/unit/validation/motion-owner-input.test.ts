// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { describe, expect, it } from 'vite-plus/test';

import {
  assertUsefulOutput,
  classifyWasmWarmCache,
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

describe('source-bound WASM warm-cache evidence', () => {
  const asset = {
    path: '/assets/gif-scalar-quantizer-Abc123_X.wasm',
    sha256: 'a'.repeat(64),
    size: 19_408,
  };
  const cache = {
    status: 'matched' as const,
    path: asset.path,
    cacheName: 'dropconvert-dynamic-v20261008-documents',
    sha256: asset.sha256,
    bytes: asset.size,
    phase: 'after-first-before-warm' as const,
    observedAtUtc: '2026-11-13T00:00:00.000Z',
    responseStatus: 200,
    contentType: 'application/wasm',
    admission: 'body-checked-v1',
    sourceHeader: `https://example.test${asset.path}`,
    sourcePath: asset.path,
    sourceOriginMatches: true,
    responseUrlEmpty: true,
  };
  const base = {
    asset,
    first: cache,
    warm: { ...cache, phase: 'after-warm' as const },
    firstHost: { paths: [asset.path], overflow: false },
    warmHost: { paths: [asset.path], overflow: false },
    firstController: '/service-worker.js',
    warmController: '/service-worker.js',
  };

  it('qualifies only a matched cached body with no warm host WASM request', () => {
    expect(classifyWasmWarmCache(base)).toEqual({
      qualified: true,
      reason: 'matched-cache-and-no-new-host-wasm-request',
      firstHostCount: 1,
      warmHostCount: 1,
      newHostCount: 0,
    });
    expect(
      classifyWasmWarmCache({
        ...base,
        warmHost: { paths: [asset.path, asset.path], overflow: false },
      })
    ).toMatchObject({ qualified: false, reason: 'new-host-wasm-request', newHostCount: 1 });
  });

  it('leaves missing, changed, uncontrolled, or overflowed evidence unqualified', () => {
    expect(
      classifyWasmWarmCache({ ...base, first: { ...cache, status: 'missing' } }).qualified
    ).toBe(false);
    expect(
      classifyWasmWarmCache({ ...base, warm: { ...cache, sha256: 'b'.repeat(64) } }).qualified
    ).toBe(false);
    expect(
      classifyWasmWarmCache({ ...base, warm: { ...base.warm, admission: null } }).qualified
    ).toBe(false);
    expect(classifyWasmWarmCache({ ...base, warmController: null }).qualified).toBe(false);
    expect(
      classifyWasmWarmCache({ ...base, warmHost: { paths: [asset.path], overflow: true } })
        .qualified
    ).toBe(false);
  });

  it('requires the exact admitted source, response headers, cache, and host log prefix', () => {
    const altered = [
      { responseStatus: 206 },
      { contentType: 'text/html' },
      { sourcePath: '/assets/other.wasm' },
      { sourceHeader: `https://example.test${asset.path}?unexpected=1` },
      { sourceOriginMatches: false },
      { responseUrlEmpty: false },
      { cacheName: 'dropconvert-dynamic-other' },
      { path: '/assets/other.wasm' },
      { bytes: asset.size - 1 },
    ];
    for (const change of altered) {
      expect(classifyWasmWarmCache({ ...base, warm: { ...base.warm, ...change } }).qualified).toBe(
        false
      );
    }
    expect(
      classifyWasmWarmCache({
        ...base,
        firstHost: { paths: [asset.path], overflow: false },
        warmHost: { paths: ['/assets/other.wasm'], overflow: false },
      })
    ).toMatchObject({
      qualified: false,
      reason: 'host-request-log-incomplete',
      newHostCount: null,
    });
    expect(classifyWasmWarmCache({ ...base, asset: null })).toMatchObject({
      qualified: false,
      reason: 'no-gif-wasm-asset',
    });
  });
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
