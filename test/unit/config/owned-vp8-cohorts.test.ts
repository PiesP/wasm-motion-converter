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
  V13_HELDOUT,
  assertV13PriorManifestRoles,
  assertV13Shape,
  preflightV13,
  type V13Manifest,
} from '../../../scripts/test/owned-vp8-v13-fixtures';
import {
  V14_HELDOUT,
  assertV14Shape,
  preflightV14,
  type V14Manifest,
} from '../../../scripts/test/owned-vp8-v14-fixtures';

describe('owned VP8 prospective cohort isolation', () => {
  const root = resolve(import.meta.dirname, '../../..');
  const sha256 = (path: string): string =>
    createHash('sha256')
      .update(readFileSync(resolve(root, path)))
      .digest('hex');

  it('keeps V13 as a 20-input / 60-condition exposed regression', async () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v13-fixtures.json'), 'utf8')
    ) as V13Manifest;
    expect(manifest.status).toBe('EXPOSED_REGRESSION');
    expect(manifest.freezeId).toBe('vp8-v13-first-heldout-20261116-01');
    expect(manifest.attemptBudget).toBe(1);
    expect(() => selectFixtureCohort('held-out', 'corrected-v13')).toThrow('exposed');
    const selected = selectFixtureCohort('held-out', 'corrected-v13', true);
    expect(selected).toEqual(V13_HELDOUT);
    expect(selected).toHaveLength(20);
    expect(fixtureSelectionIdentity(selected, 'held-out', true, false)).toMatchObject({
      expectedConditionCount: 60,
      completeCohort: true,
      scope: 'EXPOSED_REGRESSION_ONLY_NOT_FRESH_ACCEPTANCE',
    });
    expect(manifest.fixtures.map((row) => row.id)).toEqual(selected.map((row) => row.id));
    expect(manifest.fixtures.filter((row) => row.source === 'generated')).toHaveLength(13);
    expect(manifest.fixtures.filter((row) => row.source === 'photo')).toHaveLength(7);
    expect(manifest.fixtures.find((row) => row.repeatOf)?.repeatOf).toBe('fresh13-photoA-1');
    expect(() => selectFixtureCohort('tuning', 'corrected-v13')).toThrow('no tuning');
    expect(() =>
      selectFixtureCohort('held-out', 'corrected-v13', false, ['fresh13-neutral'])
    ).toThrow('diagnostic only');
    const draft = structuredClone(manifest);
    draft.status = 'PROSPECTIVE_UNFROZEN';
    expect(() => preflightV13(draft, {}, root)).toThrow('not acceptance ready');
    const parent = mkdtempSync(join(tmpdir(), 'owned-vp8-v13-draft-'));
    const output = join(parent, 'evidence');
    try {
      await expect(
        compare({
          output,
          split: 'held-out',
          cohort: 'corrected-v13',
          sources: {},
          candidateRoot: join(parent, 'missing-candidate'),
        })
      ).rejects.toThrow('exposed');
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('binds all 60 V14 recipes and blocks tuning and acceptance subsets', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v14-fixtures.json'), 'utf8')
    ) as V14Manifest;
    expect(() => assertV14Shape(manifest)).not.toThrow();
    expect(manifest.generatorSha256).toBe(sha256('scripts/test/owned-vp8-v14-fixtures.ts'));
    expect(manifest.priorV13.sha256).toBe(sha256(manifest.priorV13.path));
    const selected = selectFixtureCohort('held-out', 'corrected-v14');
    expect(selected).toEqual(V14_HELDOUT);
    expect(fixtureSelectionIdentity(selected, 'held-out', false, false)).toMatchObject({
      expectedConditionCount: 60,
      completeCohort: true,
      scope: 'FIXED_PIXEL_ACCEPTANCE_ONLY_NOT_PRODUCT_QUALIFICATION',
    });
    expect(selected.filter((item) => item.source === 'generated')).toHaveLength(12);
    expect(selected.filter((item) => item.source === 'photo')).toHaveLength(4);
    expect(V14_HELDOUT.flatMap((item) => item.pts ?? [])).toEqual([1000, 4000, 6000, 8000]);
    expect(() => selectFixtureCohort('tuning', 'corrected-v14')).toThrow('no tuning');
    expect(() =>
      selectFixtureCohort('held-out', 'corrected-v14', false, ['fresh14-neutral'])
    ).toThrow('diagnostic only');
    const video = manifest.fixtures.find((item) => item.pts === 1000)!;
    video.pts = 1001;
    expect(() => assertV14Shape(manifest)).toThrow();
  });

  it('rejects unfrozen V14 inputs or incomplete pins before initializing a codec', async () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v14-fixtures.json'), 'utf8')
    ) as V14Manifest;
    const draft = { ...manifest, status: 'PROSPECTIVE_UNFROZEN' } as const;
    expect(() => preflightV14(draft, {}, root, false)).toThrow('not acceptance ready');
    expect(() => preflightV14(draft, {}, root, true)).toThrow('not acceptance ready');
    const missingPins = {
      ...manifest,
      status: 'FROZEN_UNEXECUTED',
      fixtures: manifest.fixtures.map((row) => ({ ...row, sha256: null })),
    } as const;
    expect(() => preflightV14(missingPins, {}, root, false)).toThrow('pixel pins are incomplete');
    if (manifest.status !== 'PROSPECTIVE_UNFROZEN') return;
    const parent = mkdtempSync(join(tmpdir(), 'owned-vp8-v14-draft-'));
    const output = join(parent, 'evidence');
    try {
      for (const regression of [false, true])
        await expect(
          compare({ output, split: 'held-out', cohort: 'corrected-v14', regression, sources: {} })
        ).rejects.toThrow('not acceptance ready');
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects V13 manifest spec drift before any pixel or codec work', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v13-fixtures.json'), 'utf8')
    ) as V13Manifest;
    manifest.fixtures[0]!.width++;
    expect(() => assertV13Shape(manifest)).toThrow('fresh13-neutral width changed');
  });

  it('rejects V13 when the V12 role aliases the V11 manifest before collision scanning', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v13-fixtures.json'), 'utf8')
    ) as V13Manifest;
    const later = [
      ['correctedV8', 'd4b17b2990ce5fbb96dfa75c3377c8b6fb20336e91e202a5440f5e5d2da24e19'],
      ['correctedV9', '8eeae4aeb52b433ff2936ee7973d31795b6d39edc5f734e0a33de84ebf176c54'],
      ['correctedV10', '741d4674a4ef687be0e57ea02e8d0470bdbd7f21a74b16c17b25e66f9bc8db40'],
      ['correctedV11', '976a1365e7eeb13759df8f00d8b9ff296875c531ad10c707d445a25ac5c298a0'],
      ['correctedV12', '56ce94096af1c1d4424e55854b933f5c82ebc14e06bf8360b6cd9470f1a91d95'],
    ] as const;
    for (const [role, digest] of later)
      manifest.priorManifests[role] = {
        path: `501-owned-vp8-v${role.slice('correctedV'.length)}-fixtures.json`,
        sha256: digest,
      };
    expect(() => assertV13PriorManifestRoles(manifest)).not.toThrow();
    manifest.priorManifests.correctedV12 = { ...manifest.priorManifests.correctedV11! };
    expect(() => assertV13PriorManifestRoles(manifest)).toThrow(
      'correctedV12 prior manifest filename is wrong'
    );
  });

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
});
