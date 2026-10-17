/** Keep successful Playwright deployment observations in the uploaded test-results artifact. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DeploymentState } from '../build/deployment-state.ts';

const MAX_REPORT_BYTES = 2_000_000;
const MAX_DIAGNOSTIC_BYTES = 128_000;
const PRODUCERS = [
  {
    file: 'e2e/deploy-smoke.spec.ts',
    title:
      'Pages serves one security and cache policy per document, metadata, and fingerprinted asset',
    name: 'conditional-header-observations',
  },
  {
    file: 'e2e/dogfood-qa.spec.ts',
    title: 'total JS transfer size under 150KB',
    name: 'js-transfer-timing',
  },
] as const;

type JsonRecord = Record<string, unknown>;

function readBoundedReport(reportFile: string): string {
  const descriptor = openSync(reportFile, 'r');
  try {
    const bytes = Buffer.alloc(MAX_REPORT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_REPORT_BYTES)
      throw new Error('Deployment Playwright report exceeds byte limit');
    return bytes.toString('utf8', 0, length);
  } finally {
    closeSync(descriptor);
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid deployment diagnostic ${label}`);
  return value as JsonRecord;
}

function entries(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid deployment diagnostic ${label}`);
  return value;
}

function observedTests(report: JsonRecord): JsonRecord[] {
  const tests: JsonRecord[] = [];
  function visit(suite: unknown): void {
    const value = record(suite, 'suite');
    for (const spec of entries(value.specs, 'specs')) tests.push(record(spec, 'spec'));
    for (const child of entries(value.suites ?? [], 'suites')) visit(child);
  }
  for (const suite of entries(report.suites, 'suites')) visit(suite);
  return tests;
}

function diagnosticBody(result: JsonRecord, name: string): unknown {
  const matches = entries(result.attachments, 'attachments')
    .map((attachment) => record(attachment, 'attachment'))
    .filter((attachment) => attachment.name === name);
  if (
    matches.length !== 1 ||
    matches[0]?.contentType !== 'application/json' ||
    typeof matches[0]?.body !== 'string' ||
    matches[0].body.length > MAX_DIAGNOSTIC_BYTES * 2
  )
    throw new Error(`Successful deployment test has no unique ${name} JSON attachment`);
  const bytes = Buffer.from(matches[0].body, 'base64');
  if (bytes.length > MAX_DIAGNOSTIC_BYTES) throw new Error(`${name} exceeds diagnostic byte limit`);
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

function validateConditional(value: unknown, expected: DeploymentState, target: URL): void {
  const observations = entries(value, 'conditional observations');
  const paths = expected.files
    .map((file) => file.path)
    .filter((path) => /^assets\/[\w.-]+[.-][\w-]{8}\.(js|css|wasm)$/.test(path));
  const seen = new Set<string>();
  for (const item of observations) {
    const row = record(item, 'conditional row');
    if (
      typeof row.path !== 'string' ||
      seen.has(row.path) ||
      !paths.includes(row.path) ||
      typeof row.etag !== 'string' ||
      !/^(?:W\/)?"[^"]+"$/.test(row.etag) ||
      row.status !== 304 ||
      row.unmatchedStatus !== 200 ||
      typeof row.rfc9110Etag !== 'boolean' ||
      (row.rfc9110Etag
        ? row.conditionalEtag !== row.etag || row.compatibilityException !== null
        : row.conditionalEtag !== null ||
          row.compatibilityException !==
            (target.protocol === 'https:'
              ? 'pages-304-etag-omission'
              : 'wrangler-304-etag-omission'))
    )
      throw new Error('Invalid conditional-header observation');
    seen.add(row.path);
  }
  if (paths.length === 0 || observations.length !== paths.length)
    throw new Error('Incomplete conditional-header observations');
}

function validateTiming(value: unknown, target: URL): void {
  const timing = record(value, 'JS timing');
  if (
    typeof timing.target !== 'string' ||
    timing.target !== target.href ||
    typeof timing.measuredAt !== 'string' ||
    Number.isNaN(Date.parse(timing.measuredAt)) ||
    timing.browserProject !== 'chromium' ||
    typeof timing.totalTransferSize !== 'number' ||
    timing.totalTransferSize <= 0 ||
    timing.totalTransferSize >= 150_000 ||
    entries(timing.resources, 'JS timing resources').length === 0
  )
    throw new Error('Invalid JS transfer timing observation');
}

/** Extract only bounded public observations; the caller owns Playwright's exit status. */
export function preserveDeploymentDiagnostics(
  reportFile: string,
  expected: DeploymentState,
  target: URL,
  playwrightExitCode: number,
  outputDirectory = 'test-results'
): string {
  const report = record(JSON.parse(readBoundedReport(reportFile)), 'report');
  const specs = observedTests(report);
  const runId = randomUUID();
  const diagnostics = PRODUCERS.map((producer) => {
    const matches = specs.filter(
      (spec) => spec.file === producer.file && spec.title === producer.title
    );
    if (matches.length !== 1)
      throw new Error(`Deployment diagnostic test absent or duplicated: ${producer.title}`);
    const tests = entries(matches[0]?.tests, 'tests');
    if (tests.length !== 1)
      throw new Error(`Deployment diagnostic project count differs: ${producer.title}`);
    const test = record(tests[0], 'test');
    if (test.projectName !== 'chromium')
      throw new Error('Unexpected deployment diagnostic browser');
    const attempts = entries(test.results, 'results').map((item) => {
      const result = record(item, 'result');
      if (
        typeof result.retry !== 'number' ||
        !Number.isSafeInteger(result.retry) ||
        typeof result.status !== 'string'
      )
        throw new Error('Invalid deployment test result');
      const attempt: { retry: number; status: string; observation?: unknown } = {
        retry: result.retry,
        status: result.status,
      };
      if (result.status === 'passed') {
        attempt.observation = diagnosticBody(result, producer.name);
        if (producer.name === 'conditional-header-observations')
          validateConditional(attempt.observation, expected, target);
        else validateTiming(attempt.observation, target);
      }
      return attempt;
    });
    if (
      playwrightExitCode === 0 &&
      (!['expected', 'flaky'].includes(String(test.status)) || attempts.at(-1)?.status !== 'passed')
    )
      throw new Error(`Deployment diagnostic test did not pass: ${producer.title}`);
    return {
      file: producer.file,
      title: producer.title,
      project: test.projectName,
      outcome: test.status,
      attachment: producer.name,
      attempts,
    };
  });
  const stats = record(report.stats, 'stats');
  const targetHash = createHash('sha256').update(target.href).digest('hex').slice(0, 12);
  const filename = `deployment-diagnostics-${expected.sourceSha.slice(0, 12)}-${targetHash}-${runId}.json`;
  mkdirSync(outputDirectory, { recursive: true });
  const path = join(outputDirectory, filename);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId,
        ciRunId: process.env.GITHUB_RUN_ID ?? null,
        ciRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        sourceSha: expected.sourceSha,
        treeSha: expected.treeSha,
        coreSha: expected.coreSha,
        headersSha256: expected.headersSha256,
        target: target.href,
        browser: 'chromium',
        startedAt: stats.startTime,
        playwrightExitCode,
        counts: {
          expected: stats.expected,
          skipped: stats.skipped,
          unexpected: stats.unexpected,
          flaky: stats.flaky,
        },
        diagnostics,
      },
      null,
      2
    )}\n`
  );
  return path;
}
