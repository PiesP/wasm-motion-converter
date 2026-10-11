/** Verify a source-built Pages deployment against the exact CI build artifact. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DeploymentState } from '../build/deployment-state.ts';
import { isCliEntry } from '../check/run-child.ts';
import { runPlaywright } from './run-playwright.ts';

const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const MAX_METADATA_BYTES = 128_000;
const MAX_ASSET_BYTES = 15_000_000;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid deployment metadata object');
  return value as Record<string, unknown>;
}

export function parseDeploymentState(value: unknown): DeploymentState {
  const state = record(value);
  if (
    state.schemaVersion !== 1 ||
    state.sourceDirty !== false ||
    !['sourceSha', 'treeSha', 'coreSha'].every(
      (key) => typeof state[key] === 'string' && sha.test(state[key])
    ) ||
    typeof state.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(state.version) ||
    typeof state.branch !== 'string' ||
    !state.branch ||
    state.branch.length > 128 ||
    typeof state.headersSha256 !== 'string' ||
    !digest.test(state.headersSha256) ||
    !Array.isArray(state.files) ||
    state.files.length === 0 ||
    state.files.length > 100
  ) {
    throw new Error('Invalid deployment metadata schema or dirty source');
  }
  const paths = new Set<string>();
  let total = 0;
  for (const entry of state.files) {
    const file = record(entry);
    if (
      typeof file.path !== 'string' ||
      !/^[\w.-]+(?:\/[\w.-]+)*$/.test(file.path) ||
      file.path.split('/').some((part) => part === '.' || part === '..') ||
      file.path.startsWith('_') ||
      file.path === 'deployment-state.json' ||
      paths.has(file.path) ||
      typeof file.size !== 'number' ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      file.size > MAX_ASSET_BYTES ||
      typeof file.sha256 !== 'string' ||
      !digest.test(file.sha256)
    )
      throw new Error('Invalid deployment file inventory');
    paths.add(file.path);
    total += file.size;
  }
  if (total > 30_000_000) throw new Error('Deployment inventory byte limit exceeded');
  return state as unknown as DeploymentState;
}

export function deploymentUrl(value: string): URL {
  const url = new URL(value);
  const local = url.protocol === 'http:' && url.hostname === '127.0.0.1';
  const pages =
    url.protocol === 'https:' &&
    /^(?:[a-f0-9]{8}\.)?wasm-motion-converter\.pages\.dev$/.test(url.hostname);
  if (
    (!local && !pages) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Unexpected deployment target');
  return url;
}

type Fetch = typeof globalThis.fetch;
async function bytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) throw new Error('Response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Response byte limit exceeded');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function readDeploymentState(
  target: URL,
  fetcher: Fetch = fetch
): Promise<DeploymentState> {
  const response = await fetcher(new URL('/deployment-state.json', target), {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (
    response.status !== 200 ||
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  )
    throw new Error('Deployment metadata is not successful JSON');
  return parseDeploymentState(
    JSON.parse(new TextDecoder().decode(await bytes(response, MAX_METADATA_BYTES)))
  );
}

export async function verifyDeploymentBytes(
  target: URL,
  expected: DeploymentState,
  fetcher: Fetch = fetch
): Promise<unknown> {
  const actual = await readDeploymentState(target, fetcher);
  for (const key of ['sourceSha', 'treeSha', 'coreSha', 'version', 'headersSha256'] as const) {
    if (actual[key] !== expected[key])
      throw new Error(`Deployment ${key} differs from build artifact`);
  }
  if (JSON.stringify(actual.files) !== JSON.stringify(expected.files))
    throw new Error('Deployment inventory differs from build artifact');
  const files = [];
  for (const file of expected.files) {
    const url = new URL(file.path === 'index.html' ? '/' : `/${file.path}`, target);
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (response.status !== 200) throw new Error(`${file.path} returned ${response.status}`);
    const body = await bytes(response, MAX_ASSET_BYTES);
    const observed = createHash('sha256').update(body).digest('hex');
    if (body.length !== file.size || observed !== file.sha256)
      throw new Error(`Served bytes differ: ${file.path}`);
    files.push({
      ...file,
      contentType: response.headers.get('content-type'),
      contentEncoding: response.headers.get('content-encoding'),
      etag: response.headers.get('etag'),
    });
  }
  return {
    target: target.href,
    sourceSha: actual.sourceSha,
    treeSha: actual.treeSha,
    observedAt: new Date().toISOString(),
    files,
  };
}

function currentMaster(): string {
  return (
    execFileSync('git', ['ls-remote', 'origin', 'refs/heads/master'], {
      encoding: 'utf8',
      timeout: 30_000,
    }).split(/\s/)[0] ?? ''
  );
}

export async function verifyPublication(): Promise<void> {
  const expected = parseDeploymentState(
    JSON.parse(
      readFileSync(resolve(process.env.DEPLOY_DIST || 'dist', 'deployment-state.json'), 'utf8')
    )
  );
  const expectedSha =
    process.env.EXPECTED_SOURCE_SHA ||
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!sha.test(expectedSha) || expected.sourceSha !== expectedSha)
    throw new Error('Expected source does not match local build artifact');
  const target = deploymentUrl(
    process.env.DEPLOY_URL || 'https://wasm-motion-converter.pages.dev/'
  );
  const attempts = process.env.VERIFY_CURRENT_MASTER === '1' ? 8 : 1;
  let matched = false;
  let lastObservation = 'expected source not observed';
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (process.env.VERIFY_CURRENT_MASTER === '1' && currentMaster() !== expectedSha) {
      const message = `Public verification incomplete: source ${expectedSha} was superseded on master.\n`;
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message);
      throw new Error(message.trim());
    }
    try {
      const actual = await readDeploymentState(target);
      if (actual.sourceSha === expectedSha) {
        matched = true;
        break;
      }
      lastObservation = `served source is ${actual.sourceSha}`;
    } catch (error) {
      lastObservation = String(error);
    }
    if (attempt + 1 < attempts) await new Promise((done) => setTimeout(done, 60_000));
  }
  if (!matched)
    throw new Error(
      `Expected Pages source unavailable (${lastObservation}); inspect provider pending, failed or skipped deployment before retrying`
    );
  const evidence = await verifyDeploymentBytes(target, expected);
  writeFileSync('deployment-verification.json', `${JSON.stringify(evidence, null, 2)}\n`);
  // The deploy profile never enables a local web server. Keeping SKIP_WEB_SERVER
  // unset ensures its production-only dogfood assertions execute.
  delete process.env.SKIP_WEB_SERVER;
  process.env.DEPLOY_URL = target.href;
  const result = await runPlaywright('deploy', ['--reporter=list']);
  if (result !== 0) throw new Error(`Public deployment browser checks failed (${result})`);
  if (process.env.VERIFY_CURRENT_MASTER === '1' && currentMaster() !== expectedSha)
    throw new Error(
      'Source was superseded during public verification; this result does not accept current production'
    );
  if ((await readDeploymentState(target)).sourceSha !== expectedSha)
    throw new Error('Public deployment changed during verification');
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Verified public source ${expectedSha}: runtime bytes and the complete deploy profile passed.\n`
    );
}

if (isCliEntry(import.meta.url))
  verifyPublication().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
