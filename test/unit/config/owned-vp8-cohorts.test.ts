import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { selectFixtureCohort } from '../../../scripts/test/owned-vp8-v2-compare';
import {
  CORRECTION_HELDOUT,
  CORRECTION_PHOTO,
  CORRECTION_TUNING,
} from '../../../scripts/test/owned-vp8-v2-correction-fixtures';
import { EXTERNAL_SOURCES, FIXTURES } from '../../../scripts/test/owned-vp8-v2-fixtures';
import {
  V3_HELDOUT,
  V3_PHOTO,
  V3_TUNING,
  generateV3Fixture,
} from '../../../scripts/test/owned-vp8-v3-fixtures';
import {
  V4_HELDOUT,
  V4_PHOTO,
  generateV4Fixture,
} from '../../../scripts/test/owned-vp8-v4-fixtures';

describe('owned VP8 prospective cohort isolation', () => {
  const root = resolve(import.meta.dirname, '../../..');
  const sha256 = (path: string): string =>
    createHash('sha256')
      .update(readFileSync(resolve(root, path)))
      .digest('hex');

  it('requires an explicit regression purpose for the exposed initial held-out set', () => {
    expect(() => selectFixtureCohort('held-out', 'initial-v1')).toThrow('exposed');
    expect(selectFixtureCohort('held-out', 'initial-v1', true)).toEqual(
      FIXTURES.filter((item) => item.split === 'held-out')
    );
  });

  it('requires an explicit regression purpose for rejected corrected-v2 held-out inputs', () => {
    expect(() => selectFixtureCohort('held-out', 'corrected-v2')).toThrow('exposed');
    expect(selectFixtureCohort('held-out', 'corrected-v2', true)).toEqual(CORRECTION_HELDOUT);
  });

  it('requires regression purpose for corrected-v3 and preserves its original split', () => {
    expect(() => selectFixtureCohort('held-out', 'corrected-v3')).toThrow('exposed');
    const fresh = selectFixtureCohort('held-out', 'corrected-v3', true);
    const exposed = new Set(
      [...FIXTURES.filter((item) => item.split === 'held-out'), ...CORRECTION_HELDOUT].map(
        (item) => item.id
      )
    );
    const tuning = new Set(selectFixtureCohort('tuning', 'corrected-v3').map((item) => item.id));
    expect(fresh).toEqual(V3_HELDOUT);
    expect(fresh).toHaveLength(15);
    expect(fresh.length * 3).toBe(45);
    expect(tuning.size).toBe(15);
    expect(V3_TUNING).toHaveLength(3);
    expect(CORRECTION_TUNING).toHaveLength(3);
    expect(fresh.every((item) => !exposed.has(item.id) && !tuning.has(item.id))).toBe(true);
    expect(V3_PHOTO.sha256).not.toBe(EXTERNAL_SOURCES.photo.sha256);
    expect(V3_PHOTO.sha256).not.toBe(CORRECTION_PHOTO.sha256);
    const duplicate = fresh.find((item) => item.repeatOf);
    const original = fresh.find((item) => item.id === duplicate?.repeatOf);
    expect(original).toBeDefined();
    expect(duplicate?.frame).toBe(original?.frame);
    expect(duplicate?.source).toBe(original?.source);
  });

  it('generates bounded fresh pixels without codec outputs or external sources', () => {
    const tiny = generateV3Fixture('fresh3-tiny');
    expect(tiny.pixels).toHaveLength(3 * 2 * 4);
    expect(tiny.stride).toBe(12);
    const chroma = generateV3Fixture('fresh3-chroma-edge');
    expect(chroma.pixels).toHaveLength(347 * 239 * 4);
    expect(Array.from(chroma.pixels.subarray(0, 16))).toContain(239);
    expect(() => generateV3Fixture('fresh3-photo')).toThrow('Missing fresh photo source');
  });

  it('binds all source-only generated pixels and the two earlier manifests', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v3-fixtures.json'), 'utf8')
    ) as {
      cohort: string;
      generatorSha256: string;
      priorManifestSha256: { initialV1: string; correctedV2: string };
      fixtures: Array<{ id: string; split: string; source: string; sha256: string }>;
    };
    expect(manifest.cohort).toBe('corrected-v3');
    expect(manifest.generatorSha256).toBe(sha256('scripts/test/owned-vp8-v3-fixtures.ts'));
    expect(manifest.priorManifestSha256.initialV1).toBe(
      sha256('docs/experiments/501-owned-vp8-v2-fixtures.json')
    );
    expect(manifest.priorManifestSha256.correctedV2).toBe(
      sha256('docs/experiments/501-owned-vp8-v2-correction-fixtures.json')
    );
    expect(manifest.fixtures.filter((item) => item.split === 'held-out')).toHaveLength(15);
    expect(manifest.fixtures.filter((item) => item.split === 'tuning')).toHaveLength(3);
    for (const item of manifest.fixtures.filter((entry) => entry.source === 'generated')) {
      const pixels = generateV3Fixture(item.id).pixels;
      expect(createHash('sha256').update(pixels).digest('hex')).toBe(item.sha256);
    }
  });

  it('requires regression purpose for all observed cohorts and preserves the v4 split', () => {
    for (const cohort of ['initial-v1', 'corrected-v2', 'corrected-v3', 'corrected-v4'] as const)
      expect(() => selectFixtureCohort('held-out', cohort)).toThrow('exposed');
    const fresh = selectFixtureCohort('held-out', 'corrected-v4', true);
    expect(fresh).toEqual(V4_HELDOUT);
    expect(fresh).toHaveLength(15);
    expect(fresh.length * 3).toBe(45);
    expect(selectFixtureCohort('tuning', 'corrected-v4')).toHaveLength(15);
    const oldIds = new Set(
      [...FIXTURES, ...CORRECTION_HELDOUT, ...V3_HELDOUT].map((item) => item.id)
    );
    expect(fresh.every((item) => !oldIds.has(item.id))).toBe(true);
    expect(fresh.find((item) => item.id === 'fresh4-duplicate-hold')?.repeatOf).toBe(
      'fresh4-video-73'
    );
    expect(V4_PHOTO.sha256).not.toBe(V3_PHOTO.sha256);
  });

  it('binds v4 generated pixels, prior manifests and source requirements without codec output', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v4-fixtures.json'), 'utf8')
    ) as {
      cohort: string;
      generatorSha256: string;
      priorManifestSha256: { initialV1: string; correctedV2: string; correctedV3: string };
      fixtures: Array<{ id: string; source: string; sha256: string }>;
    };
    expect(manifest.cohort).toBe('corrected-v4');
    expect(manifest.generatorSha256).toBe(sha256('scripts/test/owned-vp8-v4-fixtures.ts'));
    expect(manifest.priorManifestSha256).toEqual({
      initialV1: sha256('docs/experiments/501-owned-vp8-v2-fixtures.json'),
      correctedV2: sha256('docs/experiments/501-owned-vp8-v2-correction-fixtures.json'),
      correctedV3: sha256('docs/experiments/501-owned-vp8-v3-fixtures.json'),
    });
    expect(manifest.fixtures).toHaveLength(15);
    for (const item of manifest.fixtures.filter((entry) => entry.source === 'generated'))
      expect(createHash('sha256').update(generateV4Fixture(item.id).pixels).digest('hex')).toBe(
        item.sha256
      );
    expect(() => generateV4Fixture('fresh4-photo')).toThrow('Missing fresh photo source');
    expect(() => generateV4Fixture('fresh4-video-73')).toThrow('Missing video source');
  });
});
