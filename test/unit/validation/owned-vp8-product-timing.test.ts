import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  type Distribution,
  readDistribution,
  verifyTiming,
} from '../../../scripts/test/owned-vp8-product-timing.ts';

const input = 'c6a21a3a7619ca7fbcbc1b4d012d7098d18f599f0200f735d31cae15a4772dd1';
const priorSource = 'be35f5fa89a60189475fe2ef7fd446e9fa18cef4';
const priorModule = '4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22';
const candidateSource = 'a'.repeat(40);
const candidateModule = 'b'.repeat(64);
const priorDistribution: Distribution = {
  sourceSha: priorSource,
  treeSha: 'c'.repeat(40),
  coreSha: 'd'.repeat(40),
  manifestSha256: 'e'.repeat(64),
  module: { path: 'assets/webp-wasm-ABCDEFGH.wasm', size: 100, sha256: priorModule },
};
const candidateDistribution: Distribution = {
  sourceSha: candidateSource,
  treeSha: 'f'.repeat(40),
  coreSha: 'd'.repeat(40),
  manifestSha256: '1'.repeat(64),
  module: { path: 'assets/owned-vp8-ABCDEFGH.wasm', size: 101, sha256: candidateModule },
};
const expected = {
  candidateSourceSha: candidateSource,
  candidateModuleSha256: candidateModule,
  priorDistribution,
  candidateDistribution,
};
const qualityCadence = { low: 12, medium: 18, high: 30 } as const;

function makeReports(candidateTime = 1010) {
  return (['low', 'medium', 'high'] as const).flatMap((quality, qualityIndex) =>
    Array.from({ length: 5 }, (_, invocation) => {
      const ba = invocation % 2 === 1;
      const scenario = `owned-vp8-product-v8-${quality}${ba ? '-ba' : ''}`;
      const start = 1_800_000_000_000 + qualityIndex * 1_000_000 + invocation * 100_000;
      const order = ba ? ['candidate', 'prior'] : ['prior', 'candidate'];
      const samples = order.flatMap((build, buildIndex) =>
        (['first-in-document', 'same-document-warm'] as const).map((condition, conditionIndex) => ({
          build,
          fixture: 'v8-full',
          quality,
          condition,
          targetCadenceFps: qualityCadence[quality],
          scale: 1,
          smartFrameSkip: 'off',
          wallStart: new Date(start + buildIndex * 20_000 + conditionIndex * 10_000).toISOString(),
          inputSha256: input,
          timeOrigin: start + buildIndex * 20_000,
          contextCacheScope:
            'new browser context for this build; first is first-in-document, not proven fresh-profile cold',
          navigationCount: 1,
          requestToDownloadReadyMs: build === 'prior' ? 1000 : candidateTime,
          requestToBlobPublicationMs: 900,
          wasmResources: [
            {
              name: `http://127.0.0.1:12345/${build === 'prior' ? priorDistribution.module.path : candidateDistribution.module.path}`,
              transferSize: 150,
              encodedBodySize: 100,
            },
          ],
          emittedAnmfCount: 10,
          saved: {
            file: `${scenario}-${invocation}-${build}-${condition}.webp`,
            bytes: 100,
            sha256: '2'.repeat(64),
          },
          parsed: { frames: [] },
          decoded: { frames: [] },
          contextIdentity: `${scenario}:${build}`,
          pageIdentity: `v8-full:${quality}`,
        }))
      );
      return {
        schemaVersion: 1,
        scenario,
        fixedQuality: quality,
        status: 'passed',
        browserVersion: '123.0',
        order,
        prior: Object.fromEntries(
          ['sourceSha', 'treeSha', 'coreSha', 'manifestSha256'].map((key) => [
            key,
            priorDistribution[key as keyof Distribution],
          ])
        ),
        candidate: Object.fromEntries(
          ['sourceSha', 'treeSha', 'coreSha', 'manifestSha256'].map((key) => [
            key,
            candidateDistribution[key as keyof Distribution],
          ])
        ),
        timingScope:
          'UI Convert click to matching published WebP Blob download control ready; save, parse and independent decode follow timing',
        cacheScope:
          'separate browser contexts per build, same document first/warm within each fixture-quality page; no fresh-profile cold claim',
        frozenInputManifestSha256: '3'.repeat(64),
        inputs: [
          {
            id: 'v8-full',
            path: 'validation/windows/owned-vp8-inputs/v8.webm',
            sha256: input,
            bytes: 3_145_371,
          },
        ],
        ownedAsset: candidateDistribution.module,
        samples,
        functional: [
          {
            route: 'ui-main-v8-cadence',
            fixture: 'v8-full',
            quality,
            inputSha256: input,
            targetCadenceFps: qualityCadence[quality],
            abi: { instances: 1, successfulBeginCalls: 50 },
            emittedAnmfCount: 10,
          },
        ],
      };
    })
  );
}

