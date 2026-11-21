/** Join retained Windows controller attempts to the existing V8 timing arithmetic. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  type Distribution,
  checkTimingClockBounds,
  readDistribution,
  verifyTiming,
} from './owned-vp8-product-timing.ts';

const SHA = /^[a-f0-9]{64}$/i;
const SOURCE = /^[a-f0-9]{40}$/;
const GUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const OUTPUT_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;
const PAYLOAD_PART = /^[A-Za-z0-9._@+-]{1,160}$/;
const SELECTOR = /^owned-vp8-product-v8-(low|medium|high)(-ba)?$/;
const JSON_LIMIT = 2 * 1024 * 1024;
const FILE_LIMIT = 64 * 1024 * 1024;
const TOTAL_LIMIT = 256 * 1024 * 1024;
const PAYLOAD_FILE_LIMIT = 256 * 1024 * 1024;
const PAYLOAD_TOTAL_LIMIT = 512 * 1024 * 1024;
const PAYLOAD_FILE_COUNT = 4096;
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
  assert(typeof value === 'string' && OUTPUT_FILE.test(value), `${label} is unsafe`);
  return value;
}
function safePayloadPath(value: unknown): string {
  assert(
    typeof value === 'string' &&
      value.length <= 1024 &&
      !value.includes('\\') &&
      !value.includes(':') &&
      value.split('/').every((part) => part !== '.' && part !== '..' && PAYLOAD_PART.test(part)),
    'bundle file path is unsafe'
  );
  return value;
}

/** Read the opened file, not a pathname checked before a second open. */
async function withRegularFile<T>(
  path: string,
  label: string,
  limit: number,
  consume: (handle: FileHandle, size: number) => Promise<T>
): Promise<T> {
  try {
    // Open first: POSIX flags reject a leaf link and avoid blocking on a FIFO.
    // Windows Node lacks O_NOFOLLOW; compare the handle with the path before
    // consuming bytes. The digest still binds the admitted content.
    const flags =
      constants.O_RDONLY |
      (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const handle = await open(path, flags);
    try {
      const [before, entry] = await Promise.all([handle.stat(), lstat(path)]);
      assert(
        before.isFile() &&
          entry.isFile() &&
          !entry.isSymbolicLink() &&
          before.dev === entry.dev &&
          before.ino === entry.ino,
        `${label} is missing or linked`
      );
      assert(
        Number.isSafeInteger(before.size) && before.size <= limit,
        `${label} exceeds byte limit`
      );
      const value = await consume(handle, before.size);
      const [after, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
      assert(
        after.isFile() &&
          pathAfter.isFile() &&
          !pathAfter.isSymbolicLink() &&
          after.dev === before.dev &&
          after.ino === before.ino &&
          pathAfter.dev === before.dev &&
          pathAfter.ino === before.ino &&
          after.size === before.size &&
          after.mtimeMs === before.mtimeMs,
        `${label} changed while reading`
      );
      return value;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ELOOP')
      throw new Error(`${label} is missing or linked`);
    if (error instanceof Error && 'code' in error && error.code !== 'ERR_ASSERTION')
      throw new Error(`${label} is missing or unreadable`);
    throw error;
  }
}
async function regular(path: string, label: string, limit: number): Promise<Buffer> {
  return withRegularFile(path, label, limit, async (handle, size) => {
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        Math.min(size - offset, 64 * 1024),
        offset
      );
      assert(bytesRead > 0, `${label} changed while reading`);
      offset += bytesRead;
    }
    const { bytesRead } = await handle.read(Buffer.alloc(1), 0, 1, size);
    assert(bytesRead === 0, `${label} changed while reading`);
    return bytes;
  });
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
): Promise<{ value: unknown; sha256: string; byteLength: number }> {
  const bytes = await regular(path, label, limit);
  try {
    return {
      value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) as unknown,
      sha256: hash(bytes),
      byteLength: bytes.length,
    };
  } catch {
    throw new Error(`${label} is malformed JSON`);
  }
}

