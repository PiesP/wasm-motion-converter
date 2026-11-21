import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import type { DeploymentState } from '../../../scripts/build/deployment-state';
import { preserveDeploymentDiagnostics } from '../../../scripts/test/deployment-diagnostics';
import {
  isRetiredWebpExecutable,
  RETIRED_REQUEST_MODES,
  RETIRED_WEBP_EXECUTABLES,
  RETIRED_WEBP_SHIM,
} from '../../../scripts/test/retired-webp-assets';

const target = new URL('https://wasm-motion-converter.pages.dev/');
const asset = 'assets/app-12345678.js';
const state: DeploymentState = {
  schemaVersion: 1,
  sourceSha: 'a'.repeat(40),
  treeSha: 'b'.repeat(40),
  coreSha: 'c'.repeat(40),
  headersSha256: 'd'.repeat(64),
  version: '0.2.3',
  branch: 'master',
  sourceDirty: false,
  files: [{ path: asset, size: 1, sha256: 'e'.repeat(64) }],
};
const module = {
  path: 'assets/owned-vp8-AbCdEf01.wasm',
  size: 129,
  sha256: 'f'.repeat(64),
};
const finalState = { ...state, files: [...state.files, module] };
const manifestSha256 = '1'.repeat(64);
const finalMode = { requireOwnedVp8Only: true, expectedManifestSha256: manifestSha256 };
const forcedEncoder = {
  sourceSha: state.sourceSha,
  treeSha: state.treeSha,
  coreSha: state.coreSha,
  manifestSha256,
  ownedOnlyInventory: true,
  legacyExecutables: [],
  unexpectedWasm: [],
  software: {
    family: 'owned-vp8',
    asset: module,
    abi: { successfulBeginCalls: 3, stepCalls: 9 },
    requested: [`/${module.path}`],
    fromServiceWorker: false,
    decodedFrames: 3,
    outputBytes: 1024,
    outputSha256: '2'.repeat(64),
  },
};
const retiredUrls = RETIRED_REQUEST_MODES.flatMap((mode) =>
  RETIRED_WEBP_EXECUTABLES.map((file) => ({
    mode,
    url: new URL(`/${file.path}`, target).href,
    priorSha256: file.sha256,
    responseSha256: '3'.repeat(64),
    status: 404,
    cacheControl: 'public, max-age=0, must-revalidate',
    contentType: 'text/html; charset=utf-8',
  }))
);
const conditional = [
  {
    path: asset,
    etag: '"abc"',
    conditionalEtag: null,
    rfc9110Etag: false,
    compatibilityException: 'pages-304-etag-omission',
    status: 304,
    unmatchedStatus: 200,
  },
];
const timing = {
  target: target.href,
  measuredAt: '2026-10-12T00:00:00.000Z',
  browserProject: 'chromium',
  totalTransferSize: 12345,
  resources: [{ name: new URL(`/${asset}`, target).href, transferSize: 12345 }],
};

function traffic(scenario = 'normal-gif') {
  return {
    schemaVersion: 1,
    target: target.href,
    measuredAt: timing.measuredAt,
    browserVersion: '155.0.1.0',
    scenario,
    phase: 'cumulative-first-conversion',
    phaseBoundaryMs: 100,
    cache: 'fresh-browser-context-http-cache-not-disabled',
    serviceWorkers: 'blocked',
    coverage: 'page-resource-timing-only-worker-internal-traffic-unknown',
    contentEncoding: 'response-header-when-observed-null-is-unavailable',
    runtimeMemoryBytes: null,
    outputBytes: 1024,
    resources: [
      {
        path: `/${asset}`,
        initiatorType: 'script',
        contentEncoding: 'br',
        startTime: 10,
        transferSize: 12345,
        encodedBodySize: 12045,
        decodedBodySize: 20000,
      },
      {
        path: `/${asset}`,
        initiatorType: 'fetch',
        contentEncoding: null,
        startTime: 110,
        transferSize: 0,
        encodedBodySize: 0,
        decodedBodySize: 0,
      },
    ],
  };
}

