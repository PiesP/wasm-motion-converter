import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from 'vite-plus/test';

import { readAttempts, verifyAttempts } from '../../../scripts/test/owned-vp8-product-attempts.ts';
import type { Distribution } from '../../../scripts/test/owned-vp8-product-timing.ts';

function sha(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}
const encode = (value: unknown) => JSON.stringify(value, null, 2);
const input = 'c6a21a3a7619ca7fbcbc1b4d012d7098d18f599f0200f735d31cae15a4772dd1';
const priorSource = 'be35f5fa89a60189475fe2ef7fd446e9fa18cef4';
const candidateSource = 'a'.repeat(40);
function distributionFixture(kind: 'prior' | 'candidate', sourceSha: string, treeSha: string) {
  const moduleBytes = Buffer.from(`${kind} fixture module bytes`);
  const modulePath =
    kind === 'prior' ? 'assets/webp-wasm-ABCDEFGH.wasm' : 'assets/owned-vp8-ABCDEFGH.wasm';
  const files: Array<[string, string | Buffer]> = [
    [modulePath, moduleBytes],
    ['assets/index.ABCDEFGH.js', `compiled source ${sourceSha}`],
    ['index.html', '<script type="module" src="/assets/index.ABCDEFGH.js"></script>'],
    ['service-worker.js', 'self.addEventListener("fetch",()=>{});'],
    ['assets/__vite-browser-external-ABCDEFGH.js', 'export default {}'],
  ];
  const headers = 'Cross-Origin-Opener-Policy: same-origin';
  const state = {
    schemaVersion: 1,
    sourceDirty: false,
    version: '0.2.5',
    sourceSha,
    treeSha,
    coreSha: 'd'.repeat(40),
    headersSha256: sha(headers),
    files: files.map(([path, bytes]) => ({
      path,
      size: Buffer.byteLength(bytes),
      sha256: sha(bytes),
    })),
  };
  files.push(['_headers', headers], ['deployment-state.json', JSON.stringify(state)]);
  const distribution: Distribution = {
    sourceSha,
    treeSha,
    coreSha: state.coreSha,
    manifestSha256: sha(JSON.stringify(state)),
    module: { path: modulePath, size: moduleBytes.length, sha256: sha(moduleBytes) },
  };
  return { distribution, files };
}
const priorFixture = distributionFixture('prior', priorSource, 'c'.repeat(40));
const candidateFixture = distributionFixture('candidate', candidateSource, 'f'.repeat(40));
const priorDistribution = priorFixture.distribution;
const candidateDistribution = candidateFixture.distribution;
const candidateModule = candidateDistribution.module.sha256;
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

const vmGuid = '11111111-2222-3333-4444-555555555555';

