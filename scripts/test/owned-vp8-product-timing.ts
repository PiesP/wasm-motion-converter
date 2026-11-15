/** Post-run V8 whole-product timing verifier. It never launches a browser or encoder. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const PRIOR_SOURCE = 'be35f5fa89a60189475fe2ef7fd446e9fa18cef4';
const PRIOR_WASM = '4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22';
const INPUT = 'c6a21a3a7619ca7fbcbc1b4d012d7098d18f599f0200f735d31cae15a4772dd1';
const CACHE_SCOPE =
  'new browser context for this build; first is first-in-document, not proven fresh-profile cold';
const TIMING_SCOPE =
  'UI Convert click to matching published WebP Blob download control ready; save, parse and independent decode follow timing';
const CACHE_REPORT_SCOPE =
  'separate browser contexts per build, same document first/warm within each fixture-quality page; no fresh-profile cold claim';
const SHA = /^[a-f0-9]{64}$/;
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const QUALITIES = ['low', 'medium', 'high'] as const;
const CONDITIONS = ['first-in-document', 'same-document-warm'] as const;
const CADENCE = { low: 12, medium: 18, high: 30 } as const;
type Quality = (typeof QUALITIES)[number];
type Condition = (typeof CONDITIONS)[number];
type Build = 'prior' | 'candidate';
type Json = Record<string, unknown>;

function object(value: unknown, label: string): Json {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} is not an object`
  );
  return value as Json;
}
function array(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `${label} is not an array`);
  return value;
}
function number(value: unknown, label: string, positive = false): number {
  assert(typeof value === 'number' && Number.isFinite(value), `${label} is not finite`);
  assert(!positive || value > 0, `${label} is not positive`);
  return value;
}
function sha(value: unknown, label: string): string {
  assert(typeof value === 'string' && SHA.test(value), `${label} is not a SHA-256 digest`);
  return value;
}
function sourceSha(value: unknown, label: string): string {
  assert(typeof value === 'string' && SOURCE_SHA.test(value), `${label} is not a source SHA`);
  return value;
}
function equal(actual: unknown, expected: unknown, label: string): void {
  assert.equal(actual, expected, `${label} differs`);
}
function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function median(values: readonly number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)]!;
}
function statistics(values: readonly number[]) {
  assert.equal(values.length, 5);
  const middle = median(values);
  return {
    samplesMs: [...values],
    medianMs: middle,
    rangeMs: Math.max(...values) - Math.min(...values),
    madMs: median(values.map((value) => Math.abs(value - middle))),
  };
}

export type Distribution = {
  sourceSha: string;
  treeSha: string;
  coreSha: string;
  manifestSha256: string;
  module: { path: string; size: number; sha256: string };
};

/** Bind a retained distribution manifest to the shipped module bytes. */
export async function readDistribution(directory: string, kind: Build): Promise<Distribution> {
  const bytes = await readFile(resolve(directory, 'deployment-state.json'));
  const state = object(JSON.parse(bytes.toString('utf8')), `${kind} deployment state`);
  equal(state.schemaVersion, 1, `${kind} deployment schema`);
  equal(state.sourceDirty, false, `${kind} source cleanliness`);
  const files = array(state.files, `${kind} inventory`).map((entry) =>
    object(entry, 'inventory entry')
  );
  const root = await realpath(directory);
  const inventoryPaths = new Set<string>();
  for (const file of files) {
    assert(
      typeof file.path === 'string' &&
        file.path.length > 0 &&
        !file.path.startsWith('/') &&
        !file.path.includes('\\') &&
        file.path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
      `${kind} has unsafe inventory path`
    );
    assert(!inventoryPaths.has(file.path), `${kind} has duplicate inventory path`);
    inventoryPaths.add(file.path);
    const actualPath = await realpath(resolve(directory, file.path));
    assert(actualPath.startsWith(`${root}${sep}`), `${kind} inventory path escapes distribution`);
    const content = await readFile(actualPath);
    assert(
      Number.isSafeInteger(file.size) && (file.size as number) >= 0,
      `${kind} inventory size is invalid`
    );
    equal(content.length, file.size, `${kind} ${file.path} size`);
    equal(
      digest(content),
      sha(file.sha256, `${kind} ${file.path} digest`),
      `${kind} ${file.path} bytes`
    );
  }
  const headers = await readFile(resolve(directory, '_headers'));
  equal(
    digest(headers),
    sha(state.headersSha256, `${kind} headers digest`),
    `${kind} headers bytes`
  );
  const actualPaths: string[] = [];
  const visit = async (path: string, prefix = ''): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      assert(actualPaths.length < 128, `${kind} distribution has too many files`);
      if (entry.isDirectory()) await visit(resolve(path, entry.name), relative);
      else {
        assert(entry.isFile(), `${kind} distribution has a non-file entry`);
        actualPaths.push(relative);
      }
    }
  };
  await visit(root);
  assert.deepEqual(
    actualPaths.sort(),
    [...inventoryPaths, '_headers', 'deployment-state.json'].sort(),
    `${kind} exact inventory`
  );
  const pattern =
    kind === 'prior'
      ? /^assets\/webp-wasm[-.][\w-]{8}\.wasm$/
      : /^assets\/owned-vp8[-.][\w-]{8}\.wasm$/;
  const matching = files.filter(
    (entry) => typeof entry.path === 'string' && pattern.test(entry.path)
  );
  equal(matching.length, 1, `${kind} module count`);
  const module = matching[0]!;
  const path = module.path as string;
  const fullPath = await realpath(resolve(directory, path));
  assert(fullPath.startsWith(`${root}${sep}`), `${kind} module path escapes distribution`);
  const moduleBytes = await readFile(fullPath);
  const size = number(module.size, `${kind} module size`, true);
  equal(moduleBytes.length, size, `${kind} module byte length`);
  const moduleSha = sha(module.sha256, `${kind} module digest`);
  equal(digest(moduleBytes), moduleSha, `${kind} module bytes`);
  return {
    sourceSha: sourceSha(state.sourceSha, `${kind} source`),
    treeSha: sourceSha(state.treeSha, `${kind} tree`),
    coreSha: sourceSha(state.coreSha, `${kind} core`),
    manifestSha256: digest(bytes),
    module: { path, size, sha256: moduleSha },
  };
}

