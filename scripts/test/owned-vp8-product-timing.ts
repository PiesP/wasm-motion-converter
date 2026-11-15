/** Post-run V8 whole-product timing verifier. It never launches a browser or encoder. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readBuild } from '../../validation/windows/app-update.ts';

const PRIOR_SOURCE = 'be35f5fa89a60189475fe2ef7fd446e9fa18cef4';
const PRIOR_WASM = '4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22';
const PRIOR_LOADER = '15cd582651f78831babe9b54012388f22614c48b39c899fa2772e62b037dae47';
const PRIOR_LOADER_PATCH = '125b2d4ee079151de879afa1315e10e98425f146d4c6b86fbc2f051e3879ec4a';
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

/** Reuse the controller's exact source-bound distribution admission. */
export async function readDistribution(directory: string, kind: Build): Promise<Distribution> {
  const root = await realpath(directory);
  const parent = dirname(root);
  const relative = basename(root);
  const build = await readBuild(
    parent,
    relative,
    async (_bundleRoot, path) => {
      const fullPath = await realpath(resolve(parent, path));
      assert(fullPath.startsWith(`${root}${sep}`), `${kind} path escapes distribution`);
      return fullPath;
    },
    { requireCompiledSource: true, verifyInventory: true, exactInventory: true }
  );
  const pattern =
    kind === 'prior'
      ? /^assets\/webp-wasm[-.][\w-]{8}\.wasm$/
      : /^assets\/owned-vp8[-.][\w-]{8}\.wasm$/;
  const matching = build.state.files.filter((entry) => pattern.test(entry.path));
  equal(matching.length, 1, `${kind} module count`);
  const module = matching[0]!;
  return {
    sourceSha: build.state.sourceSha,
    treeSha: build.state.treeSha,
    coreSha: build.state.coreSha,
    manifestSha256: build.manifestSha256,
    module: { path: module.path, size: module.size, sha256: module.sha256 },
  };
}

function checkResource(sample: Json, modulePath: string, label: string) {
  const resources = array(sample.wasmResources, `${label} WASM resources`);
  assert(resources.length > 0, `${label} has no WASM resource entries`);
  const resourceIds = resources.map((item) => {
    const entry = object(item, `${label} WASM resource`);
    assert(typeof entry.name === 'string', `${label} WASM resource URL is absent`);
    const url = new URL(entry.name);
    assert(
      url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'),
      `${label} WASM resource is not local`
    );
    const transferSize = number(entry.transferSize, `${label} transfer size`);
    const encodedBodySize = number(entry.encodedBodySize, `${label} body size`, true);
    return { path: url.pathname.slice(1), transferSize, encodedBodySize };
  });
  equal(
    resourceIds.filter((entry) => entry.path === modulePath).length,
    1,
    `${label} expected module resource count`
  );
  assert(
    !resourceIds.some(
      (entry) =>
        /^(?:assets\/)(?:webp-wasm|owned-vp8)[-.]/.test(entry.path) && entry.path !== modulePath
    ),
    `${label} fetched another WebP module`
  );
  return resourceIds;
}