/** Rehash the exact producer payload, including the copied bundle manifest. */
export async function verifyPayload(root: string, bundleSha256: string, files: readonly unknown[]) {
  const payload = join(root, 'payload');
  const expected = new Map<string, string>([['bundle.json', bundleSha256]]);
  for (const raw of files) {
    const item = object(raw, 'bundle file');
    const name = safePayloadPath(item.file);
    assert(!expected.has(name), 'duplicate bundle file path');
    expected.set(name, hex(item.sha256, 'bundle file digest'));
  }
  assert(
    expected.size > 1 && expected.size <= PAYLOAD_FILE_COUNT + 1,
    'bundle inventory count is invalid'
  );
  const observed = new Set<string>();
  let total = 0;
  let visited = 0;
  const walk = async (directoryPath: string, prefix: string, depth: number): Promise<void> => {
    assert(depth <= 16, 'payload nesting exceeds limit');
    await directory(directoryPath, 'payload directory');
    for (const child of await readdir(directoryPath, { withFileTypes: true })) {
      visited++;
      assert(visited <= PAYLOAD_FILE_COUNT * 2, 'payload entry count exceeds limit');
      const relative = safePayloadPath(prefix ? `${prefix}/${child.name}` : child.name);
      const path = join(directoryPath, child.name);
      const stat = await lstat(path);
      assert(!stat.isSymbolicLink(), 'payload contains a linked entry');
      const canonical = await realpath(path);
      assert(canonical.startsWith(`${payload}${sep}`), 'payload path escapes root');
      if (stat.isDirectory()) {
        await walk(path, relative, depth + 1);
        continue;
      }
      assert(stat.isFile(), 'payload contains a non-file entry');
      const expectedSha = expected.get(relative);
      assert(expectedSha, 'payload has an unlisted file');
      const digest = await withRegularFile(
        path,
        'payload file',
        PAYLOAD_FILE_LIMIT,
        async (handle, size) => {
          assert(total + size <= PAYLOAD_TOTAL_LIMIT, 'payload aggregate exceeds byte limit');
          const hasher = createHash('sha256');
          let bytes = 0;
          for await (const chunk of handle.createReadStream({ autoClose: false })) {
            bytes += chunk.length;
            assert(bytes <= PAYLOAD_FILE_LIMIT, 'payload file exceeds byte limit');
            hasher.update(chunk as Buffer);
          }
          total += bytes;
          assert(total <= PAYLOAD_TOTAL_LIMIT, 'payload aggregate exceeds byte limit');
          return hasher.digest('hex');
        }
      );
      same(digest, expectedSha, 'payload file digest');
      observed.add(relative);
    }
  };
  await walk(payload, '', 0);
  same(observed, new Set(expected.keys()), 'payload file inventory');
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

/** Chain-only evidence for focused validation; the numeric verdict is in verifyAttempts. */
export async function readAttempts(roots: readonly string[], pins: AttemptPins) {
  same(roots.length, 15, 'attempt root count');
  assert(SOURCE.test(pins.candidateSourceSha), 'candidate source pin is invalid');
  hex(pins.candidateModuleSha256, 'candidate module pin');
  const uniqueRoots = new Set<string>();
  const reports: unknown[] = [];
  const receiptHashes: string[] = [];
  const attempts: RecordJson[] = [];
  const common = new Map<string, string>();
  const missing = new Set<string>([
    'guest CPU model and core count',
    'guest neighboring load trace',
    'selected browser executable fingerprint',
    'host neighboring load trace',
    'post-retire linear retention',
  ]);
  const allObserved = { cpu: true, browser: true, load: true };
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
    await verifyPayload(root, bundleFile.sha256, bundleFiles);
    const priorPayload = await readDistribution(
      join(root, 'payload/validation/windows/prior-dist'),
      'prior'
    );
    const candidatePayload = await readDistribution(join(root, 'payload/dist'), 'candidate');
    same(priorPayload, pins.priorDistribution, 'prior payload distribution');
    same(candidatePayload, pins.candidateDistribution, 'candidate payload distribution');
    const selectorPath = `validation/windows/inputs/${bundle.scenario}.json`;
    const profile = payloadEntry(bundleFiles, 'validation/windows/profile.json');
    const selector = payloadEntry(bundleFiles, selectorPath);
    const guest = payloadEntry(bundleFiles, 'guest.mjs');
    const selectorFile = await json(join(root, 'payload', selectorPath), 'selector');
    same(selectorFile.value, { scenario: bundle.scenario }, 'selector content');
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
    const collectedSizes = new Map<string, number>();
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
      collectedSizes.set(name, bytes.length);
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
      same(artifact.bytes, collectedSizes.get(name), `artifact ${name} size`);
    }
    same(
      artifactNames,
      new Set(
        [...collected].filter((name) => !['result.json', 'stdout.txt', 'stderr.txt'].includes(name))
      ),
      'guest artifact inventory'
    );
    const name = `${bundle.scenario}.json`;
    const receiptEntry = entry(collection, name, 'collection');
    entry(artifactEntries, name, 'result artifact');
    const receiptFile = await json(join(root, 'output', name), 'timing receipt', FILE_LIMIT);
    same(
      receiptFile.sha256,
      hex(receiptEntry.sha256, 'timing receipt collection digest'),
      'timing receipt collection digest'
    );
    same(receiptFile.byteLength, collectedSizes.get(name), 'timing receipt collected byte count');
    const report = object(receiptFile.value, 'timing receipt');
    same(report.scenario, bundle.scenario, 'timing scenario');
    same(report.browserVersion, result.browser_version, 'browser version');
    const patch = report.priorLegacyLoaderPatch;
    if (patch !== undefined) {
      const loaderPatch = object(patch, 'prior loader patch');
      assert(
        typeof loaderPatch.path === 'string' &&
          /^assets\/webp-wasm[-.][\w-]{8}\.js$/.test(loaderPatch.path),
        'prior loader patch path invalid'
      );
      const inventory = payloadEntry(
        bundleFiles,
        `validation/windows/prior-dist/${loaderPatch.path}`
      );
      same(
        loaderPatch.originalSha256,
        inventory.sha256,
        'prior loader patch differs from payload inventory'
      );
      for (const [build, prefix] of [
        ['prior', 'validation/windows/prior-dist'],
        ['candidate', 'dist'],
      ] as const) {
        const patches = list(report[`${build}WorkerPatches`], `${build} Worker patches`);
        for (const raw of patches) {
          const workerPatch = object(raw, `${build} Worker patch`);
          assert(
            typeof workerPatch.path === 'string' &&
              /^assets\/worker[-.][\w-]{8}\.js$/.test(workerPatch.path),
            `${build} Worker patch path invalid`
          );
          const source = payloadEntry(bundleFiles, `${prefix}/${workerPatch.path}`);
          same(
            workerPatch.originalSha256,
            source.sha256,
            `${build} Worker patch differs from payload inventory`
          );
        }
      }
    }
    const timingEnvironmentName = `${bundle.scenario}-timing-environment.json`;
    let timingEnvironmentSha256: string | null = null;
    let timingBrowser: RecordJson | null = null;
    let timingCpu: unknown = null;
    let timingLoadCoverage = false;
    if (collected.has(timingEnvironmentName)) {
      const timingFile = await json(
        join(root, 'output', timingEnvironmentName),
        'timing environment',
        JSON_LIMIT
      );
      timingEnvironmentSha256 = timingFile.sha256;
      same(
        timingFile.sha256,
        hex(
          entry(collection, timingEnvironmentName, 'collection').sha256,
          'timing environment digest'
        ),
        'timing environment collection digest'
      );
      const observed = object(timingFile.value, 'timing environment');
      same(observed.schemaVersion, 1, 'timing environment schema');
      same(observed.scope, 'guest', 'timing environment scope');
      same(observed.hostNeighborLoad, 'UNOBSERVED', 'host neighbor scope');
      if (observed.before !== null && observed.after !== null) {
        const beforeTiming = object(observed.before, 'timing environment before');
        const afterTiming = object(observed.after, 'timing environment after');
        const beforeCpu = list(beforeTiming.cpu, 'guest CPU');
        assert(
          Number.isSafeInteger(beforeTiming.guestNodePid) &&
            (beforeTiming.guestNodePid as number) > 0,
          'guest Node PID invalid'
        );
        same(afterTiming.guestNodePid, beforeTiming.guestNodePid, 'before/after guest Node PID');
        assert(beforeCpu.length > 0 && beforeCpu.length <= 8, 'guest CPU inventory invalid');
        for (const cpu of beforeCpu) {
          const item = object(cpu, 'guest CPU');
          assert(
            typeof item.model === 'string' && item.model.length > 0 && item.model.length <= 256,
            'guest CPU model invalid'
          );
          for (const field of ['cores', 'logicalProcessors'])
            assert(
              Number.isSafeInteger(item[field]) && (item[field] as number) > 0,
              `guest CPU ${field} invalid`
            );
        }
        same(afterTiming.cpu, beforeTiming.cpu, 'before/after guest CPU');
        const beforeBrowser = object(beforeTiming.browser, 'selected browser before');
        const afterBrowser = object(afterTiming.browser, 'selected browser after');
        assert(
          beforeBrowser.name === 'msedge.exe' || beforeBrowser.name === 'chrome.exe',
          'selected browser name invalid'
        );
        assert(
          Number.isSafeInteger(beforeBrowser.pid) && (beforeBrowser.pid as number) > 0,
          'selected browser PID invalid'
        );
        same(beforeBrowser.parentPid, beforeTiming.guestNodePid, 'selected browser parent PID');
        hex(beforeBrowser.sha256, 'selected browser executable');
        assert(
          Number.isSafeInteger(beforeBrowser.bytes) && (beforeBrowser.bytes as number) > 0,
          'selected browser executable size invalid'
        );
        same(beforeBrowser.version, result.browser_version, 'selected browser version');
        same(afterBrowser, beforeBrowser, 'before/after selected browser executable');
        timingBrowser = beforeBrowser;
        timingCpu = beforeCpu;
        for (const [field, value] of [
          ['guestCpu', beforeCpu],
          ['browserExecutableSha256', beforeBrowser.sha256],
          ['browserExecutableName', beforeBrowser.name],
        ] as Array<[string, unknown]>) {
          const serialized = stable(value);
          if (common.has(field)) same(serialized, common.get(field), `cross-attempt ${field}`);
          else common.set(field, serialized);
        }
      } else {
        allObserved.cpu = false;
        allObserved.browser = false;
      }
      const load = object(observed.load, 'guest load trace');
      same(load.scope, 'guest-total-processor', 'guest load scope');
      same(load.truncated, false, 'guest load trace truncation');
      same(load.samplerError, false, 'guest load sampler');
      same(load.reaped, true, 'guest load sampler cleanup');
      const samples = list(load.samples, 'guest load samples');
      if (samples.length >= 2) {
        const times = samples.map((raw) => {
          const item = object(raw, 'guest load sample');
          assert(
            typeof item.utc === 'string' && Number.isFinite(Date.parse(item.utc)),
            'guest load timestamp invalid'
          );
          assert(
            typeof item.guestTotalCpuPercent === 'number' &&
              Number.isFinite(item.guestTotalCpuPercent) &&
              item.guestTotalCpuPercent >= 0 &&
              item.guestTotalCpuPercent <= 100,
            'guest load percentage invalid'
          );
          return Date.parse(item.utc);
        });
        assert(
          times.every(
            (time, index) =>
              index === 0 || (time > times[index - 1]! && time - times[index - 1]! <= 6_000)
          ),
          'guest load samples have a gap or reversal'
        );
        const timingSamples = list(report.samples, 'timing samples');
        const samplerStart = Date.parse(load.startedUtc as string);
        const samplerEnd = Date.parse(load.endedUtc as string);
        assert(
          Number.isFinite(samplerStart) &&
            Number.isFinite(samplerEnd) &&
            samplerStart <= times[0]! &&
            times.at(-1)! <= samplerEnd,
          'guest load sampler window invalid'
        );
        const clockBounds = timingSamples.map((raw, index) =>
          checkTimingClockBounds(object(raw, 'timing sample'), `timing sample ${index + 1}`, false)
        );
        if (clockBounds.every((bounds) => bounds !== null)) {
          const clicks = clockBounds.map((bounds) => bounds!.clickWallMs);
          const ready = clockBounds.map((bounds) => bounds!.readyWallMs);
          timingLoadCoverage =
            samplerStart <= Math.min(...clicks) &&
            samplerEnd >= Math.max(...ready) &&
            times[0]! <= Math.min(...clicks) &&
            times.at(-1)! >= Math.max(...ready);
        }
        if (!timingLoadCoverage) allObserved.load = false;
      } else allObserved.load = false;
    } else {
      allObserved.cpu = false;
      allObserved.browser = false;
      allObserved.load = false;
    }
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
        timingEnvironment: timingEnvironmentSha256,
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
      timingGuest: {
        environmentSha256: timingEnvironmentSha256,
        cpu: timingCpu,
        browser: timingBrowser
          ? {
              name: timingBrowser.name,
              pid: timingBrowser.pid,
              version: timingBrowser.version,
              executableSha256: timingBrowser.sha256,
              executableBytes: timingBrowser.bytes,
            }
          : null,
        loadScope: timingEnvironmentSha256 ? 'guest-total-processor' : null,
        loadCoverage: timingLoadCoverage ? 'complete' : 'NOT_VERIFIED',
        hostNeighborLoad: 'UNOBSERVED',
      },
      vmGuid: before.vm_id,
      readiness: environment.readiness,
      drift: environment.drift,
      functionalCorroboration:
        'The separate candidate cadence conversion corroborates output frame work; per-job timing probe status is checked independently.',
    });
  }
  if (allObserved.cpu) missing.delete('guest CPU model and core count');
  if (allObserved.browser) missing.delete('selected browser executable fingerprint');
  if (allObserved.load) missing.delete('guest neighboring load trace');
  return { reports, receiptHashes, attempts, common, missing };
}