function checkResource(sample: Json, modulePath: string, label: string): void {
  const resources = array(sample.wasmResources, `${label} WASM resources`);
  assert(resources.length > 0, `${label} has no WASM resource entries`);
  const paths = resources.map((item) => {
    const entry = object(item, `${label} WASM resource`);
    assert(typeof entry.name === 'string', `${label} WASM resource URL is absent`);
    const url = new URL(entry.name);
    assert(
      url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'),
      `${label} WASM resource is not local`
    );
    number(entry.transferSize, `${label} transfer size`);
    number(entry.encodedBodySize, `${label} body size`, true);
    return url.pathname.slice(1);
  });
  equal(
    paths.filter((path) => path === modulePath).length,
    1,
    `${label} expected module resource count`
  );
  assert(
    !paths.some(
      (path) => /^(?:assets\/)(?:webp-wasm|owned-vp8)[-.]/.test(path) && path !== modulePath
    ),
    `${label} fetched another WebP module`
  );
}

export function verifyTiming(
  reports: readonly unknown[],
  expected: {
    candidateSourceSha: string;
    candidateModuleSha256: string;
    priorDistribution: Distribution;
    candidateDistribution: Distribution;
  }
) {
  sourceSha(expected.candidateSourceSha, 'expected candidate source');
  sha(expected.candidateModuleSha256, 'expected candidate module');
  equal(reports.length, 15, 'controller invocation count');
  const priorDist = expected.priorDistribution;
  const candidateDist = expected.candidateDistribution;
  equal(priorDist.sourceSha, PRIOR_SOURCE, 'frozen prior source');
  equal(priorDist.module.sha256, PRIOR_WASM, 'frozen prior module');
  equal(candidateDist.sourceSha, expected.candidateSourceSha, 'candidate source');
  equal(candidateDist.module.sha256, expected.candidateModuleSha256, 'candidate module');
  const seenReceipts = new Set<string>();
  const invocationKeys = new Set<string>();
  const common = new Map<string, string>();
  const orders = new Map<Quality, string[]>();
  const measured = new Map<string, number[]>();
  const sampleRecords: Array<{
    quality: Quality;
    order: string;
    build: Build;
    condition: Condition;
    elapsedMs: number;
    wallStart: string;
  }> = [];
  for (const raw of reports) {
    const report = object(raw, 'controller receipt');
    const receiptHash = digest(Buffer.from(JSON.stringify(raw)));
    assert(!seenReceipts.has(receiptHash), 'duplicate controller receipt');
    seenReceipts.add(receiptHash);
    equal(report.schemaVersion, 1, 'receipt schema');
    equal(report.status, 'passed', 'controller completion');
    equal(report.timingScope, TIMING_SCOPE, 'timing boundary');
    equal(report.cacheScope, CACHE_REPORT_SCOPE, 'cache boundary');
    assert(
      typeof report.browserVersion === 'string' && report.browserVersion.length > 0,
      'browser version is absent'
    );
    const match =
      typeof report.scenario === 'string'
        ? /^owned-vp8-product-v8-(low|medium|high)(-ba)?$/.exec(report.scenario)
        : null;
    assert(match, 'receipt is not a V8 timing selector');
    const quality = match[1] as Quality;
    const order = match[2] ? 'BA' : 'AB';
    equal(report.fixedQuality, quality, 'fixed quality');
    assert.deepEqual(
      report.order,
      order === 'AB' ? ['prior', 'candidate'] : ['candidate', 'prior']
    );
    const input = array(report.inputs, 'input inventory');
    equal(input.length, 1, 'V8 input count');
    const entry = object(input[0], 'V8 input');
    equal(entry.id, 'v8-full', 'input fixture');
    equal(entry.path, 'validation/windows/owned-vp8-inputs/v8.webm', 'input path');
    equal(entry.sha256, INPUT, 'input digest');
    equal(entry.bytes, 3_145_371, 'input byte count');
    sha(report.frozenInputManifestSha256, 'frozen input manifest');
    const ownedAsset = object(report.ownedAsset, 'owned module');
    for (const key of ['path', 'size', 'sha256'] as const)
      equal(ownedAsset[key], candidateDist.module[key], `candidate module ${key}`);
    for (const [kind, distribution] of [
      ['prior', priorDist],
      ['candidate', candidateDist],
    ] as const) {
      const build = object(report[kind], `${kind} build`);
      for (const key of ['sourceSha', 'treeSha', 'coreSha', 'manifestSha256'] as const)
        equal(build[key], distribution[key], `${kind} ${key}`);
    }
    for (const [key, value] of [
      ['browserVersion', report.browserVersion],
      ['frozenInputManifestSha256', report.frozenInputManifestSha256],
      ['cacheScope', report.cacheScope],
      ['timingScope', report.timingScope],
    ] as const) {
      const serialized = JSON.stringify(value);
      if (common.has(key)) equal(serialized, common.get(key), `cross-receipt ${key}`);
      else common.set(key, serialized);
    }
    const samples = array(report.samples, 'timing samples');
    equal(samples.length, 4, 'timing sample count');
    const cells = new Map<string, Json>();
    for (const rawSample of samples) {
      const sample = object(rawSample, 'timing sample');
      const build = sample.build;
      const condition = sample.condition;
      assert(build === 'prior' || build === 'candidate', 'invalid sample build');
      assert(
        condition === 'first-in-document' || condition === 'same-document-warm',
        'invalid timing condition'
      );
      const label = `${quality}/${build}/${condition}`;
      assert(!cells.has(`${build}/${condition}`), `duplicate sample ${label}`);
      cells.set(`${build}/${condition}`, sample);
      equal(sample.fixture, 'v8-full', `${label} fixture`);
      equal(sample.quality, quality, `${label} quality`);
      equal(sample.inputSha256, INPUT, `${label} input`);
      equal(sample.targetCadenceFps, CADENCE[quality], `${label} cadence`);
      equal(sample.scale, 1, `${label} scale`);
      equal(sample.smartFrameSkip, 'off', `${label} smart skip`);
      equal(sample.contextCacheScope, CACHE_SCOPE, `${label} cache scope`);
      equal(sample.contextIdentity, `${report.scenario}:${build}`, `${label} context`);
      equal(sample.pageIdentity, `v8-full:${quality}`, `${label} page`);
      equal(sample.navigationCount, 1, `${label} navigation count`);
      number(sample.timeOrigin, `${label} time origin`, true);
      const elapsed = number(sample.requestToDownloadReadyMs, `${label} ready time`, true);
      const publication = number(sample.requestToBlobPublicationMs, `${label} publication time`);
      assert(publication >= 0 && publication <= elapsed, `${label} publication outside timing`);
      const wallStart = sample.wallStart;
      assert(
        typeof wallStart === 'string' && Number.isFinite(Date.parse(wallStart)),
        `${label} wall start is invalid`
      );
      const saved = object(sample.saved, `${label} saved output`);
      number(saved.bytes, `${label} saved bytes`, true);
      sha(saved.sha256, `${label} saved digest`);
      assert(typeof saved.file === 'string' && saved.file.length > 0, `${label} saved file absent`);
      number(sample.emittedAnmfCount, `${label} ANMF count`, true);
      assert(
        sample.parsed !== undefined && sample.decoded !== undefined,
        `${label} independent output checks absent`
      );
      checkResource(sample, (build === 'prior' ? priorDist : candidateDist).module.path, label);
      const bucket = `${quality}/${condition}/${build}`;
      const values = measured.get(bucket) ?? [];
      values.push(elapsed);
      measured.set(bucket, values);
      sampleRecords.push({ quality, order, build, condition, elapsedMs: elapsed, wallStart });
    }
    for (const build of ['prior', 'candidate'] as const) {
      const first = cells.get(`${build}/first-in-document`)!;
      const warm = cells.get(`${build}/same-document-warm`)!;
      equal(warm.timeOrigin, first.timeOrigin, `${quality}/${build} warm document identity`);
      assert(
        Date.parse(warm.wallStart as string) >= Date.parse(first.wallStart as string),
        `${quality}/${build} warm precedes first`
      );
    }
    const priorFirst = cells.get('prior/first-in-document')!;
    const candidateFirst = cells.get('candidate/first-in-document')!;
    const priorWarm = cells.get('prior/same-document-warm')!;
    const candidateWarm = cells.get('candidate/same-document-warm')!;
    const firstBuildWarm = order === 'AB' ? priorWarm : candidateWarm;
    const secondBuildFirst = order === 'AB' ? candidateFirst : priorFirst;
    assert(
      Date.parse(secondBuildFirst.wallStart as string) >=
        Date.parse(firstBuildWarm.wallStart as string),
      `${quality} sample order differs from controller order`
    );
    assert(
      priorFirst.timeOrigin !== candidateFirst.timeOrigin,
      `${quality} builds reused a document`
    );
    const invocationKey = `${quality}:${priorFirst.timeOrigin}:${candidateFirst.timeOrigin}`;
    assert(!invocationKeys.has(invocationKey), `${quality} duplicate browser invocation`);
    invocationKeys.add(invocationKey);
    const functional = array(report.functional, 'functional checks');
    equal(functional.length, 1, 'separate V8 functional check count');
    const cadence = object(functional[0], 'V8 functional cadence');
    equal(cadence.route, 'ui-main-v8-cadence', 'functional route');
    equal(cadence.fixture, 'v8-full', 'functional fixture');
    equal(cadence.quality, quality, 'functional quality');
    equal(cadence.inputSha256, INPUT, 'functional input');
    equal(cadence.targetCadenceFps, CADENCE[quality], 'functional cadence');
    const abi = object(cadence.abi, 'functional ABI');
    number(abi.instances, 'functional instances', true);
    number(abi.successfulBeginCalls, 'functional begin calls', true);
    number(cadence.emittedAnmfCount, 'functional ANMF count', true);
    const qualityOrders = orders.get(quality) ?? [];
    qualityOrders.push(order);
    orders.set(quality, qualityOrders);
  }
  const conditions = [];
  let regression = false;
  for (const quality of QUALITIES) {
    const qualityOrders = orders.get(quality) ?? [];
    equal(qualityOrders.length, 5, `${quality} invocation count`);
    assert(
      [2, 3].includes(qualityOrders.filter((order) => order === 'AB').length),
      `${quality} order is not balanced`
    );
    const chronological = sampleRecords
      .filter((sample) => sample.quality === quality && sample.condition === 'first-in-document')
      .reduce<Array<{ order: string; wallStart: string }>>((result, sample) => {
        if (sample.build === (sample.order === 'AB' ? 'prior' : 'candidate'))
          result.push({ order: sample.order, wallStart: sample.wallStart });
        return result;
      }, [])
      .sort((a, b) => Date.parse(a.wallStart) - Date.parse(b.wallStart));
    assert(
      chronological.every(
        (entry, index) => index === 0 || entry.order !== chronological[index - 1]!.order
      ),
      `${quality} invocations are not interleaved`
    );
    for (const condition of CONDITIONS) {
      const prior = statistics(measured.get(`${quality}/${condition}/prior`) ?? []);
      const candidate = statistics(measured.get(`${quality}/${condition}/candidate`) ?? []);
      const allowanceMs = Math.max(prior.medianMs * 0.05, 20);
      const increaseMs = candidate.medianMs - prior.medianMs;
      const passed = increaseMs <= allowanceMs;
      if (!passed) regression = true;
      conditions.push({ quality, condition, prior, candidate, increaseMs, allowanceMs, passed });
    }
  }
  return {
    status: regression ? 'FAIL' : 'NOT_VERIFIED',
    numericGate: regression ? 'FAIL' : 'PASS',
    qualification: 'NOT_VERIFIED',
    qualificationReason:
      'Timed samples attest a fetched WASM resource, but the maintained V8 receipt does not attest the executed encoder route for each timed conversion or copied bytes and retained capacity. Separate candidate cadence instrumentation is outside timing; prior execution is not independently instrumented.',
    identities: {
      priorSourceSha: PRIOR_SOURCE,
      priorModuleSha256: PRIOR_WASM,
      candidateSourceSha: expected.candidateSourceSha,
      candidateModuleSha256: expected.candidateModuleSha256,
      priorManifestSha256: priorDist.manifestSha256,
      candidateManifestSha256: candidateDist.manifestSha256,
      inputSha256: INPUT,
      browserVersion: common.get('browserVersion')
        ? (JSON.parse(common.get('browserVersion')!) as string)
        : null,
    },
    invocationOrders: Object.fromEntries(orders),
    samples: sampleRecords,
    conditions,
  };
}