/** Admit a numeric probe only for the exact UI job that produced this sample. */
export function checkTimingAttestation(value: unknown, epoch: string, build: Build) {
  if (value === undefined) return { status: 'MISSING' as const, epoch };
  const probe = object(value, `${epoch} timing attestation`);
  equal(probe.epoch, epoch, `${epoch} attestation epoch`);
  equal(probe.epochMatches, true, `${epoch} active epoch`);
  equal(probe.scope, 'main-observed-worker-route-only', `${epoch} probe scope`);
  const fields = [
    'ownedInstances',
    'successfulBeginCalls',
    'stepCalls',
    'retireCalls',
    'inputCopyBytes',
    'outputCopyBytes',
    'inputCopyEvents',
    'outputCopyEvents',
    'unknownCopyKinds',
    'peakLinearCapacityBytes',
    'capacityAtJobEndBytes',
    'workerStarts',
    'workerCompletions',
    'workerErrors',
    'staleWorkerEvents',
    'legacyIndexedCopyEvents',
  ] as const;
  function checkState(state: Json, name: string, main = false) {
    assert.deepEqual(
      Object.keys(state).sort(),
      [
        'epoch',
        ...fields,
        ...(main ? ['epochMatches', 'scope', 'workerObservation', 'workerSnapshotStatus'] : []),
      ].sort(),
      `${name} has unsupported fields`
    );
    for (const field of fields) {
      const observed = number(state[field], `${name} ${field}`);
      assert(Number.isSafeInteger(observed) && observed >= 0, `${name} ${field} is invalid`);
    }
    equal(state.staleWorkerEvents, 0, `${name} stale Worker events`);
    equal(state.unknownCopyKinds, 0, `${name} unknown copy kind`);
  }
  checkState(probe, epoch, true);
  assert(
    ['none', 'valid', 'invalid', 'missing'].includes(probe.workerSnapshotStatus as string),
    `${epoch} Worker snapshot status invalid`
  );
  assert(
    (probe.workerCompletions as number) <= (probe.workerStarts as number),
    `${epoch} Worker completed without start`
  );
  assert(
    (probe.workerErrors as number) <= (probe.workerStarts as number),
    `${epoch} Worker errored without start`
  );
  const workerObservation =
    probe.workerObservation === null
      ? null
      : object(probe.workerObservation, `${epoch} Worker observation`);
  let worker: Json | null = null;
  let workerRequestId: string | null = null;
  if (workerObservation) {
    equal(probe.workerSnapshotStatus, 'valid', `${epoch} Worker snapshot status`);
    assert.deepEqual(
      Object.keys(workerObservation).sort(),
      ['requestId', 'state'],
      `${epoch} Worker observation has unsupported fields`
    );
    equal(probe.workerStarts, 1, `${epoch} Worker start count`);
    equal(probe.workerCompletions, 1, `${epoch} Worker completion count`);
    equal(probe.workerErrors, 0, `${epoch} Worker error count`);
    workerRequestId = workerObservation.requestId as string;
    assert(
      typeof workerRequestId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(workerRequestId),
      `${epoch} Worker request ID invalid`
    );
    worker = object(workerObservation.state, `${epoch} Worker state`);
    equal(worker.epoch, workerRequestId, `${epoch} Worker epoch`);
    checkState(worker, `${epoch} Worker`);
    assert(
      Buffer.byteLength(JSON.stringify(worker), 'utf8') <= 1024,
      `${epoch} Worker snapshot exceeds bound`
    );
  }
  if (build === 'prior') {
    equal(probe.ownedInstances, 0, `${epoch} prior owned instance`);
    equal(probe.successfulBeginCalls, 0, `${epoch} prior owned begin`);
    if (worker) {
      equal(worker.ownedInstances, 0, `${epoch} prior Worker owned instance`);
      equal(worker.successfulBeginCalls, 0, `${epoch} prior Worker owned begin`);
    }
    const actual = worker ?? probe;
    if ((probe.workerCompletions as number) > 0 && !worker)
      return {
        status: 'LEGACY_WORKER_SNAPSHOT_UNAVAILABLE' as const,
        epoch,
        probe,
        workerRequestId,
      };
    if ((actual.legacyIndexedCopyEvents as number) > 0) {
      assert(
        (actual.inputCopyBytes as number) > 0 &&
          (actual.outputCopyBytes as number) > 0 &&
          (actual.peakLinearCapacityBytes as number) >= (actual.capacityAtJobEndBytes as number) &&
          (actual.capacityAtJobEndBytes as number) > 0,
        `${epoch} legacy copy/capacity evidence incomplete`
      );
      return { status: 'LEGACY_BOUNDARY_COPIES_OBSERVED' as const, epoch, probe, workerRequestId };
    }
    return { status: 'LEGACY_EXECUTION_AND_COPY_UNKNOWN' as const, epoch, probe, workerRequestId };
  }
  const execution = worker ?? probe;
  if ((probe.workerCompletions as number) > 0) {
    equal(probe.successfulBeginCalls, 0, `${epoch} dual main/Worker encoder`);
    if (!worker)
      return {
        status: 'WORKER_SNAPSHOT_UNAVAILABLE' as const,
        epoch,
        probe,
        workerRequestId,
      };
  }
  if ((execution.successfulBeginCalls as number) > 0) {
    assert(
      (execution.ownedInstances as number) > 0 &&
        (execution.stepCalls as number) > 0 &&
        (execution.retireCalls as number) > 0,
      `${epoch} incomplete owned ABI execution`
    );
    assert(
      (execution.inputCopyBytes as number) > 0 &&
        (execution.outputCopyBytes as number) > 0 &&
        (execution.inputCopyEvents as number) > 0 &&
        (execution.outputCopyEvents as number) > 0,
      `${epoch} observed copy events absent`
    );
    assert(
      (execution.peakLinearCapacityBytes as number) >=
        (execution.capacityAtJobEndBytes as number) &&
        (execution.capacityAtJobEndBytes as number) > 0,
      `${epoch} linear capacity invalid`
    );
    return {
      status: worker ? ('OWNED_WORKER_OBSERVED' as const) : ('OWNED_MAIN_OBSERVED' as const),
      epoch,
      probe,
      workerRequestId,
    };
  }
  return { status: 'EXECUTION_UNKNOWN' as const, epoch, probe, workerRequestId };
}