async function writeAttempt(root: string, report: ReturnType<typeof makeReports>[number]) {
  const scenario = report.scenario;
  const output = join(root, 'output');
  await mkdir(join(root, 'payload/validation/windows/inputs'), { recursive: true });
  await mkdir(output);
  const files: Array<[string, string | Buffer]> = [
    ['validation/windows/profile.json', '{}'],
    [`validation/windows/inputs/${scenario}.json`, encode({ scenario })],
    ['guest.mjs', 'guest fixture'],
    ...priorFixture.files.map(([name, bytes]): [string, string | Buffer] => [
      `validation/windows/prior-dist/${name}`,
      bytes,
    ]),
    ...candidateFixture.files.map(([name, bytes]): [string, string | Buffer] => [
      `dist/${name}`,
      bytes,
    ]),
    ['node_modules/playwright-core/node_modules/.bin/playwright-core', 'bin fixture'],
  ];
  for (const [name, content] of files) {
    const path = join(root, 'payload', name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  const run = 'controller fixture';
  const buildLog = 'build fixture';
  await writeFile(join(root, 'run.ps1'), run);
  await writeFile(join(root, 'build.log'), buildLog);
  const bundle = {
    schema_version: 1,
    source_sha: candidateSource,
    core_sha: candidateDistribution.coreSha,
    project: 'wasm-motion-converter',
    profile: 'wmc-media',
    scenario,
    browser: 'msedge',
    mode: 'desktop',
    installation: null,
    live_urls: [],
    live_observation: null,
    runtime: { guest_seconds: 600 },
    files: files.map(([file, content]) => ({ file, sha256: sha(content) })),
    controller_sha256: sha(run),
    packager_sha256: '4'.repeat(64),
    build_log_sha256: sha(buildLog),
  };
  const bundleText = encode(bundle);
  await writeFile(join(root, 'bundle.json'), bundleText);
  await writeFile(join(root, 'payload/bundle.json'), bundleText);
  await writeFile(
    join(root, 'transport.json'),
    encode({ collected: true, guest_cleanup: true, failed_guest_root: null })
  );
  const snapshot = {
    vm_id: vmGuid,
    os: 'Windows 11',
    build: '26100',
    full_build: '26100.1',
    boot_utc: '2026-11-15T00:00:00Z',
    total_memory_mib: 8192,
    gpu: [{ Name: 'Hyper-V Video', DriverVersion: '1.0' }],
    desktop_dpi: 96,
    display_width: 1366,
    display_height: 768,
    text_scale: 100,
    native_high_contrast: false,
  };
  const environment = {
    before: snapshot,
    after: { ...snapshot },
    readiness: 'passed',
    drift: 'passed',
    browser_version: '123.0',
  };
  const reportName = `${scenario}.json`;
  await writeFile(join(output, reportName), encode(report));
  await writeFile(join(output, 'environment.json'), encode(environment));
  await writeFile(join(output, 'stdout.txt'), '');
  await writeFile(join(output, 'stderr.txt'), '');
  await refresh(root);
}

async function refresh(root: string) {
  const output = join(root, 'output');
  const bundle = await readFile(join(root, 'bundle.json'));
  await writeFile(join(root, 'payload/bundle.json'), bundle);
  const reportName = (JSON.parse(bundle.toString()) as { scenario: string }).scenario + '.json';
  const artifacts = await Promise.all(
    [reportName, 'environment.json'].map(async (file) => {
      const bytes = await readFile(join(output, file));
      return { file, bytes: bytes.length, sha256: sha(bytes) };
    })
  );
  const bundleObject = JSON.parse(bundle.toString()) as Record<string, unknown>;
  const result = {
    schema_version: 1,
    source_sha: bundleObject.source_sha,
    core_sha: bundleObject.core_sha,
    project: bundleObject.project,
    profile: bundleObject.profile,
    browser: bundleObject.browser,
    mode: bundleObject.mode,
    installation: null,
    live_urls: [],
    live_observation: null,
    runtime: bundleObject.runtime,
    bundle_sha256: sha(bundle),
    status: 'passed',
    browser_version: '123.0',
    observations: {
      status: 'passed',
      profile: bundleObject.scenario,
      report: reportName,
      samples: 4,
    },
    artifacts,
  };
  await writeFile(join(output, 'result.json'), encode(result));
  const collection = await Promise.all(
    [reportName, 'environment.json', 'stdout.txt', 'stderr.txt', 'result.json'].map(
      async (file) => ({
        file,
        sha256: sha(await readFile(join(output, file))),
      })
    )
  );
  await writeFile(join(root, 'collection.json'), encode(collection));
}

async function withAttempts(run: (roots: string[]) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'owned-vp8-attempts-'));
  try {
    const roots: string[] = [];
    for (const [index, report] of makeReports().entries()) {
      const root = join(base, `attempt-${index + 1}`);
      await writeAttempt(root, report);
      roots.push(root);
    }
    await run(roots);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test('joins fifteen complete physical attempt payloads and retains their metadata scope', async () => {
  await withAttempts(async (roots) => {
    const result = await readAttempts(roots, expected);
    assert.equal(result.reports.length, 15);
    assert.equal(result.attempts.length, 15);
    assert.equal(result.common.get('browser'), '"msedge"');
    assert.equal(result.common.get('vm_id'), `"${vmGuid}"`);
    assert.ok(result.missing.has('neighbor load trace'));
    assert.ok(!JSON.stringify(result).includes(roots[0]!));
    await assert.rejects(verifyAttempts(roots, expected), /frozen prior module/);
  });
});

test('rejects duplicate attempts and tampered collected bytes', async () => {
  await withAttempts(async (roots) => {
    await assert.rejects(
      verifyAttempts([roots[0]!, ...roots.slice(0, 14)], expected),
      /duplicate attempt root/
    );
    await writeFile(join(roots[0]!, 'output', 'stdout.txt'), 'tampered');
    await assert.rejects(verifyAttempts(roots, expected), /collected stdout.txt digest/);
  });
});

test('rejects a changed or missing physical module and a forged compiled app', async () => {
  await withAttempts(async (roots) => {
    const root = roots[0]!;
    const modulePath = join(root, 'payload/dist', candidateDistribution.module.path);
    await writeFile(modulePath, 'changed module');
    await assert.rejects(readAttempts(roots, expected), /payload file digest/);
    await rm(modulePath);
    await assert.rejects(readAttempts(roots, expected), /payload file inventory/);
  });
  await withAttempts(async (roots) => {
    const root = roots[0]!;
    const appName = 'dist/assets/index.ABCDEFGH.js';
    const appPath = join(root, 'payload', appName);
    const forged = 'compiled source ' + '0'.repeat(40);
    await writeFile(appPath, forged);
    const bundlePath = join(root, 'bundle.json');
    const bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as {
      files: Array<{ file: string; sha256: string }>;
    };
    bundle.files.find((file) => file.file === appName)!.sha256 = sha(forged);
    await writeFile(bundlePath, encode(bundle));
    await refresh(root);
    await assert.rejects(readAttempts(roots, expected), /hash differs|compiled source identity/);
  });
});

test('CLI does not echo malformed private JSON content or paths', async () => {
  await withAttempts(async (roots) => {
    const secret = 'private-secret-token';
    await writeFile(join(roots[0]!, 'collection.json'), `{ "${secret}": `);
    const script = fileURLToPath(
      new URL('../../../scripts/test/owned-vp8-product-attempts.ts', import.meta.url)
    );
    const launched = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        script,
        '--prior-dist',
        join(roots[0]!, 'payload/validation/windows/prior-dist'),
        '--candidate-dist',
        join(roots[0]!, 'payload/dist'),
        '--candidate-source-sha',
        candidateSource,
        '--candidate-module-sha256',
        candidateModule,
        ...roots.flatMap((root) => ['--attempt', root]),
      ],
      { encoding: 'utf8' }
    );
    assert.equal(launched.status, 2, launched.stderr);
    assert.match(launched.stdout, /collection is malformed JSON/);
    assert.ok(!launched.stdout.includes(secret));
    assert.ok(!launched.stdout.includes(roots[0]!));
  });
});

