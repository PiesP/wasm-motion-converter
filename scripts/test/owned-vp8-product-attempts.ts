/** Join retained Windows controller attempts to the existing V8 timing arithmetic. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { type Distribution, readDistribution, verifyTiming } from './owned-vp8-product-timing.ts';

const SHA = /^[a-f0-9]{64}$/i;
const SOURCE = /^[a-f0-9]{40}$/;
const GUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;
const SELECTOR = /^owned-vp8-product-v8-(low|medium|high)(-ba)?$/;
const JSON_LIMIT = 2 * 1024 * 1024;
const FILE_LIMIT = 64 * 1024 * 1024;
const TOTAL_LIMIT = 256 * 1024 * 1024;
type RecordJson = Record<string, unknown>;

function object(value: unknown, label: string): RecordJson {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} is not an object`
  );
  return value as RecordJson;
}
function list(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `${label} is not an array`);
  return value;
}
function hex(value: unknown, label: string): string {
  assert(typeof value === 'string' && SHA.test(value), `${label} is not a SHA-256 digest`);
  return value.toLowerCase();
}
function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function same(actual: unknown, expected: unknown, label: string): void {
  assert.deepEqual(actual, expected, `${label} differs`);
}
function stable(value: unknown): string {
  return JSON.stringify(value);
}
function safeName(value: unknown, label: string): string {
  assert(typeof value === 'string' && FILE.test(value), `${label} is unsafe`);
  return value;
}

/** Never follow a link in a caller-supplied attempt or in its admitted files. */
async function regular(path: string, label: string, limit: number): Promise<Buffer> {
  try {
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), `${label} is missing or linked`);
    assert(stat.size <= limit, `${label} exceeds byte limit`);
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code !== 'ERR_ASSERTION')
      throw new Error(`${label} is missing or unreadable`);
    throw error;
  }
}
async function directory(path: string, label: string): Promise<void> {
  try {
    const stat = await lstat(path);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), `${label} is missing or linked`);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code !== 'ERR_ASSERTION')
      throw new Error(`${label} is missing or unreadable`);
    throw error;
  }
}
async function json(
  path: string,
  label: string,
  limit = JSON_LIMIT
): Promise<{ value: unknown; sha256: string }> {
  const bytes = await regular(path, label, limit);
  return {
    value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) as unknown,
    sha256: hash(bytes),
  };
}
function entry(entries: readonly unknown[], name: string, label: string): RecordJson {
  const matches = entries.map((item) => object(item, label)).filter((item) => item.file === name);
  same(matches.length, 1, `${label} ${name} count`);
  return matches[0]!;
}
function payloadEntry(files: readonly unknown[], name: string): RecordJson {
  return entry(files, name, 'bundle file');
}

export type AttemptPins = {
  candidateSourceSha: string;
  candidateModuleSha256: string;
  priorDistribution: Distribution;
  candidateDistribution: Distribution;
};