function report(
  options: {
    missing?: string;
    target?: string;
    status?: string;
    traffic?: unknown;
    final?: boolean;
    forcedEncoder?: unknown;
    retiredUrls?: unknown;
  } = {}
) {
  function suite(
    file: string,
    title: string,
    name: string,
    value: unknown,
    extra: [string, unknown][] = []
  ) {
    return {
      file,
      specs: [
        {
          file,
          title,
          tests: [
            {
              projectName: 'chromium',
              status: options.status === 'skipped' ? 'skipped' : 'expected',
              results: [
                {
                  retry: 0,
                  status: options.status ?? 'passed',
                  attachments: ([[name, value], ...extra] as [string, unknown][])
                    .filter(([attachment]) => attachment !== options.missing)
                    .map(([attachment, observation]) => ({
                      name: attachment,
                      contentType: 'application/json',
                      body: Buffer.from(JSON.stringify(observation)).toString('base64'),
                    })),
                },
              ],
            },
          ],
        },
      ],
      suites: [],
    };
  }
  return {
    stats: {
      startTime: '2026-10-12T00:00:00.000Z',
      expected: 2,
      skipped: 0,
      unexpected: 0,
      flaky: 0,
    },
    suites: [
      suite(
        'e2e/deploy-smoke.spec.ts',
        'Pages serves one security and cache policy per document, metadata, and fingerprinted asset',
        'conditional-header-observations',
        options.final ? [...conditional, { ...conditional[0], path: module.path }] : conditional,
        options.final ? [['retired-webp-urls', options.retiredUrls ?? retiredUrls]] : []
      ),
      suite('e2e/dogfood-qa.spec.ts', 'total JS transfer size under 150KB', 'js-transfer-timing', {
        ...timing,
        target: options.target ?? timing.target,
      }),
      suite(
        'e2e/deploy-smoke.spec.ts',
        'GIF conversion starts a module worker and downloads valid bytes',
        'first-gif-traffic',
        options.traffic ?? traffic()
      ),
      suite(
        'e2e/deploy-smoke.spec.ts',
        options.final
          ? 'Forced WebP downloads a decodable animation from the inventoried software encoder'
          : 'WebP conversion uses real WASM fallback and downloads valid bytes',
        'first-webp-traffic',
        traffic('forced-webp-wasm'),
        options.final ? [['forced-webp-encoder', options.forcedEncoder ?? forcedEncoder]] : []
      ),
    ],
  };
}