test('five balanced receipts per quality retain first and warm cohorts without claiming qualification', () => {
  const result = verifyTiming(makeReports(), expected);
  assert.equal(result.status, 'NOT_VERIFIED');
  assert.equal(result.numericGate, 'PASS');
  assert.equal(result.conditions.length, 6);
  assert.equal(result.samples.length, 60);
  assert.deepEqual(result.conditions[0]?.prior, {
    samplesMs: [1000, 1000, 1000, 1000, 1000],
    medianMs: 1000,
    rangeMs: 0,
    madMs: 0,
  });
  assert.equal(result.conditions[0]?.allowanceMs, 50);
});

test('a median increase above five percent fails the numeric gate', () => {
  const result = verifyTiming(makeReports(1051), expected);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.conditions[0]?.increaseMs, 51);
});

test('the twenty millisecond floor is applied for short runs', () => {
  const reports = makeReports(30);
  for (const report of reports)
    for (const sample of report.samples) {
      if (sample.build === 'prior') sample.requestToDownloadReadyMs = 10;
      sample.requestToBlobPublicationMs = 5;
    }
  assert.equal(verifyTiming(reports, expected).conditions[0]?.allowanceMs, 20);
});

test('rejects duplicates, nonfinite values, incomplete samples, and identity drift', () => {
  const duplicate = makeReports();
  duplicate[1] = structuredClone(duplicate[0]!);
  assert.throws(() => verifyTiming(duplicate, expected), /duplicate controller receipt/);
  const nonfinite = makeReports();
  nonfinite[0]!.samples[0]!.requestToDownloadReadyMs = Number.NaN;
  assert.throws(() => verifyTiming(nonfinite, expected), /not finite/);
  const incomplete = makeReports();
  incomplete[0]!.samples.pop();
  assert.throws(() => verifyTiming(incomplete, expected), /sample count/);
  const sourceDrift = makeReports();
  sourceDrift[0]!.candidate.sourceSha = '9'.repeat(40);
  assert.throws(() => verifyTiming(sourceDrift, expected), /candidate sourceSha/);
  const wrongResource = makeReports();
  wrongResource[0]!.samples[0]!.wasmResources[0]!.name = 'http://127.0.0.1:12345/assets/other.wasm';
  assert.throws(() => verifyTiming(wrongResource, expected), /expected module resource/);
  const missingCadence = makeReports();
  missingCadence[0]!.functional = [];
  assert.throws(() => verifyTiming(missingCadence, expected), /functional check count/);
});

test('does not accept a self-consistent but unpinned candidate', () => {
  assert.throws(
    () => verifyTiming(makeReports(), { ...expected, candidateSourceSha: '8'.repeat(40) }),
    /candidate source/
  );
  assert.throws(
    () => verifyTiming(makeReports(), { ...expected, candidateModuleSha256: '8'.repeat(64) }),
    /candidate module/
  );
});

test('distribution admission binds the manifest to actual module bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'owned-vp8-timing-'));
  try {
    const module = Buffer.from('compiled module bytes');
    const moduleSha = createHash('sha256').update(module).digest('hex');
    const headers = Buffer.from('/*\n  Cross-Origin-Opener-Policy: same-origin\n');
    const headersSha = createHash('sha256').update(headers).digest('hex');
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, candidateDistribution.module.path), module);
    await writeFile(join(directory, '_headers'), headers);
    const state = {
      schemaVersion: 1,
      sourceDirty: false,
      sourceSha: candidateSource,
      treeSha: candidateDistribution.treeSha,
      coreSha: candidateDistribution.coreSha,
      headersSha256: headersSha,
      files: [{ path: candidateDistribution.module.path, size: module.length, sha256: moduleSha }],
    };
    await writeFile(join(directory, 'deployment-state.json'), JSON.stringify(state));
    assert.equal((await readDistribution(directory, 'candidate')).module.sha256, moduleSha);
    await writeFile(join(directory, candidateDistribution.module.path), 'modified');
    await assert.rejects(readDistribution(directory, 'candidate'), /size differs/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
