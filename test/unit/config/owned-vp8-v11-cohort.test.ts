import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  V11_HELDOUT,
  V11_PHOTO,
  V11_PHOTO_REGIONS,
  generateV11Fixture,
} from '../../../scripts/test/owned-vp8-v11-fixtures.ts';

const root = resolve(import.meta.dirname, '../../..');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const fileHash = (file: string): string => sha256(readFileSync(resolve(root, file)));
const oldSuffixes = ['v2', 'v2-correction', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10'];

describe('owned VP8 V11 frozen source and exposed regression routing', () => {
  it('validates the common V1–V11 source pins before codec setup', () => {
    const preflight = validateFixtureSourcePins('corrected-v11');
    const initial = JSON.parse(readFileSync(preflight.baselineManifestFile, 'utf8')) as {
      generatorSha256: string;
    };
    expect(initial.generatorSha256).toBe(fileHash('scripts/test/owned-vp8-v2-fixtures.ts'));
    expect(preflight.frozen.fixtures).toHaveLength(209);
    expect(preflight.frozen.fixtures.slice(-20).map((entry) => entry.id)).toEqual(
      V11_HELDOUT.map((entry) => entry.id)
    );
  });

  it('selects the full exposed V11 cohort and keeps every held-out cohort regression only', () => {
    const selected = selectFixtureCohort('held-out', 'corrected-v11', true);
    expect(selected).toEqual(V11_HELDOUT);
    expect(fixtureSelectionIdentity(selected, 'held-out', true, false)).toMatchObject({
      expectedConditionCount: 60,
      completeCohort: true,
      scope: 'EXPOSED_REGRESSION_ONLY_NOT_FRESH_ACCEPTANCE',
    });
    expect(selectFixtureCohort('tuning', 'corrected-v11')).toHaveLength(15);
    expect(() => selectFixtureCohort('held-out', 'corrected-v11')).toThrow('exposed');
    expect(() => selectFixtureCohort('held-out', 'corrected-v11', false, ['fresh11-gray'])).toThrow(
      'diagnostic only'
    );
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
      'corrected-v11',
    ] as const) {
      expect(() => selectFixtureCohort('held-out', cohort)).toThrow('exposed');
      expect(selectFixtureCohort('held-out', cohort, true).length).toBeGreaterThan(0);
    }
  });

  it('rejects full and subset acceptance before creating evidence or initializing codecs', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'owned-vp8-v11-subset-'));
    const output = join(parent, 'evidence');
    try {
      for (const subset of [false, true]) {
        await expect(
          compare({
            output,
            split: 'held-out',
            cohort: 'corrected-v11',
            ...(subset ? { fixtureIds: ['fresh11-gray'] } : {}),
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
            'corrected-v11',
            '--acceptance',
            ...(subset ? ['--fixture', 'fresh11-gray'] : []),
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
      expect(selectFixtureCohort('held-out', 'corrected-v11', true)).toHaveLength(20);
      expect(selectFixtureCohort('held-out', 'corrected-v11', true, ['fresh11-gray'])).toHaveLength(
        1
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('binds all 20 V11 inputs to the frozen manifest and ABI layouts', () => {
    const frozen = JSON.parse(
      readFileSync(resolve(root, 'docs/experiments/501-owned-vp8-v11-fixtures.json'), 'utf8')
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
    expect(frozen.cohort).toBe('corrected-v11');
    expect(frozen.generatorSha256).toBe(fileHash('scripts/test/owned-vp8-v11-fixtures.ts'));
    expect(frozen.thresholds).toEqual({
      psnrBaselineDeltaDb: -1,
      ssimBaselineDelta: -0.01,
      sizeRatio: 1.25,
      sizeAdditiveBytes: 128,
    });
    for (const [index, suffix] of oldSuffixes.entries()) {
      const key = index === 0 ? 'initialV1' : `correctedV${index + 1}`;
      expect(frozen.priorManifestSha256[key]).toBe(
        fileHash(`docs/experiments/501-owned-vp8-${suffix}-fixtures.json`)
      );
    }
    const old = oldSuffixes.flatMap(
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
    expect(old).toHaveLength(189);
    const oldIds = new Set(old.map((entry) => entry.id));
    const oldHashes = new Set(old.map((entry) => entry.sha256));
    const oldFrames = new Set(
      old.map((entry) => entry.frame).filter((frame) => frame !== undefined)
    );
    expect(frozen.fixtures).toHaveLength(20);
    expect(frozen.fixtures.map((entry) => entry.id)).toEqual(V11_HELDOUT.map((entry) => entry.id));
    expect(new Set(frozen.fixtures.map((entry) => entry.id)).size).toBe(20);
    expect(
      frozen.fixtures.every((entry) => !oldIds.has(entry.id) && !oldHashes.has(entry.sha256))
    ).toBe(true);
    expect(frozen.fixtures.every((entry) => entry.qualities.join(',') === '60,75,85')).toBe(true);
    expect(
      frozen.fixtures.filter((entry) => entry.source === 'video').map((entry) => entry.frame)
    ).toEqual([111, 171, 111]);
    expect(oldFrames.has(111) || oldFrames.has(171)).toBe(false);
    const duplicates = [...Map.groupBy(frozen.fixtures, (entry) => entry.sha256).values()]
      .filter((group) => group.length > 1)
      .map((group) => group.map((entry) => entry.id));
    expect(duplicates).toEqual([['fresh11-video-111', 'fresh11-duplicate-hold']]);
    expect(frozen.fixtures.find((entry) => entry.id === 'fresh11-large-admitted')).toMatchObject({
      width: 4001,
      height: 2515,
    });
    expect(4001 * 2515).toBeLessThanOrEqual(10_066_329);
    expect(frozen.fixtures.find((entry) => entry.id === 'fresh11-packed-rgb24')?.stride).toBe(
      329 * 3
    );
    expect(frozen.fixtures.find((entry) => entry.id === 'fresh11-padded-rgba')?.stride).toBe(
      325 * 4 + 36
    );
    expect(frozen.sources.photo.sha1).toBe(V11_PHOTO.sha1);
    expect(frozen.sources.photo.sha1).toMatch(/^[a-f0-9]{40}$/);
    expect(frozen.sources.photo.sha256).toBe(V11_PHOTO.sha256);
    expect(V11_PHOTO_REGIONS.primary.x + V11_PHOTO_REGIONS.primary.width).toBeLessThan(
      V11_PHOTO_REGIONS.detail.x
    );
    for (const entry of frozen.fixtures.filter((item) => item.source === 'generated')) {
      const fixture = generateV11Fixture(entry.id);
      expect(sha256(fixture.pixels)).toBe(entry.sha256);
      expect(fixture.pixels.length).toBe(entry.stride * entry.height);
      expect(rgbPixels(fixture).length).toBe(entry.width * entry.height * 3);
      if (entry.layout === 'RGB24') {
        const primaryRgba = new Uint8Array(entry.width * entry.height * 4);
        for (let pixel = 0; pixel < entry.width * entry.height; pixel++) {
          primaryRgba.set(fixture.pixels.subarray(pixel * 3, pixel * 3 + 3), pixel * 4);
          primaryRgba[pixel * 4 + 3] = 255;
        }
        expect(rgbPixels(fixture)).toEqual(fixture.pixels);
        expect(
          rgbPixels({ ...fixture, layout: 'RGBA', stride: entry.width * 4, pixels: primaryRgba })
        ).toEqual(rgbPixels(fixture));
      }
      if (entry.id === 'fresh11-padded-rgba') {
        for (let y = 0; y < entry.height; y++)
          expect(
            fixture.pixels
              .subarray(y * entry.stride + entry.width * 4, (y + 1) * entry.stride)
              .every((byte) => byte === 0x6d)
          ).toBe(true);
      }
    }
    expect(() => generateV11Fixture('fresh11-photo')).toThrow('Missing fresh photo source');
    expect(() => generateV11Fixture('fresh11-video-111')).toThrow('Missing video source');
  });
});
