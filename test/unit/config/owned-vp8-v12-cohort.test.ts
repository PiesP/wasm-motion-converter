import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import {
  compare,
  fixtureSelectionIdentity,
  rgbPixels,
  selectFixtureCohort,
  validateFixtureSourcePins,
} from '../../../scripts/test/owned-vp8-v2-compare.ts';
import {
  V12_HELDOUT,
  V12_PHOTOS,
  V12_PHOTO_REGIONS,
  generateV12Fixture,
} from '../../../scripts/test/owned-vp8-v12-fixtures.ts';

const root = resolve(import.meta.dirname, '../../..');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const fileHash = (path: string): string => sha256(readFileSync(resolve(root, path)));
const priorSuffixes = ['v2', 'v2-correction', ...Array.from({ length: 9 }, (_, i) => `v${i + 3}`)];

describe('owned VP8 V12 prospective frozen source', () => {
  it('validates all V1–V12 generator and manifest pins before codec setup', () => {
    const preflight = validateFixtureSourcePins('corrected-v12');
    expect(preflight.frozen.fixtures).toHaveLength(229);
    expect(preflight.frozen.fixtures.slice(-20).map((entry) => entry.id)).toEqual(
      V12_HELDOUT.map((entry) => entry.id)
    );
    expect(fileHash('scripts/test/owned-vp8-v2-fixtures.ts')).toBe(
      JSON.parse(readFileSync(preflight.baselineManifestFile, 'utf8')).generatorSha256
    );
  });

  it('selects only the complete V12 held-out cohort for fresh acceptance', async () => {
    const selected = selectFixtureCohort('held-out', 'corrected-v12');
    expect(selected).toEqual(V12_HELDOUT);
    expect(fixtureSelectionIdentity(selected, 'held-out', false, false)).toMatchObject({
      expectedConditionCount: 60,
      completeCohort: true,
      scope: 'FIXED_PIXEL_ACCEPTANCE_ONLY_NOT_PRODUCT_QUALIFICATION',
    });
    expect(selectFixtureCohort('tuning', 'corrected-v12')).toHaveLength(15);
    expect(() => selectFixtureCohort('held-out', 'corrected-v12', false, ['fresh12-gray'])).toThrow(
      'diagnostic only'
    );
    const parent = mkdtempSync(join(tmpdir(), 'owned-vp8-v12-subset-'));
    const output = join(parent, 'evidence');
    try {
      await expect(
        compare({
          output,
          split: 'held-out',
          cohort: 'corrected-v12',
          fixtureIds: ['fresh12-gray'],
          sources: {},
          candidateRoot: join(parent, 'missing-candidate'),
        })
      ).rejects.toThrow('diagnostic only');
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('binds 20 new inputs, source metadata, layouts and the one duplicate hold', () => {
    const frozen = JSON.parse(
      readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v12-fixtures.json'), 'utf8')
    ) as {
      cohort: string;
      generatorSha256: string;
      priorManifestSha256: Record<string, string>;
      fixtures: Array<{
        id: string;
        source: string;
        width: number;
        height: number;
        stride: number;
        layout: string;
        frame?: number;
        repeatOf?: string;
        sha256: string;
        qualities: number[];
      }>;
      sources: { photos: typeof V12_PHOTOS; photoRegions: typeof V12_PHOTO_REGIONS };
      thresholds: Record<string, number>;
    };
    expect(frozen.cohort).toBe('corrected-v12');
    expect(frozen.generatorSha256).toBe(fileHash('scripts/test/owned-vp8-v12-fixtures.ts'));
    expect(frozen.thresholds).toEqual({
      psnrBaselineDeltaDb: -1,
      ssimBaselineDelta: -0.01,
      sizeRatio: 1.25,
      sizeAdditiveBytes: 128,
    });
    for (const [index, suffix] of priorSuffixes.entries()) {
      const key = index === 0 ? 'initialV1' : `correctedV${index + 1}`;
      expect(frozen.priorManifestSha256[key]).toBe(
        fileHash(`docs/experiments/501-owned-vp8-${suffix}-fixtures.json`)
      );
    }
    const old = priorSuffixes.flatMap(
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
    expect(old).toHaveLength(209);
    const oldIds = new Set(old.map((entry) => entry.id));
    const oldHashes = new Set(old.map((entry) => entry.sha256));
    const oldFrames = new Set(
      old.map((entry) => entry.frame).filter((frame) => frame !== undefined)
    );
    expect(frozen.fixtures).toHaveLength(20);
    expect(frozen.fixtures.map((entry) => entry.id)).toEqual(V12_HELDOUT.map((entry) => entry.id));
    expect(
      frozen.fixtures.every((entry) => !oldIds.has(entry.id) && !oldHashes.has(entry.sha256))
    ).toBe(true);
    expect(frozen.fixtures.every((entry) => entry.qualities.join(',') === '60,75,85')).toBe(true);
    expect(
      frozen.fixtures.filter((entry) => entry.source === 'video').map((entry) => entry.frame)
    ).toEqual([37, 157, 37]);
    expect(oldFrames.has(37) || oldFrames.has(157)).toBe(false);
    const duplicates = [...Map.groupBy(frozen.fixtures, (entry) => entry.sha256).values()]
      .filter((group) => group.length > 1)
      .map((group) => group.map((entry) => entry.id));
    expect(duplicates).toEqual([['fresh12-video-37', 'fresh12-duplicate-hold']]);
    expect(frozen.sources.photos).toEqual(V12_PHOTOS);
    expect(frozen.sources.photoRegions).toEqual(V12_PHOTO_REGIONS);
    for (const entry of frozen.fixtures.filter((item) => item.source === 'generated')) {
      const fixture = generateV12Fixture(entry.id);
      expect(sha256(fixture.pixels)).toBe(entry.sha256);
      expect(fixture.pixels.length).toBe(entry.stride * entry.height);
      expect(rgbPixels(fixture).length).toBe(entry.width * entry.height * 3);
    }
    const packed = frozen.fixtures.find((entry) => entry.id === 'fresh12-packed-rgb24');
    expect(packed?.stride).toBe(343 * 3);
    const padded = generateV12Fixture('fresh12-padded-rgba');
    expect(padded.stride).toBe(339 * 4 + 44);
    for (let y = 0; y < padded.height; y++)
      expect(
        padded.pixels
          .subarray(y * padded.stride + padded.width * 4, (y + 1) * padded.stride)
          .every((byte) => byte === 0x73)
      ).toBe(true);
    expect(() => generateV12Fixture('fresh12-forest')).toThrow('Missing forest photo source');
    expect(() => generateV12Fixture('fresh12-night')).toThrow('Missing night photo source');
    expect(() => generateV12Fixture('fresh12-video-37')).toThrow('Missing video source');
    const parent = mkdtempSync(join(tmpdir(), 'owned-vp8-v12-bad-source-'));
    try {
      const bad = join(parent, 'wrong.jpg');
      writeFileSync(bad, 'wrong source');
      expect(() => generateV12Fixture('fresh12-forest', { forestPhoto: bad })).toThrow(
        'source byte count changed'
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