test('rejects failed readiness and mismatched source even when local files are rehashed', async () => {
  await withAttempts(async (roots) => {
    const root = roots[0]!;
    const environmentPath = join(root, 'output/environment.json');
    const environment = JSON.parse(await readFile(environmentPath, 'utf8')) as {
      readiness: string;
    };
    environment.readiness = 'failed';
    await writeFile(environmentPath, encode(environment));
    await refresh(root);
    await assert.rejects(verifyAttempts(roots, expected), /environment readiness/);
    environment.readiness = 'passed';
    await writeFile(environmentPath, encode(environment));
    await refresh(root);
    const bundlePath = join(root, 'bundle.json');
    const bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as { source_sha: string };
    bundle.source_sha = '9'.repeat(40);
    await writeFile(bundlePath, encode(bundle));
    await refresh(root);
    await assert.rejects(verifyAttempts(roots, expected), /bundle candidate source/);
  });
});

test('rejects linked collected files and missing output inventory', async () => {
  await withAttempts(async (roots) => {
    const root = roots[0]!;
    const target = join(root, 'output/stdout.txt');
    await rm(target);
    await symlink(join(root, 'output/stderr.txt'), target);
    await assert.rejects(verifyAttempts(roots, expected), /linked/);
  });
  await withAttempts(async (roots) => {
    await writeFile(join(roots[0]!, 'output/extra.txt'), 'uncollected');
    await assert.rejects(verifyAttempts(roots, expected), /output file inventory/);
  });
});

test('rejects malformed records, duplicate collected names, and bundle path escape', async () => {
  await withAttempts(async (roots) => {
    const root = roots[0]!;
    const path = join(root, 'collection.json');
    const collection = JSON.parse(await readFile(path, 'utf8')) as Array<{
      file: string;
      sha256: string;
    }>;
    collection.push({ ...collection[0]! });
    await writeFile(path, encode(collection));
    await assert.rejects(verifyAttempts(roots, expected), /duplicate collected file name/);
    await writeFile(path, '{invalid');
    await assert.rejects(verifyAttempts(roots, expected), /JSON/);
  });
  await withAttempts(async (roots) => {
    const root = roots[0]!;
    const path = join(root, 'bundle.json');
    const bundle = JSON.parse(await readFile(path, 'utf8')) as {
      files: Array<{ file: string; sha256: string }>;
    };
    bundle.files.push({ file: '../escape', sha256: 'a'.repeat(64) });
    await writeFile(path, encode(bundle));
    await refresh(root);
    await assert.rejects(verifyAttempts(roots, expected), /bundle file path is unsafe/);
  });
});

test('rejects a mismatched module inventory and a non-V8 selector', async () => {
  await withAttempts(async (roots) => {
    const root = roots[0]!;
    const path = join(root, 'bundle.json');
    const bundle = JSON.parse(await readFile(path, 'utf8')) as {
      files: Array<{ file: string; sha256: string }>;
      scenario: string;
    };
    bundle.files.find((file) => file.file === `dist/${candidateDistribution.module.path}`)!.sha256 =
      '9'.repeat(64);
    await writeFile(path, encode(bundle));
    await refresh(root);
    await assert.rejects(verifyAttempts(roots, expected), /payload file digest/);
    bundle.files.find((file) => file.file === `dist/${candidateDistribution.module.path}`)!.sha256 =
      candidateModule;
    bundle.scenario = 'owned-vp8-product-near-cap';
    await writeFile(path, encode(bundle));
    await assert.rejects(verifyAttempts(roots, expected), /bundle scenario is not V8/);
  });
});