const directories: string[] = [];
function fixture(value: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'wmc-diagnostic-test-'));
  directories.push(directory);
  const file = join(directory, 'report.json');
  writeFileSync(file, JSON.stringify(value));
  return { file, output: join(directory, 'test-results') };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('deployment diagnostic artifact', () => {
  it('binds the final software route and all four archived Pages URLs to the validated artifact', () => {
    const { file, output } = fixture(report({ final: true }));
    const path = preserveDeploymentDiagnostics(file, finalState, target, 0, output, finalMode);
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    expect(artifact.diagnostics[3].attempts[0].forcedEncoder).toEqual(forcedEncoder);
    expect(artifact.diagnostics[0].attempts[0].retiredUrls).toEqual(retiredUrls);
  });

  it('identifies the predecessor shim even when renamed, while allowing the generic Vite helper', () => {
    expect(isRetiredWebpExecutable(RETIRED_WEBP_SHIM.path)).toBe(true);
    expect(isRetiredWebpExecutable(`/${RETIRED_WEBP_SHIM.path}`)).toBe(true);
    expect(isRetiredWebpExecutable('assets/renamed.js', RETIRED_WEBP_SHIM.sha256)).toBe(true);
    expect(isRetiredWebpExecutable('assets/__vite-browser-external.leW0L_I9.js')).toBe(false);
  });

  it('rejects final evidence with the historical title or either attachment absent', () => {
    for (const options of [
      {},
      { final: true, missing: 'forced-webp-encoder' },
      { final: true, missing: 'retired-webp-urls' },
    ]) {
      const { file, output } = fixture(report(options));
      expect(() =>
        preserveDeploymentDiagnostics(file, finalState, target, 0, output, finalMode)
      ).toThrow();
    }
  });

  it.each([
    { ...forcedEncoder, coreSha: '0'.repeat(40) },
    { ...forcedEncoder, manifestSha256: '0'.repeat(64) },
    {
      ...forcedEncoder,
      software: { ...forcedEncoder.software, asset: { ...module, sha256: '0'.repeat(64) } },
    },
    { ...forcedEncoder, software: { ...forcedEncoder.software, fromServiceWorker: true } },
    {
      ...forcedEncoder,
      software: { ...forcedEncoder.software, abi: { successfulBeginCalls: 0, stepCalls: 9 } },
    },
  ])('rejects stale, unbound or non-executed final software evidence', (observation) => {
    const { file, output } = fixture(report({ final: true, forcedEncoder: observation }));
    expect(() =>
      preserveDeploymentDiagnostics(file, finalState, target, 0, output, finalMode)
    ).toThrow('Invalid or unbound forced WebP encoder observation');
  });

  it.each(
    [
      retiredUrls.slice(1),
      retiredUrls.filter((row) => row.priorSha256 !== RETIRED_WEBP_SHIM.sha256),
      [{ ...retiredUrls[0], mode: 'revalidated' }, ...retiredUrls.slice(1)],
      [{ ...retiredUrls[0], status: 302 }, ...retiredUrls.slice(1)],
      [{ ...retiredUrls[0], cacheControl: 'immutable' }, ...retiredUrls.slice(1)],
      [{ ...retiredUrls[0], contentType: 'application/wasm' }, ...retiredUrls.slice(1)],
      [{ ...retiredUrls[0], responseSha256: retiredUrls[0]?.priorSha256 }, ...retiredUrls.slice(1)],
    ].map((rows) => ({ rows }))
  )('rejects incomplete or unsafe archived URL responses', ({ rows }) => {
    const { file, output } = fixture(report({ final: true, retiredUrls: rows }));
    expect(() =>
      preserveDeploymentDiagnostics(file, finalState, target, 0, output, finalMode)
    ).toThrow(/retired WebP URL observation/);
  });

  it('keeps a flaky public run outside the final owned-only receipt', () => {
    const value = report({ final: true });
    const test = value.suites[3]!.specs[0]!.tests[0]!;
    test.status = 'flaky';
    test.results[0]!.retry = 1;
    test.results.unshift({ retry: 0, status: 'failed', attachments: [] });
    value.stats.flaky = 1;
    const { file, output } = fixture(value);
    expect(() =>
      preserveDeploymentDiagnostics(file, finalState, target, 0, output, finalMode)
    ).toThrow('complete, single-attempt pass');
  });

  it('accepts the exact report byte limit and rejects overflow before writing evidence', () => {
    const { file, output } = fixture(report());
    const content = readFileSync(file);
    writeFileSync(file, Buffer.concat([content, Buffer.alloc(2_000_000 - content.length, 0x20)]));
    expect(() => preserveDeploymentDiagnostics(file, state, target, 0, output)).not.toThrow();
    const artifacts = readdirSync(output);
    appendFileSync(file, ' ');
    expect(() => preserveDeploymentDiagnostics(file, state, target, 0, output)).toThrow(
      'Deployment Playwright report exceeds byte limit'
    );
    expect(readdirSync(output)).toEqual(artifacts);
  });

  it('retains successful conditional and timing data with source, target, outcome and retry identity', () => {
    const { file, output } = fixture(report());
    const path = preserveDeploymentDiagnostics(file, state, target, 0, output);
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    expect(path).toContain(`${state.sourceSha.slice(0, 12)}-`);
    expect(artifact).toMatchObject({
      sourceSha: state.sourceSha,
      treeSha: state.treeSha,
      target: target.href,
      playwrightExitCode: 0,
      diagnostics: [
        {
          project: 'chromium',
          outcome: 'expected',
          attempts: [{ retry: 0, status: 'passed', observation: conditional }],
        },
        {
          project: 'chromium',
          outcome: 'expected',
          attempts: [{ retry: 0, status: 'passed', observation: timing }],
        },
        { attachment: 'first-gif-traffic' },
        { attachment: 'first-webp-traffic' },
      ],
    });
    expect(preserveDeploymentDiagnostics(file, state, target, 0, output)).not.toBe(path);
  });

  it('binds first-conversion rows to emitted files and keeps phases, output and unknown traffic separate', () => {
    const { file, output } = fixture(report());
    const artifact = JSON.parse(
      readFileSync(preserveDeploymentDiagnostics(file, state, target, 0, output), 'utf8')
    );
    const gif = artifact.diagnostics[2].attempts[0].observation;
    expect(gif).toMatchObject({
      scenario: 'normal-gif',
      coverage: 'page-resource-timing-only-worker-internal-traffic-unknown',
      outputBytes: 1024,
      runtimeMemoryBytes: null,
      totals: {
        initial: {
          observedEntries: 1,
          knownPositiveTransferBytes: 12345,
          unknownOrCachedEntries: 0,
        },
        firstConversion: {
          observedEntries: 1,
          knownPositiveTransferBytes: 0,
          unknownOrCachedEntries: 1,
        },
      },
    });
    expect(gif.resources[0]).toMatchObject({
      emittedRawBytes: 1,
      emittedSha256: 'e'.repeat(64),
      phase: 'initial',
    });
    expect(gif.resources[1]).toMatchObject({ transferSize: 0, phase: 'firstConversion' });
    expect(artifact.diagnostics[3].attempts[0].observation.scenario).toBe('forced-webp-wasm');
  });

  it.each([
    { ...traffic(), target: 'https://example.test/' },
    { ...traffic(), coverage: 'complete-worker-traffic' },
    { ...traffic(), scenario: 'forced-webp-wasm' },
    { ...traffic(), resources: [] },
    { ...traffic(), outputBytes: 0 },
    { ...traffic(), resources: [{ ...traffic().resources[0], path: '/unbound.js' }] },
    { ...traffic(), resources: [{ ...traffic().resources[0], decodedBodySize: -1 }] },
  ])('rejects malformed, misidentified or unbound first-conversion observations', (invalid) => {
    const { file, output } = fixture(report({ traffic: invalid }));
    expect(() => preserveDeploymentDiagnostics(file, state, target, 0, output)).toThrow(
      /first-conversion/
    );
  });

  it('requires each successful first-conversion attachment', () => {
    for (const name of ['first-gif-traffic', 'first-webp-traffic']) {
      const { file, output } = fixture(report({ missing: name }));
      expect(() => preserveDeploymentDiagnostics(file, state, target, 0, output)).toThrow(
        `no unique ${name}`
      );
    }
  });

  it('rejects a passing test with missing evidence or an observation from another target', () => {
    const missing = fixture(report({ missing: 'conditional-header-observations' }));
    expect(() =>
      preserveDeploymentDiagnostics(missing.file, state, target, 0, missing.output)
    ).toThrow('no unique conditional-header-observations');
    const stale = fixture(report({ target: 'https://example.test/' }));
    expect(() => preserveDeploymentDiagnostics(stale.file, state, target, 0, stale.output)).toThrow(
      'Invalid JS transfer timing'
    );
  });

  it('retains a successful retry separately from an earlier failed attempt', () => {
    const value = report();
    const test = value.suites[2]!.specs[0]!.tests[0]!;
    test.status = 'flaky';
    test.results[0]!.retry = 1;
    test.results.unshift({ retry: 0, status: 'failed', attachments: [] });
    const { file, output } = fixture(value);
    const path = preserveDeploymentDiagnostics(file, state, target, 0, output);
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    expect(artifact.diagnostics[2].attempts).toEqual([
      { retry: 0, status: 'failed' },
      {
        retry: 1,
        status: 'passed',
        observation: expect.objectContaining({ scenario: 'normal-gif' }),
      },
    ]);
  });

  it('records skipped diagnostics without inventing a measurement and rejects an incomplete green run', () => {
    const skipped = fixture(report({ status: 'skipped' }));
    const path = preserveDeploymentDiagnostics(skipped.file, state, target, 1, skipped.output);
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    expect(artifact.diagnostics[0].attempts[0]).toEqual({ retry: 0, status: 'skipped' });
    expect(() =>
      preserveDeploymentDiagnostics(skipped.file, state, target, 0, skipped.output)
    ).toThrow('did not pass');
  });
});
