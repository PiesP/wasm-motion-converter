import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeploymentState } from '../../../scripts/build/deployment-state';
import { preserveDeploymentDiagnostics } from '../../../scripts/test/deployment-diagnostics';

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
const conditional = [{ path: asset, etag: '"abc"', conditionalEtag: null,
  rfc9110Etag: false, compatibilityException: 'pages-304-etag-omission',
  status: 304, unmatchedStatus: 200 }];
const timing = { target: target.href, measuredAt: '2026-10-12T00:00:00.000Z',
  browserProject: 'chromium', totalTransferSize: 12345,
  resources: [{ name: new URL(`/${asset}`, target).href, transferSize: 12345 }] };

function report(options: { missing?: string; target?: string; status?: string } = {}) {
  function suite(file: string, title: string, name: string, value: unknown) {
    return { file, specs: [{ file, title, tests: [{ projectName: 'chromium',
      status: options.status === 'skipped' ? 'skipped' : 'expected',
      results: [{ retry: 0, status: options.status ?? 'passed', attachments: options.missing === name
        ? [] : [{ name, contentType: 'application/json', body: Buffer.from(JSON.stringify(value)).toString('base64') }] }],
    }] }], suites: [] };
  }
  return { stats: { startTime: '2026-10-12T00:00:00.000Z', expected: 2, skipped: 0,
    unexpected: 0, flaky: 0 }, suites: [
    suite('e2e/deploy-smoke.spec.ts',
      'Pages serves one security and cache policy per document, metadata, and fingerprinted asset',
      'conditional-header-observations', conditional),
    suite('e2e/dogfood-qa.spec.ts', 'total JS transfer size under 150KB',
      'js-transfer-timing', { ...timing, target: options.target ?? timing.target }),
  ] };
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
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('deployment diagnostic artifact', () => {
  it('retains successful conditional and timing data with source, target, outcome and retry identity', () => {
    const { file, output } = fixture(report());
    const path = preserveDeploymentDiagnostics(file, state, target, 0, output);
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    expect(path).toContain(`${state.sourceSha.slice(0, 12)}-`);
    expect(artifact).toMatchObject({ sourceSha: state.sourceSha, treeSha: state.treeSha,
      target: target.href, playwrightExitCode: 0,
      diagnostics: [
        { project: 'chromium', outcome: 'expected', attempts: [{ retry: 0, status: 'passed', observation: conditional }] },
        { project: 'chromium', outcome: 'expected', attempts: [{ retry: 0, status: 'passed', observation: timing }] },
      ] });
    expect(preserveDeploymentDiagnostics(file, state, target, 0, output)).not.toBe(path);
  });

  it('rejects a passing test with missing evidence or an observation from another target', () => {
    const missing = fixture(report({ missing: 'conditional-header-observations' }));
    expect(() => preserveDeploymentDiagnostics(missing.file, state, target, 0, missing.output))
      .toThrow('no unique conditional-header-observations');
    const stale = fixture(report({ target: 'https://example.test/' }));
    expect(() => preserveDeploymentDiagnostics(stale.file, state, target, 0, stale.output))
      .toThrow('Invalid JS transfer timing');
  });

  it('retains a successful retry separately from an earlier failed attempt', () => {
    const value = report();
    const test = value.suites[0]!.specs[0]!.tests[0]!;
    test.status = 'flaky';
    test.results[0]!.retry = 1;
    test.results.unshift({ retry: 0, status: 'failed', attachments: [] });
    const { file, output } = fixture(value);
    const path = preserveDeploymentDiagnostics(file, state, target, 0, output);
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    expect(artifact.diagnostics[0].attempts).toEqual([
      { retry: 0, status: 'failed' },
      { retry: 1, status: 'passed', observation: conditional },
    ]);
  });

  it('records skipped diagnostics without inventing a measurement and rejects an incomplete green run', () => {
    const skipped = fixture(report({ status: 'skipped' }));
    const path = preserveDeploymentDiagnostics(skipped.file, state, target, 1, skipped.output);
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    expect(artifact.diagnostics[0].attempts[0]).toEqual({ retry: 0, status: 'skipped' });
    expect(() => preserveDeploymentDiagnostics(skipped.file, state, target, 0, skipped.output))
      .toThrow('did not pass');
  });
});
