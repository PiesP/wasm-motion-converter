/** Verify a source-built Pages deployment against the exact CI build artifact. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { BUILD_DATE_PATH, parseBuildDate } from '../../src/utils/build-date.ts';
import type { DeploymentState } from '../build/deployment-state.ts';
import { runChild } from '../check/run-child.ts';
import { preserveDeploymentDiagnostics } from './deployment-diagnostics.ts';
import { pagesFileUrl } from './pages-file-url.ts';
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
    (state.buildDatePath !== undefined && state.buildDatePath !== BUILD_DATE_PATH) ||
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
      file.path === BUILD_DATE_PATH ||
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

async function readJsonBytes(target: URL, path: string, limit: number, fetcher: Fetch) {
  const response = await fetcher(new URL(path, target), {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (
    response.status !== 200 ||
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  )
    throw new Error('Deployment metadata is not successful JSON');
  return bytes(response, limit);
}

async function readMetadata(target: URL, fetcher: Fetch) {
  const metadata = await readJsonBytes(
    target,
    '/deployment-state.json',
    MAX_METADATA_BYTES,
    fetcher
  );
  return {
    state: parseDeploymentState(JSON.parse(new TextDecoder().decode(metadata))),
    sha256: createHash('sha256').update(metadata).digest('hex'),
  };
}

function verifiedBuildDate(body: Uint8Array, sourceSha: string): string {
  const date = parseBuildDate(JSON.parse(new TextDecoder().decode(body)), sourceSha);
  if (!date) throw new Error('Invalid build date for deployment source');
  return date;
}

export async function readDeploymentState(
  target: URL,
  fetcher: Fetch = fetch
): Promise<DeploymentState> {
  return (await readMetadata(target, fetcher)).state;
}

export async function verifyDeploymentBytes(
  target: URL,
  expected: DeploymentState,
  fetcher: Fetch = fetch,
  expectedManifestSha256?: string
): Promise<unknown> {
  const metadata = await readMetadata(target, fetcher);
  const { state: actual } = metadata;
  if (expectedManifestSha256 !== undefined && metadata.sha256 !== expectedManifestSha256)
    throw new Error('Served deployment metadata bytes differ from build artifact');
  for (const key of [
    'sourceSha',
    'treeSha',
    'coreSha',
    'version',
    'headersSha256',
    'buildDatePath',
  ] as const) {
    if (actual[key] !== expected[key])
      throw new Error(`Deployment ${key} differs from build artifact`);
  }
  if (JSON.stringify(actual.files) !== JSON.stringify(expected.files))
    throw new Error('Deployment inventory differs from build artifact');
  const files = [];
  for (const file of expected.files) {
    const url = pagesFileUrl(target, file.path);
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
  // Pages and CI build independently. Validate each build's own UTC date.
  const buildDate = actual.buildDatePath
    ? verifiedBuildDate(
        await readJsonBytes(target, BUILD_DATE_PATH, 256, fetcher),
        actual.sourceSha
      )
    : undefined;
  return {
    ...(buildDate && { buildDate }),
    target: target.href,
    sourceSha: actual.sourceSha,
    treeSha: actual.treeSha,
    coreSha: actual.coreSha,
    manifestSha256: metadata.sha256,
    observedAt: new Date().toISOString(),
    files,
  };
}

function verifyLocalArtifact(directory: string, expected: DeploymentState): void {
  const root = resolve(directory);
  if (!lstatSync(root).isDirectory()) throw new Error('Deployment artifact is not a directory');
  const inventory = new Map(expected.files.map((file) => [file.path, file]));
  const remaining = new Set([...inventory.keys(), '_headers', 'deployment-state.json']);
  if (expected.buildDatePath) remaining.add(BUILD_DATE_PATH);
  const pending = [''];
  let visited = 0;
  for (const prefix of pending) {
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
      if (++visited > 128) throw new Error('Deployment artifact has too many entries');
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || !remaining.delete(path))
        throw new Error(`Unaccounted deployment artifact file: ${path}`);
      if (path === BUILD_DATE_PATH) {
        const datePath = join(root, path);
        if (lstatSync(datePath).size > 256)
          throw new Error('Build date metadata exceeds byte limit');
        verifiedBuildDate(readFileSync(datePath), expected.sourceSha);
        continue;
      }
      const file = inventory.get(path);
      if (!file) continue;
      const localPath = join(root, path);
      if (
        lstatSync(localPath).size !== file.size ||
        createHash('sha256').update(readFileSync(localPath)).digest('hex') !== file.sha256
      )
        throw new Error(`Local deployment artifact bytes differ: ${path}`);
    }
  }
  if (remaining.size) throw new Error(`Missing deployment artifact file: ${[...remaining][0]}`);
  const headers = readFileSync(join(root, '_headers'));
  if (createHash('sha256').update(headers).digest('hex') !== expected.headersSha256)
    throw new Error('Expected CSP artifact differs from deployment metadata');
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
  const artifactDirectory = process.env.DEPLOY_DIST || 'dist';
  const artifact = readFileSync(resolve(artifactDirectory, 'deployment-state.json'));
  const expected = parseDeploymentState(JSON.parse(artifact.toString('utf8')));
  const requireOwnedVp8Only = process.env.DEPLOY_REQUIRE_OWNED_VP8_ONLY === '1';
  if (requireOwnedVp8Only && (!process.env.EXPECTED_SOURCE_SHA || !process.env.DEPLOY_DIST))
    throw new Error(
      'Owned-only verification requires explicit EXPECTED_SOURCE_SHA and DEPLOY_DIST'
    );
  const expectedSha =
    process.env.EXPECTED_SOURCE_SHA ||
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!sha.test(expectedSha) || expected.sourceSha !== expectedSha)
    throw new Error('Expected source does not match local build artifact');
  const target = deploymentUrl(
    process.env.DEPLOY_URL || 'https://wasm-motion-converter.pages.dev/'
  );
  if (
    requireOwnedVp8Only &&
    target.protocol === 'https:' &&
    (target.href !== 'https://wasm-motion-converter.pages.dev/' ||
      process.env.VERIFY_CURRENT_MASTER !== '1')
  )
    throw new Error(
      'Public owned-only verification requires the canonical Pages URL and VERIFY_CURRENT_MASTER=1'
    );
  const diagnosticMode = requireOwnedVp8Only
    ? {
        requireOwnedVp8Only,
        expectedManifestSha256: createHash('sha256').update(artifact).digest('hex'),
      }
    : {};
  if (requireOwnedVp8Only) verifyLocalArtifact(artifactDirectory, expected);
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
  const evidence = await verifyDeploymentBytes(
    target,
    expected,
    fetch,
    diagnosticMode.expectedManifestSha256
  );
  writeFileSync('deployment-verification.json', `${JSON.stringify(evidence, null, 2)}\n`);
  // The deploy profile never enables a local web server. Keeping SKIP_WEB_SERVER
  // unset ensures its production-only dogfood assertions execute.
  delete process.env.SKIP_WEB_SERVER;
  process.env.DEPLOY_URL = target.href;
  const reportDirectory = mkdtempSync(join(tmpdir(), 'wmc-deployment-playwright-'));
  try {
    const reportFile = join(reportDirectory, 'results.json');
    const args = requireOwnedVp8Only
      ? ['--reporter=list,json', '--retries=0', '--forbid-only']
      : ['--reporter=list,json'];
    const result = await runPlaywright('deploy', args, runChild, {
      PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
    });
    if (result !== 0) {
      // Keep the browser failure primary if setup failed before a report existed.
      try {
        preserveDeploymentDiagnostics(
          reportFile,
          expected,
          target,
          result,
          undefined,
          diagnosticMode
        );
      } catch {
        console.warn('Deployment diagnostic inventory unavailable after browser failure');
      }
      throw new Error(`Public deployment browser checks failed (${result})`);
    }
    preserveDeploymentDiagnostics(reportFile, expected, target, result, undefined, diagnosticMode);
  } finally {
    try {
      rmSync(reportDirectory, { recursive: true, force: true });
    } catch {
      console.warn('Temporary Playwright report could not be removed');
    }
  }
  if (process.env.VERIFY_CURRENT_MASTER === '1' && currentMaster() !== expectedSha)
    throw new Error(
      'Source was superseded during public verification; this result does not accept current production'
    );
  const finalMetadata = await readMetadata(target, fetch);
  if (
    finalMetadata.state.sourceSha !== expectedSha ||
    (requireOwnedVp8Only && finalMetadata.sha256 !== diagnosticMode.expectedManifestSha256)
  )
    throw new Error('Public deployment changed during verification');
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Verified public source ${expectedSha}: runtime bytes and the complete deploy profile passed.\n`
    );
}

if (import.meta.main)
  verifyPublication().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
