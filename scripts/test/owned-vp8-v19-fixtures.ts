/** Private fixed-pixel input to the V19 development comparator. Never used by the product. */
import assert from 'node:assert/strict';
import { join } from 'node:path';

import type { FixtureSpec, PixelFixture } from './owned-vp8-v2-fixtures.ts';

export const V19_MANIFEST = 'docs/experiments/501-owned-vp8-v19-fixtures.json';
export const V19_PACK_READER = 'scripts/test/owned-vp8-v19-fixtures.ts';
export const V19_FREEZE = 'vp8-v19-first-heldout-01';

type PackedRow = {
  id: string;
  kind: 'digital' | 'photo' | 'video';
  stratum: string;
  width: number;
  height: number;
  stride: number;
  file: string;
  bytes: number;
  sha256: string;
  qualities: number[];
  originalSha256?: string;
};

export type V19Manifest = {
  status: 'FROZEN_UNEXECUTED';
  freezeId: typeof V19_FREEZE;
  cohort: 'corrected-v19';
  budget: 1;
  selectionSha256: string;
  historySha256: string;
  thresholds: {
    psnrBaselineDeltaDb: -1;
    ssimBaselineDelta: -0.01;
    sizeRatio: 1.25;
    sizeAdditiveBytes: 128;
  };
  generatorSha256: string;
  fixtures: PackedRow[];
};

const sha256 = /^[a-f0-9]{64}$/;

export function v19Specs(manifest: V19Manifest): FixtureSpec[] {
  assert.deepEqual(
    [manifest.status, manifest.freezeId, manifest.cohort, manifest.budget],
    ['FROZEN_UNEXECUTED', V19_FREEZE, 'corrected-v19', 1]
  );
  assert.deepEqual(manifest.thresholds, {
    psnrBaselineDeltaDb: -1,
    ssimBaselineDelta: -0.01,
    sizeRatio: 1.25,
    sizeAdditiveBytes: 128,
  });
  for (const hash of [manifest.historySha256, manifest.selectionSha256, manifest.generatorSha256])
    assert.match(hash, sha256);
  assert.deepEqual(
    manifest.fixtures.map((row) => row.kind),
    [...Array(10).fill('digital'), ...Array(5).fill('photo'), ...Array(5).fill('video')]
  );
  assert.equal(new Set(manifest.fixtures.map((row) => row.id)).size, 20);
  assert.equal(new Set(manifest.fixtures.map((row) => row.sha256)).size, 20);
  return manifest.fixtures.map((row) => {
    assert.match(row.id, /^fresh19-[a-z][a-z0-9-]{2,55}$/);
    assert.equal(row.id, `fresh19-${row.kind}-${row.stratum}`);
    assert.equal(row.file, row.id + '.rgba');
    for (const value of [row.width, row.height]) {
      assert.ok(Number.isSafeInteger(value) && value > 0 && value <= 1024);
    }
    assert.equal(row.stride, row.width * 4);
    assert.equal(row.bytes, row.stride * row.height);
    assert.match(row.sha256, sha256);
    if (row.kind !== 'digital') assert.match(row.originalSha256 ?? '', sha256);
    assert.deepEqual(row.qualities, [60, 75, 85]);
    return {
      id: row.id,
      layout: 'RGBA',
      split: 'held-out',
      source: row.kind === 'digital' ? 'generated' : row.kind,
      class: row.stratum,
      width: row.width,
      height: row.height,
    };
  });
}

// Called only after canonical reservation and signed/clean source, module, driver and oracle checks.
export function v19PackedReader(
  packRoot: string,
  manifest: V19Manifest,
  readBoundedFile: (path: string, bytes: number) => Buffer,
  digest: (bytes: Uint8Array) => string
) {
  const rows = new Map(manifest.fixtures.map((row) => [row.id, row]));
  return (spec: FixtureSpec): PixelFixture => {
    const row = rows.get(spec.id);
    assert.ok(row, 'V19 fixture is outside the complete registered ordering');
    const pixels = readBoundedFile(join(packRoot, row.file), row.bytes);
    assert.equal(pixels.length, row.bytes);
    assert.equal(digest(pixels), row.sha256, 'V19 exact packed digest differs');
    for (let offset = 3; offset < pixels.length; offset += 4) {
      assert.equal(pixels[offset], 255, 'V19 fixed-pixel fixture is not opaque RGBA');
    }
    return { ...spec, pixels, stride: row.stride };
  };
}