async function main(args: readonly string[]) {
  const options = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new Error(
        'Usage: --receipt PATH (15 times) --prior-dist DIR --candidate-dist DIR --candidate-source-sha SHA --candidate-module-sha256 SHA'
      );
    const values = options.get(key) ?? [];
    values.push(value);
    options.set(key, values);
  }
  assert(
    [...options.keys()].every((key) =>
      [
        '--receipt',
        '--prior-dist',
        '--candidate-dist',
        '--candidate-source-sha',
        '--candidate-module-sha256',
      ].includes(key)
    ),
    'Unknown option'
  );
  const one = (key: string) => {
    const values = options.get(key);
    equal(values?.length, 1, `${key} argument count`);
    return values![0]!;
  };
  const paths = options.get('--receipt') ?? [];
  equal(paths.length, 15, 'receipt path count');
  const absolute = paths.map((path) => resolve(path));
  equal(new Set(absolute).size, 15, 'unique receipt path count');
  const reports = await Promise.all(
    absolute.map(async (path) => JSON.parse(await readFile(path, 'utf8')) as unknown)
  );
  return verifyTiming(reports, {
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
      process.stdout.write(
        `${JSON.stringify({ status: 'NOT_VERIFIED', numericGate: 'NOT_VERIFIED', reason: error instanceof Error ? error.message : String(error) }, null, 2)}\n`
      );
      process.exitCode = 2;
    }
  );
}