/** Page-observed wall bounds; an old receipt may lack them but cannot cover load. */
export function checkTimingClockBounds(sample: Json, label: string, required: boolean) {
  const keys = ['clickClockMs', 'readyClockMs', 'clickWallUtc', 'readyWallUtc'] as const;
  const present = keys.filter((key) => sample[key] !== undefined).length;
  if (present === 0 && !required) return null;
  assert.equal(present, keys.length, `${label} actual clock bounds are incomplete`);
  const origin = number(sample.timeOrigin, `${label} time origin`, true);
  const click = number(sample.clickClockMs, `${label} page click clock`);
  const ready = number(sample.readyClockMs, `${label} page ready clock`);
  assert(click >= 0 && ready > click, `${label} page clock order invalid`);
  const elapsed = number(sample.requestToDownloadReadyMs, `${label} ready time`, true);
  assert(
    Math.abs(ready - click - elapsed) < 0.001,
    `${label} page clocks differ from measured interval`
  );
  const clickUtc = new Date(Math.floor(origin + click)).toISOString();
  const readyUtc = new Date(Math.ceil(origin + ready)).toISOString();
  equal(sample.clickWallUtc, clickUtc, `${label} actual click wall time`);
  equal(sample.readyWallUtc, readyUtc, `${label} actual ready wall time`);
  return { clickWallMs: Date.parse(clickUtc), readyWallMs: Date.parse(readyUtc) };
}