export async function verifyAttempts(roots: readonly string[], pins: AttemptPins) {
  same(roots.length, 15, 'attempt root count');
  assert(SOURCE.test(pins.candidateSourceSha), 'candidate source pin is invalid');
  hex(pins.candidateModuleSha256, 'candidate module pin');
  const uniqueRoots = new Set<string>();
  const reports: unknown[] = [];
  const receiptHashes: string[] = [];
  const attempts: RecordJson[] = [];
  const common = new Map<string, string>();
  const missing = new Set<string>([
    'CPU model and core count',
    'neighbor load trace',
    'browser executable fingerprint',
  ]);
  for (const [attemptIndex, supplied] of roots.entries()) {
    const root = resolve(supplied);
    await directory(root, 'attempt root');
    const canonical = await realpath(root);
    same(canonical, root, 'attempt root symlink path');
    assert(!uniqueRoots.has(canonical), 'duplicate attempt root');
    uniqueRoots.add(canonical);
    await directory(join(root, 'output'), 'attempt output');
    await directory(join(root, 'payload'), 'attempt payload');
    const [bundleFile, transportFile, collectionFile, resultFile, environmentFile] =
      await Promise.all([
        json(join(root, 'bundle.json'), 'bundle'),
        json(join(root, 'transport.json'), 'transport'),
        json(join(root, 'collection.json'), 'collection'),
        json(join(root, 'output/result.json'), 'result'),
        json(join(root, 'output/environment.json'), 'environment'),
      ]);
    const bundle = object(bundleFile.value, 'bundle');
    const transport = object(transportFile.value, 'transport');
    const result = object(resultFile.value, 'result');
    const environment = object(environmentFile.value, 'environment');
    const collection = list(collectionFile.value, 'collection');
    same(bundle.schema_version, 1, 'bundle schema');
    same(bundle.project, 'wasm-motion-converter', 'bundle project');
    same(bundle.profile, 'wmc-media', 'bundle profile');
    assert(
      typeof bundle.scenario === 'string' && SELECTOR.test(bundle.scenario),
      'bundle scenario is not V8'
    );
    assert(
      bundle.browser === 'msedge' || bundle.browser === 'chrome',
      'unsupported browser channel'
    );
    same(bundle.mode, 'desktop', 'bundle mode');
    same(bundle.installation, null, 'bundle installation');
    same(bundle.source_sha, pins.candidateSourceSha, 'bundle candidate source');
    same(bundle.core_sha, pins.candidateDistribution.coreSha, 'bundle candidate core');
    same(
      transport,
      { collected: true, guest_cleanup: true, failed_guest_root: null },
      'transport completion'
    );
    const bundleFiles = list(bundle.files, 'bundle inventory');
    assert(
      bundleFiles.length > 0 && bundleFiles.length <= 4096,
      'bundle inventory count is invalid'
    );
    const bundleNames = new Set<string>();
    for (const raw of bundleFiles) {
      const name = object(raw, 'bundle file').file;
      assert(
        typeof name === 'string' && name.split('/').every((part) => FILE.test(part)),
        'bundle file path is unsafe'
      );
      assert(!bundleNames.has(name), 'duplicate bundle file path');
      bundleNames.add(name);
    }
    const selectorPath = `validation/windows/inputs/${bundle.scenario}.json`;
    const profile = payloadEntry(bundleFiles, 'validation/windows/profile.json');
    const selector = payloadEntry(bundleFiles, selectorPath);
    const guest = payloadEntry(bundleFiles, 'guest.mjs');
    for (const [name, record] of [
      ['validation/windows/profile.json', profile],
      [selectorPath, selector],
      ['guest.mjs', guest],
    ] as const) {
      const parts = name.split('/');
      let current = join(root, 'payload');
      for (const part of parts.slice(0, -1)) {
        current = join(current, part);
        await directory(current, 'payload component');
      }
      same(
        hash(await regular(join(current, parts.at(-1)!), `payload ${name}`, JSON_LIMIT)),
        hex(record.sha256, `payload ${name}`),
        `payload ${name} digest`
      );
    }
    for (const [prefix, distribution] of [
      ['validation/windows/prior-dist', pins.priorDistribution],
      ['dist', pins.candidateDistribution],
    ] as const) {
      const name = `${prefix}/${distribution.module.path}`;
      const record = payloadEntry(bundleFiles, name);
      same(
        hex(record.sha256, `bundle ${name}`),
        distribution.module.sha256,
        `bundle ${name} module`
      );
    }
    const selectorBytes = await regular(
      join(root, 'payload', selectorPath),
      'selector',
      JSON_LIMIT
    );
    same(
      JSON.parse(selectorBytes.toString('utf8')),
      { scenario: bundle.scenario },
      'selector content'
    );
    same(
      hash(await regular(join(root, 'run.ps1'), 'controller script', JSON_LIMIT)),
      hex(bundle.controller_sha256, 'controller identity'),
      'controller script digest'
    );
    hex(bundle.packager_sha256, 'packager identity');
    hex(bundle.build_log_sha256, 'build log identity');
    same(
      hash(await regular(join(root, 'build.log'), 'build log', FILE_LIMIT)),
      hex(bundle.build_log_sha256, 'build log identity'),
      'build log digest'
    );
    const collected = new Set<string>();
    const limit = bundle.browser === 'msedge' ? 128 : 64;
    assert(
      collection.length > 0 && collection.length <= limit,
      'collection file count exceeds controller limit'
    );
    let total = 0;
    for (const raw of collection) {
      const item = object(raw, 'collection entry');
      const name = safeName(item.file, 'collected file name');
      assert(!collected.has(name), 'duplicate collected file name');
      collected.add(name);
      const bytes = await regular(join(root, 'output', name), `collected ${name}`, FILE_LIMIT);
      total += bytes.length;
      assert(total <= TOTAL_LIMIT, 'collection exceeds controller aggregate limit');
      same(hash(bytes), hex(item.sha256, `collected ${name}`), `collected ${name} digest`);
    }
    const actualOutput = await readdir(join(root, 'output'));
    same(new Set(actualOutput), collected, 'output file inventory');
    same(
      hex(entry(collection, 'result.json', 'collection').sha256, 'result digest'),
      resultFile.sha256,
      'result collection digest'
    );
    same(
      hex(entry(collection, 'environment.json', 'collection').sha256, 'environment digest'),
      environmentFile.sha256,
      'environment collection digest'
    );
    same(result.bundle_sha256, bundleFile.sha256, 'result bundle digest');
    for (const field of [
      'schema_version',
      'source_sha',
      'core_sha',
      'project',
      'profile',
      'browser',
      'mode',
      'installation',
      'live_urls',
      'live_observation',
      'runtime',
    ])
      same(result[field], bundle[field], `result ${field}`);
    same(result.status, 'passed', 'product result');
    const observations = object(result.observations, 'product observations');
    same(observations.status, 'passed', 'product observations status');
    same(observations.profile, bundle.scenario, 'product observation scenario');
    same(observations.report, `${bundle.scenario}.json`, 'product observation report');
    same(observations.samples, 4, 'product observation sample count');
    const artifactEntries = list(result.artifacts, 'result artifacts');
    // stdout/stderr and the controller's final environment update are collected
    // after guest.mjs assembled its artifact list; all declared artifacts must
    // still agree with the final collected bytes.
    const artifactNames = new Set<string>();
    for (const raw of artifactEntries) {
      const artifact = object(raw, 'result artifact');
      const name = safeName(artifact.file, 'result artifact name');
      assert(name !== 'result.json', 'result contains itself as an artifact');
      assert(!artifactNames.has(name), 'duplicate result artifact name');
      artifactNames.add(name);
      const record = entry(collection, name, 'collection');
      same(
        hex(artifact.sha256, `artifact ${name}`),
        hex(record.sha256, `collected ${name}`),
        `artifact ${name} digest`
      );
      const size = (await lstat(join(root, 'output', name))).size;
      same(artifact.bytes, size, `artifact ${name} size`);
    }
    same(
      artifactNames,
      new Set(
        [...collected].filter((name) => !['result.json', 'stdout.txt', 'stderr.txt'].includes(name))
      ),
      'guest artifact inventory'
    );
    const name = `${bundle.scenario}.json`;
    entry(collection, name, 'collection');
    entry(artifactEntries, name, 'result artifact');
    const receiptFile = await json(join(root, 'output', name), 'timing receipt', FILE_LIMIT);
    const report = object(receiptFile.value, 'timing receipt');
    same(report.scenario, bundle.scenario, 'timing scenario');
    same(report.browserVersion, result.browser_version, 'browser version');
    const before = object(environment.before, 'environment before');
    const after = object(environment.after, 'environment after');
    same(environment.readiness, 'passed', 'environment readiness');
    same(environment.drift, 'passed', 'environment drift');
    assert(typeof before.vm_id === 'string' && GUID.test(before.vm_id), 'VM GUID is absent');
    same(after.vm_id, before.vm_id, 'before/after VM GUID');
    same(environment.browser_version, result.browser_version, 'environment browser version');
    for (const field of [
      'vm_id',
      'os',
      'build',
      'full_build',
      'boot_utc',
      'total_memory_mib',
      'gpu',
      'desktop_dpi',
      'display_width',
      'display_height',
      'text_scale',
      'native_high_contrast',
    ]) {
      assert(
        before[field] !== undefined && after[field] !== undefined,
        `${field} environment field is absent`
      );
      same(after[field], before[field], `before/after ${field}`);
      const value = stable(before[field]);
      if (common.has(field)) same(value, common.get(field), `cross-attempt ${field}`);
      else common.set(field, value);
    }
    for (const [field, value] of [
      ['browser', bundle.browser],
      ['mode', bundle.mode],
      ['source', bundle.source_sha],
      ['core', bundle.core_sha],
      ['profile', hex(profile.sha256, 'profile digest')],
      ['guest', hex(guest.sha256, 'guest digest')],
      ['controller', hex(bundle.controller_sha256, 'controller digest')],
      ['packager', hex(bundle.packager_sha256, 'packager digest')],
      ['browserVersion', result.browser_version],
    ] as Array<[string, unknown]>) {
      const serialized = stable(value);
      if (common.has(field)) same(serialized, common.get(field), `cross-attempt ${field}`);
      else common.set(field, serialized);
    }
    reports.push(report);
    receiptHashes.push(receiptFile.sha256);
    attempts.push({
      attemptIndex: attemptIndex + 1,
      scenario: bundle.scenario,
      hashes: {
        bundle: bundleFile.sha256,
        transport: transportFile.sha256,
        collection: collectionFile.sha256,
        result: resultFile.sha256,
        environment: environmentFile.sha256,
        timingReceipt: receiptFile.sha256,
      },
      collectedFiles: collection.map((raw) => {
        const item = object(raw, 'collection entry');
        const file = safeName(item.file, 'collected file name');
        return {
          role:
            file === name ||
            ['result.json', 'environment.json', 'stdout.txt', 'stderr.txt'].includes(file)
              ? file
              : 'other',
          fileNameSha256: hash(Buffer.from(file)),
          sha256: hex(item.sha256, 'collected digest'),
        };
      }),
      selectorSha256: hex(selector.sha256, 'selector digest'),
      buildLogSha256: hex(bundle.build_log_sha256, 'build log digest'),
      browserVersion: result.browser_version,
      vmGuid: before.vm_id,
      readiness: environment.readiness,
      drift: environment.drift,
      functionalCorroboration:
        'Candidate ABI begin calls are in a separate conversion after timed samples; forced Canvas unavailable and same build support route correlation, not a per-timed-job execution proof.',
    });
  }
  const numeric = verifyTiming(reports, pins, receiptHashes);
  return {
    ...numeric,
    qualification: 'NOT_VERIFIED',
    qualificationReason:
      'The validated attempt chain binds maintained controller and product receipts. Separate candidate ABI execution corroborates the forced software route, but timed jobs lack direct execution proof; production copied bytes, relevant retained capacity, CPU/neighbor load and executable fingerprint remain unverified. Numeric PASS alone does not qualify the program.',
    evidenceScope:
      'maintained Windows controller attempt metadata and byte hashes; Chromium engine follows the Playwright channel launcher route, not an independent executable fingerprint',
    controller: {
      channel: JSON.parse(common.get('browser')!) as string,
      engine: 'Chromium (launcher-route inference)',
      mode: JSON.parse(common.get('mode')!) as string,
      vmGuid: JSON.parse(common.get('vm_id')!) as string,
      sourceSha: pins.candidateSourceSha,
      coreSha: pins.candidateDistribution.coreSha,
      profileSha256: JSON.parse(common.get('profile')!) as string,
      guestSha256: JSON.parse(common.get('guest')!) as string,
      controllerSha256: JSON.parse(common.get('controller')!) as string,
      packagerSha256: JSON.parse(common.get('packager')!) as string,
      observedEnvironment: Object.fromEntries(
        [
          'os',
          'build',
          'full_build',
          'boot_utc',
          'total_memory_mib',
          'gpu',
          'desktop_dpi',
          'display_width',
          'display_height',
          'text_scale',
          'native_high_contrast',
        ].map((key) => [key, JSON.parse(common.get(key)!)])
      ),
      missingObservations: [...missing],
    },
    attempts,
  };
}

