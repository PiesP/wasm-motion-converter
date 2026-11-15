import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import {
  compare,
  fixtureSelectionIdentity,
  selectFixtureCohort,
} from '../../../scripts/test/owned-vp8-v2-compare.ts';
import {
  V10_HELDOUT,
  V10_PHOTO,
  V10_PHOTO_REGIONS,
  generateV10Fixture,
} from '../../../scripts/test/owned-vp8-v10-fixtures.ts';

const root = resolve(import.meta.dirname, '../../..');
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const fileHash = (file: string): string => sha256(readFileSync(resolve(root, file)));

describe('owned VP8 V10 source freeze and exposed regression routing', () => {
  it('selects exactly 20 exposed V10 inputs and keeps V1-V10 regression only', () => {
    const selected = selectFixtureCohort('held-out', 'corrected-v10', true);
    expect(selected).toEqual(V10_HELDOUT);
    expect(fixtureSelectionIdentity(selected, 'held-out', true, false)).toMatchObject({
      expectedConditionCount: 60,
      completeCohort: true,
      scope: 'EXPOSED_REGRESSION_ONLY_NOT_FRESH_ACCEPTANCE',
    });
    expect(selectFixtureCohort('tuning', 'corrected-v10')).toHaveLength(15);
    for (const cohort of [
      'initial-v1',
      'corrected-v2',
      'corrected-v3',
      'corrected-v4',
      'corrected-v5',
      'corrected-v6',
      'corrected-v7',
      'corrected-v8',
      'corrected-v9',
      'corrected-v10',
    ] as const) {
      expect(() => selectFixtureCohort('held-out', cohort)).toThrow('exposed');
      expect(selectFixtureCohort('held-out', cohort, true).length).toBeGreaterThan(0);
    }
  });

  it('rejects full and partial V10 acceptance before evidence or codec initialization', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'owned-vp8-v10-preflight-'));
    const output = join(parent, 'evidence');
    try {
      for (const subset of [false, true]) {
        await expect(
          compare({
            output,
            split: 'held-out',
            cohort: 'corrected-v10',
            ...(subset ? { fixtureIds: ['fresh10-gray'] } : {}),
            sources: {},
            candidateRoot: join(parent, 'missing-candidate'),
          })
        ).rejects.toThrow(subset ? 'diagnostic only' : 'exposed');
        expect(existsSync(output)).toBe(false);
        const cli = spawnSync(
          process.execPath,
          [
            '--experimental-strip-types',
            resolve(root, 'scripts/test/owned-vp8-v2-compare.ts'),
            '--cohort',
            'corrected-v10',
            '--acceptance',
            ...(subset ? ['--fixture', 'fresh10-gray'] : []),
            '--candidate-root',
            join(parent, 'missing-candidate'),
            '--output',
            output,
          ],
          { cwd: root, encoding: 'utf8' }
        );
        expect(cli.status).not.toBe(0);
        expect(cli.stderr).toContain(subset ? 'diagnostic only' : 'exposed');
        expect(existsSync(output)).toBe(false);
      }
      expect(selectFixtureCohort('held-out', 'corrected-v10', true)).toHaveLength(20);
      expect(selectFixtureCohort('held-out', 'corrected-v10', true, ['fresh10-gray'])).toHaveLength(
        1
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('binds all source pixels, predecessor manifests, limits, and the duplicate hold', () => {
    const frozen = JSON.parse(
      readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v10-fixtures.json'), 'utf8')
    ) as {
      cohort: string;
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
      priorManifestSha256: Record<string, string>;
      generatorSha256: string;
      thresholds: Record<string, number>;
      sources: { photo: { sha1: string; sha256: string }; video: { sha256: string } };
    };
    expect(frozen.cohort).toBe('corrected-v10');
    expect(frozen.generatorSha256).toBe(fileHash('scripts/test/owned-vp8-v10-fixtures.ts'));
    expect(frozen.fixtures).toHaveLength(20);
    expect(frozen.fixtures.flatMap((item) => item.qualities)).toHaveLength(60);
    expect(frozen.thresholds).toEqual({
      psnrBaselineDeltaDb: -1,
      ssimBaselineDelta: -0.01,
      sizeRatio: 1.25,
      sizeAdditiveBytes: 128,
    });
    const predecessorFiles = {
      initialV1: 'v2',
      correctedV2: 'v2-correction',
      correctedV3: 'v3',
      correctedV4: 'v4',
      correctedV5: 'v5',
      correctedV6: 'v6',
      correctedV7: 'v7',
      correctedV8: 'v8',
      correctedV9: 'v9',
    } as const;
    expect(frozen.priorManifestSha256).toEqual(
      Object.fromEntries(
        Object.entries(predecessorFiles).map(([key, suffix]) => [
          key,
          fileHash(`docs/experiments/501-owned-vp8-${suffix}-fixtures.json`),
        ])
      )
    );
    const old = Object.values(predecessorFiles).flatMap(
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
    const oldIds = new Set(old.map((item) => item.id));
    const oldHashes = new Set(old.map((item) => item.sha256));
    const oldFrames = new Set(old.map((item) => item.frame).filter((frame) => frame !== undefined));
    expect(new Set(frozen.fixtures.map((item) => item.id)).size).toBe(20);
    expect(
      frozen.fixtures.every((item) => !oldIds.has(item.id) && !oldHashes.has(item.sha256))
    ).toBe(true);
    expect(frozen.fixtures.every((item) => item.width * item.height <= 10_066_329)).toBe(true);
    expect(frozen.fixtures.every((item) => item.qualities.join(',') === '60,75,85')).toBe(true);
    expect(frozen.fixtures.find((item) => item.id === 'fresh10-large-admitted')).toMatchObject({
      width: 4019,
      height: 2504,
    });
    expect(4019 * 2504).toBe(10_063_576);
    expect(
      frozen.fixtures.filter((item) => item.source === 'video').map((item) => item.frame)
    ).toEqual([101, 143, 101]);
    expect(oldFrames.has(101) || oldFrames.has(143)).toBe(false);
    const groups = [...Map.groupBy(frozen.fixtures, (item) => item.sha256).values()]
      .filter((group) => group.length > 1)
      .map((group) => group.map((item) => item.id));
    expect(groups).toEqual([['fresh10-video-101', 'fresh10-duplicate-hold']]);
    expect(frozen.fixtures.find((item) => item.id === 'fresh10-padded-rgba')?.stride).toBe(
      321 * 4 + 28
    );
    expect(frozen.sources.photo.sha256).toBe(V10_PHOTO.sha256);
    expect(frozen.sources.photo.sha1).toBe('77503952fb9f6245d2c5c0f70eb6f2f92ea87399');
    expect(frozen.sources.photo.sha1).toMatch(/^[a-f0-9]{40}$/);
    expect(V10_PHOTO_REGIONS.primary.x + V10_PHOTO_REGIONS.primary.width).toBeLessThan(
      V10_PHOTO_REGIONS.detail.x
    );
    for (const item of frozen.fixtures.filter((entry) => entry.source === 'generated')) {
      const { pixels, stride } = generateV10Fixture(item.id);
      expect(sha256(pixels)).toBe(item.sha256);
      expect(pixels.length).toBe(stride * item.height);
      if (item.id === 'fresh10-padded-rgba') {
        for (let y = 0; y < item.height; y++)
          expect(
            pixels
              .subarray(y * stride + item.width * 4, (y + 1) * stride)
              .every((value) => value === 0x73)
          ).toBe(true);
      } else if (item.layout === 'BGRA' || item.layout === 'RGBA') {
        expect(pixels.every((value, index) => index % 4 !== 3 || value === 255)).toBe(true);
      }
      if (item.layout === 'BGRX' || item.layout === 'RGBX')
        expect(new Set(pixels.filter((_value, index) => index % 4 === 3)).size).toBeGreaterThan(1);
    }
    expect(() => generateV10Fixture('fresh10-photo')).toThrow('Missing fresh photo source');
    expect(() => generateV10Fixture('fresh10-video-101')).toThrow('Missing video source');
  });
});