export function verifyTiming(
  reports: readonly unknown[],
  expected: {
    candidateSourceSha: string;
    candidateModuleSha256: string;
    priorDistribution: Distribution;
    candidateDistribution: Distribution;
  },
  receiptDigests: readonly string[]
) {
  sourceSha(expected.candidateSourceSha, 'expected candidate source');
  sha(expected.candidateModuleSha256, 'expected candidate module');
  equal(reports.length, 15, 'controller invocation count');
  equal(receiptDigests.length, reports.length, 'receipt digest count');
  const priorDist = expected.priorDistribution;
  const candidateDist = expected.candidateDistribution;
  equal(priorDist.sourceSha, PRIOR_SOURCE, 'frozen prior source');
  equal(priorDist.module.sha256, PRIOR_WASM, 'frozen prior module');
  equal(candidateDist.sourceSha, expected.candidateSourceSha, 'candidate source');
  equal(candidateDist.module.sha256, expected.candidateModuleSha256, 'candidate module');
  const seenReceipts = new Set<string>();
  const invocationKeys = new Set<string>();
  const attestationEpochs = new Set<string>();
  const workerRequestIds = new Set<string>();
  let attestationMode: boolean | undefined;
  const common = new Map<string, string>();
  const orders = new Map<Quality, string[]>();
  const measured = new Map<string, number[]>();
  const sampleRecords: Array<{
    controllerReceiptSha256: string;
    quality: Quality;
    order: string;
    build: Build;
    condition: Condition;
    elapsedMs: number;
    wallStart: string;
    clickWallUtc: string | null;
    readyWallUtc: string | null;
    requestToBlobPublicationMs: number;
    documentTimeOrigin: number;
    contextIdentity: string;
    pageIdentity: string;
    navigationCount: number;
    contextCacheScope: string;
    wasmResources: Array<{ path: string; transferSize: number; encodedBodySize: number }>;
    timingAttestation: ReturnType<typeof checkTimingAttestation>;
  }> = [];
  for (const [index, raw] of reports.entries()) {
    const report = object(raw, 'controller receipt');
    const invocationId = report.timingInvocationId;
    if (invocationId !== undefined)
      assert(
        typeof invocationId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(invocationId),
        'timing invocation ID is invalid'
      );
    const hasTimingAttestation =
      Array.isArray(report.samples) &&
      report.samples.some(
        (sample) => sample !== null && typeof sample === 'object' && 'timingAttestation' in sample
      );
    if (attestationMode === undefined) attestationMode = hasTimingAttestation;
    else equal(hasTimingAttestation, attestationMode, 'mixed attestation receipt mode');
    if (hasTimingAttestation) {
      assert(invocationId, 'timing invocation ID absent');
      const patch = object(report.priorLegacyLoaderPatch, 'prior legacy loader patch');
      assert(
        typeof patch.path === 'string' && /^assets\/webp-wasm[-.][\w-]{8}\.js$/.test(patch.path),
        'prior loader path invalid'
      );
      equal(patch.originalSha256, PRIOR_LOADER, 'prior loader original digest');
      equal(patch.patchedSha256, PRIOR_LOADER_PATCH, 'prior loader patched digest');
      equal(patch.instrumentation, 'post-loop-actual-iteration-count', 'prior loader patch kind');
    }
    const controllerReceiptSha256 = sha(receiptDigests[index], 'controller receipt digest');
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
    if (hasTimingAttestation)
      assert(
        samples.every(
          (sample) => sample !== null && typeof sample === 'object' && 'timingAttestation' in sample
        ),
        'partial timing attestation receipt'
      );
    const cells = new Map<string, Json>();
    const receiptAttestations: Array<{ build: Build; workerCompletions: number }> = [];
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
      const clockBounds = checkTimingClockBounds(sample, label, hasTimingAttestation);
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
      const wasmResources = checkResource(
        sample,
        (build === 'prior' ? priorDist : candidateDist).module.path,
        label
      );
      const caseId = `owned-vp8-${report.scenario}-${build}-v8-full-${quality}-${condition}`;
      const epoch: string = typeof invocationId === 'string' ? `${invocationId}:${caseId}` : caseId;
      if (invocationId) {
        assert(!attestationEpochs.has(epoch), `${label} duplicate attestation epoch`);
        attestationEpochs.add(epoch);
      }
      const timingAttestation = checkTimingAttestation(sample.timingAttestation, epoch, build);
      if ('probe' in timingAttestation)
        receiptAttestations.push({
          build,
          workerCompletions: timingAttestation.probe.workerCompletions as number,
        });
      if (sample.timingAttestation !== undefined)
        assert(invocationId, `${label} invocation ID absent`);
      if (hasTimingAttestation)
        assert(sample.timingAttestation !== undefined, `${label} timing attestation absent`);
      if ('workerRequestId' in timingAttestation && timingAttestation.workerRequestId) {
        assert(
          !workerRequestIds.has(timingAttestation.workerRequestId),
          `${label} duplicate Worker request ID`
        );
        workerRequestIds.add(timingAttestation.workerRequestId);
      }
      const bucket = `${quality}/${condition}/${build}`;
      const values = measured.get(bucket) ?? [];
      values.push(elapsed);
      measured.set(bucket, values);
      sampleRecords.push({
        controllerReceiptSha256,
        quality,
        order,
        build,
        condition,
        elapsedMs: elapsed,
        wallStart,
        clickWallUtc: clockBounds ? (sample.clickWallUtc as string) : null,
        readyWallUtc: clockBounds ? (sample.readyWallUtc as string) : null,
        requestToBlobPublicationMs: publication,
        documentTimeOrigin: sample.timeOrigin as number,
        contextIdentity: sample.contextIdentity as string,
        pageIdentity: sample.pageIdentity as string,
        navigationCount: sample.navigationCount as number,
        contextCacheScope: sample.contextCacheScope as string,
        wasmResources,
        timingAttestation,
      });
    }
    if (hasTimingAttestation) {
      for (const build of ['prior', 'candidate'] as const) {
        const patches = array(report[`${build}WorkerPatches`], `${build} Worker patches`);
        assert(patches.length <= 16, `${build} Worker patch count exceeds bound`);
        if (receiptAttestations.some((item) => item.build === build && item.workerCompletions > 0))
          assert(patches.length > 0, `${build} Worker completed without source-bound patch`);
        let identity: string | null = null;
        for (const raw of patches) {
          const patch = object(raw, `${build} Worker patch`);
          assert(
            typeof patch.path === 'string' && /^assets\/worker[-.][\w-]{8}\.js$/.test(patch.path),
            `${build} Worker patch path invalid`
          );
          const original = sha(patch.originalSha256, `${build} Worker original digest`);
          const patched = sha(patch.patchedSha256, `${build} Worker patched digest`);
          const serialized = `${patch.path}/${original}/${patched}`;
          if (identity !== null) equal(serialized, identity, `${build} mixed Worker patch`);
          else identity = serialized;
        }
      }
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
  const observedStatuses = new Set(sampleRecords.map((sample) => sample.timingAttestation.status));
  const unresolvedStatuses = [...observedStatuses].filter(
    (status) =>
      !['OWNED_WORKER_OBSERVED', 'OWNED_MAIN_OBSERVED', 'LEGACY_BOUNDARY_COPIES_OBSERVED'].includes(
        status
      )
  );
  const probeReason = attestationMode
    ? unresolvedStatuses.length > 0
      ? `Per-job timing probes have unresolved status: ${unresolvedStatuses.join(', ')}.`
      : 'Per-job probes observe owned ABI calls, defined JS/WASM boundary copies, and the pinned legacy indexed-copy loop.'
    : 'Legacy receipts have no per-job timing attestation.';
  return {
    status: regression ? 'FAIL' : 'NOT_VERIFIED',
    numericGate: regression ? 'FAIL' : 'PASS',
    qualification: 'NOT_VERIFIED',
    qualificationReason: `${probeReason} This timing-only verifier has no host neighboring load, guest CPU/browser executable, or post-retire linear retention proof; numeric PASS does not qualify the full program.`,
    identities: {
      prior: priorDist,
      candidate: candidateDist,
      input: {
        fixture: 'v8-full',
        path: 'validation/windows/owned-vp8-inputs/v8.webm',
        bytes: 3_145_371,
        sha256: INPUT,
        frozenInputManifestSha256: JSON.parse(common.get('frozenInputManifestSha256')!) as string,
      },
      settings: {
        format: 'webp',
        qualityPercent: { low: 60, medium: 75, high: 85 },
        targetCadenceFps: CADENCE,
        scale: 1,
        smartFrameSkip: 'off',
      },
      timingScope: TIMING_SCOPE,
      cache: {
        reportScope: CACHE_REPORT_SCOPE,
        sampleScope: CACHE_SCOPE,
        conditions: CONDITIONS,
      },
      browserVersion: JSON.parse(common.get('browserVersion')!) as string,
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
  const bytes = await Promise.all(absolute.map((path) => readFile(path)));
  const reports = bytes.map((content) => JSON.parse(content.toString('utf8')) as unknown);
  return verifyTiming(
    reports,
    {
      candidateSourceSha: one('--candidate-source-sha'),
      candidateModuleSha256: one('--candidate-module-sha256'),
      priorDistribution: await readDistribution(one('--prior-dist'), 'prior'),
      candidateDistribution: await readDistribution(one('--candidate-dist'), 'candidate'),
    },
    bytes.map(digest)
  );
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