async function main(args: readonly string[]) {
  const options = new Map<string, string[]>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new Error('Expected flag/value arguments');
    assert(
      [
        '--attempt',
        '--prior-dist',
        '--candidate-dist',
        '--candidate-source-sha',
        '--candidate-module-sha256',
      ].includes(key),
      'Unknown option'
    );
    options.set(key, [...(options.get(key) ?? []), value]);
  }
  const one = (key: string) => {
    const values = options.get(key);
    same(values?.length, 1, `${key} count`);
    return values![0]!;
  };
  return verifyAttempts(options.get('--attempt') ?? [], {
    candidateSourceSha: one('--candidate-source-sha'),
    candidateModuleSha256: one('--candidate-module-sha256'),
    priorDistribution: await readDistribution(one('--prior-dist'), 'prior'),
    candidateDistribution: await readDistribution(one('--candidate-dist'), 'candidate'),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.status !== 'PASS') process.exitCode = result.status === 'FAIL' ? 1 : 2;
    },
    (error: unknown) => {
      const reason =
        error instanceof Error
          ? error.message.split('\n')[0]!.replace(/(?:[A-Za-z]:\\|\/)[^\s'"]+/g, '[path]')
          : 'Unrecognized verification failure';
      process.stdout.write(
        `${JSON.stringify({ status: 'NOT_VERIFIED', numericGate: 'NOT_VERIFIED', reason })}\n`
      );
      process.exitCode = 2;
    }
  );
}
