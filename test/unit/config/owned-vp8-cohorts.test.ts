import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import {
  compare,
  fixtureSelectionIdentity,
  parseFixtureIds,
  selectFixtureCohort,
} from '../../../scripts/test/owned-vp8-v2-compare';
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
import {
  V5_HELDOUT,
  V5_PHOTO,
  V5_PHOTO_REGIONS,
  generateV5Fixture,
} from '../../../scripts/test/owned-vp8-v5-fixtures';
import {
  V6_HELDOUT,
  V6_PHOTO,
  V6_PHOTO_REGIONS,
  generateV6Fixture,
} from '../../../scripts/test/owned-vp8-v6-fixtures';
import {
  V7_HELDOUT,
  V7_PHOTO,
  V7_PHOTO_REGIONS,
  generateV7Fixture,
} from '../../../scripts/test/owned-vp8-v7-fixtures';
import {
  V8_HELDOUT,
  V8_PHOTO,
  V8_PHOTO_REGIONS,
  generateV8Fixture,
} from '../../../scripts/test/owned-vp8-v8-fixtures';

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

  it('selects repeated --fixture IDs in frozen cohort order and marks the result incomplete', () => {
    expect(parseFixtureIds(['--cohort', 'corrected-v4'])).toBeUndefined();
    const ids = parseFixtureIds([
      '--fixture',
      'tune3-chroma-stripe-5',
      '--fixture',
      'tune-colored-text',
      '--fixture',
      'tune-photo-detail',
    ]);
    expect(ids).toEqual(['tune3-chroma-stripe-5', 'tune-colored-text', 'tune-photo-detail']);
    const selected = selectFixtureCohort('tuning', 'corrected-v4', false, ids);
    expect(selected.map((item) => item.id)).toEqual([
      'tune-colored-text',
      'tune-photo-detail',
      'tune3-chroma-stripe-5',
    ]);
    expect(fixtureSelectionIdentity(selected, 'tuning', false, true)).toEqual({
      selectedFixtureIds: selected.map((item) => item.id),
      expectedConditionCount: 9,
      completeCohort: false,
      scope: 'DIAGNOSTIC_SUBSET_NOT_ACCEPTANCE',
    });
    expect(selectFixtureCohort('tuning', 'corrected-v4')).toHaveLength(15);
    expect(
      fixtureSelectionIdentity(
        selectFixtureCohort('tuning', 'corrected-v4'),
        'tuning',
        false,
        false
      ).completeCohort
    ).toBe(true);
  });

  it('rejects empty, duplicate and out-of-split diagnostic IDs', () => {
    expect(() => parseFixtureIds(['--fixture'])).toThrow('nonempty ID');
    expect(() => parseFixtureIds(['--fixture', '--regression'])).toThrow('nonempty ID');
    expect(() => parseFixtureIds(['--fixture=some-id'])).toThrow('--fixture ID');
    expect(() => selectFixtureCohort('tuning', 'corrected-v4', false, [])).toThrow('at least one');
    expect(() => selectFixtureCohort('tuning', 'corrected-v4', false, [''])).toThrow('empty');
    expect(() =>
      selectFixtureCohort('tuning', 'corrected-v4', false, [
        'tune-colored-text',
        'tune-colored-text',
      ])
    ).toThrow('Duplicate');
    expect(() => selectFixtureCohort('tuning', 'corrected-v4', false, ['unknown'])).toThrow(
      'outside'
    );
    expect(() => selectFixtureCohort('tuning', 'corrected-v4', false, ['fresh4-tiny'])).toThrow(
      'outside'
    );
    expect(
      selectFixtureCohort('held-out', 'corrected-v4', true, ['fresh4-photo', 'fresh4-tiny']).map(
        (item) => item.id
      )
    ).toEqual(['fresh4-tiny', 'fresh4-photo']);
  });

  it('rejects any acceptance subset before creating evidence or initializing a codec', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'owned-vp8-subset-'));
    const output = join(parent, 'evidence');
    try {
      await expect(
        compare({
          output,
          split: 'held-out',
          cohort: 'corrected-v4',
          fixtureIds: ['fresh4-tiny'],
          sources: {},
          candidateRoot: join(parent, 'missing-candidate'),
        })
      ).rejects.toThrow('diagnostic only');
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('retains the distinct v5 inputs as regressions after their first rejected evaluation', () => {
    for (const cohort of [
      'initial-v1',
      'corrected-v2',
      'corrected-v3',
      'corrected-v4',
      'corrected-v5',
    ] as const)
      expect(() => selectFixtureCohort('held-out', cohort)).toThrow('exposed');
    const fresh = selectFixtureCohort('held-out', 'corrected-v5', true);
    expect(fresh).toEqual(V5_HELDOUT);
    expect(fresh).toHaveLength(18);
    expect(fixtureSelectionIdentity(fresh, 'held-out', true, false)).toMatchObject({
      expectedConditionCount: 54,
      completeCohort: true,
      scope: 'EXPOSED_REGRESSION_ONLY_NOT_FRESH_ACCEPTANCE',
    });
    expect(selectFixtureCohort('tuning', 'corrected-v5')).toHaveLength(15);
    const oldIds = new Set(
      [...FIXTURES, ...CORRECTION_HELDOUT, ...V3_HELDOUT, ...V4_HELDOUT].map((item) => item.id)
    );
    expect(fresh.every((item) => !oldIds.has(item.id))).toBe(true);
    expect(fresh.find((item) => item.id === 'fresh5-duplicate-hold')?.repeatOf).toBe(
      'fresh5-video-24'
    );
    expect(V5_PHOTO.sha256).not.toBe(V4_PHOTO.sha256);
    expect(V5_PHOTO_REGIONS.primary.x + V5_PHOTO_REGIONS.primary.width).toBeLessThan(
      V5_PHOTO_REGIONS.detail.x
    );
    expect(() => selectFixtureCohort('held-out', 'corrected-v5', false, ['fresh5-gray'])).toThrow(
      'diagnostic only'
    );
    expect(selectFixtureCohort('held-out', 'corrected-v5', true, ['fresh5-gray'])).toHaveLength(1);
  });

  it('binds v5 generated pixels, prior manifests, and source requirements', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v5-fixtures.json'), 'utf8')
    ) as {
      cohort: string;
      generatorSha256: string;
      priorManifestSha256: Record<string, string>;
      fixtures: Array<{ id: string; source: string; sha256: string; qualities: number[] }>;
    };
    expect(manifest.cohort).toBe('corrected-v5');
    expect(manifest.generatorSha256).toBe(sha256('scripts/test/owned-vp8-v5-fixtures.ts'));
    expect(manifest.priorManifestSha256).toEqual({
      initialV1: sha256('docs/experiments/501-owned-vp8-v2-fixtures.json'),
      correctedV2: sha256('docs/experiments/501-owned-vp8-v2-correction-fixtures.json'),
      correctedV3: sha256('docs/experiments/501-owned-vp8-v3-fixtures.json'),
      correctedV4: sha256('docs/experiments/501-owned-vp8-v4-fixtures.json'),
    });
    expect(manifest.fixtures).toHaveLength(18);
    expect(manifest.fixtures.every((entry) => entry.qualities.join(',') === '60,75,85')).toBe(true);
    for (const item of manifest.fixtures.filter((entry) => entry.source === 'generated'))
      expect(createHash('sha256').update(generateV5Fixture(item.id).pixels).digest('hex')).toBe(
        item.sha256
      );
    expect(() => generateV5Fixture('fresh5-photo')).toThrow('Missing fresh photo source');
    expect(() => generateV5Fixture('fresh5-video-24')).toThrow('Missing video source');
  });

  it('rejects a v5 acceptance subset before creating output or initializing a codec', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'owned-vp8-v5-subset-'));
    const output = join(parent, 'evidence');
    try {
      await expect(
        compare({
          output,
          split: 'held-out',
          cohort: 'corrected-v5',
          fixtureIds: ['fresh5-tiny-2x7'],
          sources: {},
          candidateRoot: join(parent, 'missing-candidate'),
        })
      ).rejects.toThrow('diagnostic only');
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('keeps the complete corrected-v6 set exposed after its first evaluation', async () => {
    for (const cohort of [
      'initial-v1',
      'corrected-v2',
      'corrected-v3',
      'corrected-v4',
      'corrected-v5',
      'corrected-v6',
    ] as const)
      expect(() => selectFixtureCohort('held-out', cohort)).toThrow('exposed');
    const selected = selectFixtureCohort('held-out', 'corrected-v6', true);
    expect(selected).toEqual(V6_HELDOUT);
    expect(fixtureSelectionIdentity(selected, 'held-out', true, false)).toMatchObject({
      selectedFixtureIds: V6_HELDOUT.map((item) => item.id),
      expectedConditionCount: 54,
      completeCohort: true,
      scope: 'EXPOSED_REGRESSION_ONLY_NOT_FRESH_ACCEPTANCE',
    });
    expect(selectFixtureCohort('tuning', 'corrected-v6')).toHaveLength(15);
    const parent = mkdtempSync(join(tmpdir(), 'owned-vp8-v6-subset-'));
    const output = join(parent, 'evidence');
    try {
      await expect(
        compare({
          output,
          split: 'held-out',
          cohort: 'corrected-v6',
          fixtureIds: ['fresh6-gray'],
          sources: {},
          candidateRoot: join(parent, 'missing-candidate'),
        })
      ).rejects.toThrow('diagnostic only');
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
    expect(selectFixtureCohort('held-out', 'corrected-v6', true, ['fresh6-gray'])).toHaveLength(1);
  });

  it('binds corrected-v6 identities, geometry, and unique source-only pixels', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v6-fixtures.json'), 'utf8')
    ) as {
      cohort: string;
      generatorSha256: string;
      priorManifestSha256: Record<string, string>;
      fixtures: Array<{
        id: string;
        source: string;
        width: number;
        height: number;
        layout: string;
        stride: number;
        sha256: string;
        repeatOf?: string;
        qualities: number[];
      }>;
    };
    expect(manifest.cohort).toBe('corrected-v6');
    expect(manifest.generatorSha256).toBe(sha256('scripts/test/owned-vp8-v6-fixtures.ts'));
    expect(manifest.priorManifestSha256).toEqual({
      initialV1: sha256('docs/experiments/501-owned-vp8-v2-fixtures.json'),
      correctedV2: sha256('docs/experiments/501-owned-vp8-v2-correction-fixtures.json'),
      correctedV3: sha256('docs/experiments/501-owned-vp8-v3-fixtures.json'),
      correctedV4: sha256('docs/experiments/501-owned-vp8-v4-fixtures.json'),
      correctedV5: sha256('docs/experiments/501-owned-vp8-v5-fixtures.json'),
    });
    const prior = ['v2', 'v2-correction', 'v3', 'v4', 'v5'].flatMap((name) => {
      const file = `docs/experiments/501-owned-vp8-${name}-fixtures.json`;
      return (
        JSON.parse(readFileSync(resolve(root, file), 'utf8')) as {
          fixtures: Array<{ id: string; sha256: string }>;
        }
      ).fixtures;
    });
    const priorIds = new Set(prior.map((item) => item.id));
    const priorHashes = new Set(prior.map((item) => item.sha256));
    expect(manifest.fixtures).toHaveLength(18);
    expect(new Set(manifest.fixtures.map((item) => item.id)).size).toBe(18);
    expect(
      manifest.fixtures.every(
        (item) =>
          !priorIds.has(item.id) &&
          item.qualities.join(',') === '60,75,85' &&
          item.stride === item.width * 4
      )
    ).toBe(true);
    expect(manifest.fixtures.every((item) => item.width * item.height <= 10_066_329)).toBe(true);
    expect(manifest.fixtures.find((item) => item.id === 'fresh6-large-admitted')).toMatchObject({
      width: 4080,
      height: 2467,
    });
    expect(4080 * 2467).toBe(10_065_360);
    expect(V6_PHOTO_REGIONS.primary.x + V6_PHOTO_REGIONS.primary.width).toBeLessThan(
      V6_PHOTO_REGIONS.detail.x
    );
    expect(V6_PHOTO.sha256).not.toBe(V5_PHOTO.sha256);
    const groups = Map.groupBy(manifest.fixtures, (item) => item.sha256);
    expect(
      [...groups.values()]
        .filter((group) => group.length > 1)
        .map((group) => group.map((item) => item.id))
    ).toEqual([['fresh6-video-32', 'fresh6-duplicate-hold']]);
    expect(manifest.fixtures.every((item) => !priorHashes.has(item.sha256))).toBe(true);
    const oldVideoFrames = new Set(
      prior.filter((item) => 'frame' in item).map((item) => (item as { frame?: number }).frame)
    );
    expect(
      manifest.fixtures
        .filter((item) => item.source === 'video')
        .map((item) => V6_HELDOUT.find((spec) => spec.id === item.id)?.frame)
    ).toEqual([32, 181, 32]);
    expect(oldVideoFrames.has(32) || oldVideoFrames.has(181)).toBe(false);
    for (const item of manifest.fixtures.filter((entry) => entry.source === 'generated')) {
      const pixels = generateV6Fixture(item.id).pixels;
      expect(createHash('sha256').update(pixels).digest('hex')).toBe(item.sha256);
      if (item.layout === 'BGRA')
        expect(pixels.every((value, index) => index % 4 !== 3 || value === 255)).toBe(true);
      if (item.layout === 'RGBX')
        expect(new Set(pixels.filter((_value, index) => index % 4 === 3)).size).toBeGreaterThan(1);
    }
    expect(() => generateV6Fixture('fresh6-photo')).toThrow('Missing fresh photo source');
    expect(() => generateV6Fixture('fresh6-video-32')).toThrow('Missing video source');
  });

  it('keeps corrected-v7 exposed after its first complete evaluation', async () => {
    for (const cohort of [
      'initial-v1',
      'corrected-v2',
      'corrected-v3',
      'corrected-v4',
      'corrected-v5',
      'corrected-v6',
      'corrected-v7',
    ] as const)
      expect(() => selectFixtureCohort('held-out', cohort)).toThrow('exposed');
    const selected = selectFixtureCohort('held-out', 'corrected-v7', true);
    expect(selected).toEqual(V7_HELDOUT);
    expect(fixtureSelectionIdentity(selected, 'held-out', true, false)).toMatchObject({
      selectedFixtureIds: V7_HELDOUT.map((item) => item.id),
      expectedConditionCount: 54,
      completeCohort: true,
      scope: 'EXPOSED_REGRESSION_ONLY_NOT_FRESH_ACCEPTANCE',
    });
    expect(selectFixtureCohort('tuning', 'corrected-v7')).toHaveLength(15);
    const parent = mkdtempSync(join(tmpdir(), 'owned-vp8-v7-subset-'));
    const output = join(parent, 'evidence');
    try {
      await expect(
        compare({
          output,
          split: 'held-out',
          cohort: 'corrected-v7',
          fixtureIds: ['fresh7-gray'],
          sources: {},
          candidateRoot: join(parent, 'missing-candidate'),
        })
      ).rejects.toThrow('diagnostic only');
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
    expect(selectFixtureCohort('held-out', 'corrected-v7', true, ['fresh7-gray'])).toHaveLength(1);
  });

  it('binds corrected-v7 sources, limits, and distinct pixels without codec output', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v7-fixtures.json'), 'utf8')
    ) as {
      cohort: string;
      generatorSha256: string;
      priorManifestSha256: Record<string, string>;
      sources: { photo: { sha256: string }; video: { sha256: string } };
      fixtures: Array<{
        id: string;
        source: string;
        frame?: number;
        width: number;
        height: number;
        layout: string;
        stride: number;
        sha256: string;
        repeatOf?: string;
        qualities: number[];
      }>;
    };
    expect(manifest.cohort).toBe('corrected-v7');
    expect(manifest.generatorSha256).toBe(sha256('scripts/test/owned-vp8-v7-fixtures.ts'));
    const priorFiles = {
      initialV1: 'v2',
      correctedV2: 'v2-correction',
      correctedV3: 'v3',
      correctedV4: 'v4',
      correctedV5: 'v5',
      correctedV6: 'v6',
    } as const;
    expect(manifest.priorManifestSha256).toEqual(
      Object.fromEntries(
        Object.entries(priorFiles).map(([name, suffix]) => [
          name,
          sha256(`docs/experiments/501-owned-vp8-${suffix}-fixtures.json`),
        ])
      )
    );
    const prior = Object.values(priorFiles).flatMap(
      (suffix) =>
        (
          JSON.parse(
            readFileSync(
              resolve(root, `docs/experiments/501-owned-vp8-${suffix}-fixtures.json`),
              'utf8'
            )
          ) as {
            fixtures: Array<{ id: string; sha256: string; frame?: number }>;
          }
        ).fixtures
    );
    const priorIds = new Set(prior.map((item) => item.id));
    const priorHashes = new Set(prior.map((item) => item.sha256));
    const priorFrames = new Set(
      prior.map((item) => item.frame).filter((frame) => frame !== undefined)
    );
    expect(manifest.fixtures).toHaveLength(18);
    expect(new Set(manifest.fixtures.map((item) => item.id)).size).toBe(18);
    expect(
      manifest.fixtures.every(
        (item) =>
          !priorIds.has(item.id) &&
          !priorHashes.has(item.sha256) &&
          item.qualities.join(',') === '60,75,85' &&
          item.stride === item.width * 4 &&
          item.width * item.height <= 10_066_329
      )
    ).toBe(true);
    expect(manifest.fixtures.find((item) => item.id === 'fresh7-large-admitted')).toMatchObject({
      width: 4110,
      height: 2449,
    });
    expect(4110 * 2449).toBe(10_065_390);
    expect(
      manifest.fixtures.filter((item) => item.source === 'video').map((item) => item.frame)
    ).toEqual([47, 184, 47]);
    expect(priorFrames.has(47) || priorFrames.has(184)).toBe(false);
    expect(
      [...Map.groupBy(manifest.fixtures, (item) => item.sha256).values()]
        .filter((group) => group.length > 1)
        .map((group) => group.map((item) => item.id))
    ).toEqual([['fresh7-video-47', 'fresh7-duplicate-hold']]);
    expect(V7_PHOTO_REGIONS.primary.x + V7_PHOTO_REGIONS.primary.width).toBeLessThan(
      V7_PHOTO_REGIONS.detail.x
    );
    expect(V7_PHOTO.sha256).not.toBe(V6_PHOTO.sha256);
    expect(manifest.sources.photo.sha256).toBe(V7_PHOTO.sha256);
    expect(manifest.sources.video.sha256).toBe(EXTERNAL_SOURCES.video.sha256);
    for (const item of manifest.fixtures.filter((entry) => entry.source === 'generated')) {
      const pixels = generateV7Fixture(item.id).pixels;
      expect(createHash('sha256').update(pixels).digest('hex')).toBe(item.sha256);
      if (item.layout === 'BGRA')
        expect(pixels.every((value, index) => index % 4 !== 3 || value === 255)).toBe(true);
      if (item.layout === 'RGBX')
        expect(new Set(pixels.filter((_value, index) => index % 4 === 3)).size).toBeGreaterThan(1);
    }
    expect(() => generateV7Fixture('fresh7-photo')).toThrow('Missing fresh photo source');
    expect(() => generateV7Fixture('fresh7-video-47')).toThrow('Missing video source');
  });

  it('selects exactly the fresh V8 conditions and keeps all previous held-out cohorts exposed', () => {
    for (const cohort of [
      'initial-v1',
      'corrected-v2',
      'corrected-v3',
      'corrected-v4',
      'corrected-v5',
      'corrected-v6',
      'corrected-v7',
    ] as const)
      expect(() => selectFixtureCohort('held-out', cohort)).toThrow('exposed');
    const selected = selectFixtureCohort('held-out', 'corrected-v8');
    expect(selected).toEqual(V8_HELDOUT);
    expect(fixtureSelectionIdentity(selected, 'held-out', false, false)).toMatchObject({
      expectedConditionCount: 60,
      completeCohort: true,
      scope: 'FIXED_PIXEL_ACCEPTANCE_ONLY_NOT_PRODUCT_QUALIFICATION',
    });
    expect(selectFixtureCohort('tuning', 'corrected-v8')).toHaveLength(15);
    expect(() => selectFixtureCohort('held-out', 'corrected-v8', false, ['fresh8-gray'])).toThrow(
      'diagnostic only'
    );
    expect(selectFixtureCohort('held-out', 'corrected-v8', true, ['fresh8-gray'])).toHaveLength(1);
  });

  it('binds prospective V8 source identities, input pixels, and admission geometry', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v8-fixtures.json'), 'utf8')
    ) as {
      cohort: string;
      generatorSha256: string;
      priorManifestSha256: Record<string, string>;
      thresholds: Record<string, number>;
      sources: { photo: { sha256: string }; video: { sha256: string; frameCount: number } };
      fixtures: Array<{
        id: string;
        source: string;
        frame?: number;
        width: number;
        height: number;
        layout: string;
        stride: number;
        sha256: string;
        repeatOf?: string;
        qualities: number[];
      }>;
    };
    expect(manifest.cohort).toBe('corrected-v8');
    expect(manifest.generatorSha256).toBe(sha256('scripts/test/owned-vp8-v8-fixtures.ts'));
    expect(manifest.thresholds).toEqual({
      psnrBaselineDeltaDb: -1,
      ssimBaselineDelta: -0.01,
      sizeRatio: 1.25,
      sizeAdditiveBytes: 128,
    });
    const priorFiles = {
      initialV1: 'v2',
      correctedV2: 'v2-correction',
      correctedV3: 'v3',
      correctedV4: 'v4',
      correctedV5: 'v5',
      correctedV6: 'v6',
      correctedV7: 'v7',
    } as const;
    expect(manifest.priorManifestSha256).toEqual(
      Object.fromEntries(
        Object.entries(priorFiles).map(([name, suffix]) => [
          name,
          sha256(`docs/experiments/501-owned-vp8-${suffix}-fixtures.json`),
        ])
      )
    );
    const prior = Object.values(priorFiles).flatMap(
      (suffix) =>
        (
          JSON.parse(
            readFileSync(
              resolve(root, `docs/experiments/501-owned-vp8-${suffix}-fixtures.json`),
              'utf8'
            )
          ) as { fixtures: Array<{ id: string; sha256: string; frame?: number }> }
        ).fixtures
    );
    expect(manifest.fixtures).toHaveLength(20);
    expect(new Set(manifest.fixtures.map((item) => item.id)).size).toBe(20);
    expect(
      manifest.fixtures.every(
        (item) =>
          !prior.some((old) => old.id === item.id) &&
          (item.repeatOf !== undefined || !prior.some((old) => old.sha256 === item.sha256)) &&
          item.qualities.join(',') === '60,75,85' &&
          item.width * item.height <= 10_066_329 &&
          item.stride >= item.width * 4
      )
    ).toBe(true);
    expect(manifest.fixtures.find((item) => item.id === 'fresh8-large-admitted')).toMatchObject({
      width: 4100,
      height: 2455,
    });
    expect(4100 * 2455).toBe(10_065_500);
    expect(manifest.fixtures.find((item) => item.id === 'fresh8-padded-rgba')?.stride).toBe(
      301 * 4 + 20
    );
    expect(
      manifest.fixtures.filter((item) => item.source === 'video').map((item) => item.frame)
    ).toEqual([63, 159, 63]);
    expect(prior.some((item) => item.frame === 63 || item.frame === 159)).toBe(false);
    expect(manifest.sources.video.frameCount).toBe(192);
    expect(manifest.sources.video.sha256).toBe(EXTERNAL_SOURCES.video.sha256);
    expect(manifest.sources.photo.sha256).toBe(V8_PHOTO.sha256);
    expect(V8_PHOTO.bytes).toBe(5_289_121);
    expect(V8_PHOTO_REGIONS.primary.x + V8_PHOTO_REGIONS.primary.width).toBeLessThan(
      V8_PHOTO_REGIONS.detail.x
    );
    expect(manifest.fixtures.find((item) => item.id === 'fresh8-video-63')?.sha256).toBe(
      manifest.fixtures.find((item) => item.id === 'fresh8-duplicate-hold')?.sha256
    );
    for (const item of manifest.fixtures.filter((entry) => entry.source === 'generated')) {
      const fixture = generateV8Fixture(item.id);
      const pixels = fixture.pixels;
      expect(createHash('sha256').update(pixels).digest('hex')).toBe(item.sha256);
      expect(pixels.length).toBe(item.stride * item.height);
      if (item.id === 'fresh8-padded-rgba') {
        for (let y = 0; y < item.height; y++)
          expect(
            pixels
              .subarray(y * item.stride + item.width * 4, (y + 1) * item.stride)
              .every((value) => value === 0xa7)
          ).toBe(true);
      }
      if (item.layout === 'BGRX' || item.layout === 'RGBX')
        expect(new Set(pixels.filter((_value, index) => index % 4 === 3)).size).toBeGreaterThan(1);
    }
    expect(() => generateV8Fixture('fresh8-photo')).toThrow('Missing fresh photo source');
    expect(() => generateV8Fixture('fresh8-video-63')).toThrow('Missing video source');
  });
});