export async function verifyAttempts(roots: readonly string[], pins: AttemptPins) {
  const { reports, receiptHashes, attempts, common, missing } = await readAttempts(roots, pins);
  const numeric = verifyTiming(reports, pins, receiptHashes);
  if (numeric.samples.some((sample) => sample.timingAttestation.status === 'MISSING'))
    missing.add('per-job timing attestation');
  if (
    numeric.samples.some((sample) =>
      [
        'EXECUTION_UNKNOWN',
        'WORKER_SNAPSHOT_UNAVAILABLE',
        'LEGACY_WORKER_SNAPSHOT_UNAVAILABLE',
        'LEGACY_EXECUTION_AND_COPY_UNKNOWN',
      ].includes(sample.timingAttestation.status)
    )
  )
    missing.add('per-job encoder/copy execution');
  return {
    ...numeric,
    qualification: 'NOT_VERIFIED',
    qualificationReason:
      'The collected chain binds per-job timing probes and available guest CPU/browser/load observations. Host neighboring load is not observed by the guest profile, and incomplete probes or environment fields cannot qualify the full program. Numeric PASS alone is not qualification.',
    evidenceScope:
      'maintained Windows controller attempt metadata and byte hashes; guest process executable identity is separately observed when available, while host neighboring load is unobserved',
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
      comparableGuestCpu: missing.has('guest CPU model and core count')
        ? null
        : JSON.parse(common.get('guestCpu')!),
      selectedBrowserExecutableSha256: missing.has('selected browser executable fingerprint')
        ? null
        : JSON.parse(common.get('browserExecutableSha256')!),
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

function publicFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'Evidence admission failed';
  const message = error.message;
  for (const label of [
    'bundle',
    'transport',
    'collection',
    'result',
    'environment',
    'timing receipt',
    'selector',
  ])
    if (message === `${label} is malformed JSON`) return message;
  if (/payload|bundle file/.test(message)) return 'Payload inventory or file admission failed';
  if (/distribution|compiled source|app entry|HTML|service.worker/.test(message))
    return 'Distribution source or file admission failed';
  if (/collection|collected|artifact/.test(message)) return 'Collected artifact admission failed';
  if (/readiness|drift|VM GUID|environment/.test(message))
    return 'Environment identity or readiness failed';
  if (/timing|sample|receipt|numeric|candidate|prior/.test(message))
    return 'Timing receipt or pin admission failed';
  return 'Controller attempt admission failed';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.status !== 'PASS') process.exitCode = result.status === 'FAIL' ? 1 : 2;
    },
    (error: unknown) => {
      const reason = publicFailure(error);
      process.stdout.write(
        `${JSON.stringify({ status: 'NOT_VERIFIED', numericGate: 'NOT_VERIFIED', reason })}\n`
      );
      process.exitCode = 2;
    }
  );
}
