import { mkdtemp, open, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { describe, expect, it } from 'vite-plus/test';

import {
  RgbaFrameCollector,
  createPrivateOutputDirectory,
  ivfChunks,
  readOpenedFile,
  readStableFile,
  readMetadata,
  declaredOutputs,
  assertLargeAdmittedSavedRecords,
  assertReportName,
  assertNearCapSavedRecords,
  assertV8InputCaptureReport,
  assertV8CapturedOutputTimeline,
  extractVp8Frames,
  writeIvf,
} from '../../../scripts/test/owned-vp8-animations.ts';

function chunk(tag: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(tag, 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, Buffer.alloc(body.length & 1)]);
}

function frame(holdMs: number, width = 2, height = 1, firstByte = 0x10): Buffer {
  const header = Buffer.alloc(16);
  header.writeUIntLE(width - 1, 6, 3);
  header.writeUIntLE(height - 1, 9, 3);
  header.writeUIntLE(holdMs, 12, 3);
  const vp8 = Buffer.from([firstByte, 0, 0, 0x9d, 0x01, 0x2a, width, 0, height, 0, 7]);
  return chunk('ANMF', Buffer.concat([header, chunk('VP8 ', vp8)]));
}

function animation(...frames: Buffer[]): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x02;
  vp8x.writeUIntLE(1, 4, 3);
  const body = Buffer.concat([chunk('VP8X', vp8x), chunk('ANIM', Buffer.alloc(6)), ...frames]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0);
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8);
  return Buffer.concat([header, body]);
}

describe('saved animation verifier', () => {
  it('admits only two complete, matching V8 input streams with five retained RGB controls', () => {
    const digest = 'a'.repeat(64);
    const rows = Array.from({ length: 77 }, (_, index) => ({
      index,
      frameNum: index + 1,
      startUs: index * 80_000,
      endUs: index === 76 ? 6_400_000 : (index + 1) * 80_000,
      logicalRgbBytes: 6_220_800,
      chunks: 95,
      sha256: digest,
    }));
    const indices = [0, 19, 38, 57, 76];
    const capture = (build: 'prior' | 'candidate') => ({
      build,
      observedInputs: 77,
      emittedAnmfCount: 77,
      route: 'actual UI main software',
      webp: { file: `${build}.webp`, bytes: 100, sha256: digest },
      streamedHashes: rows.map((row) => ({ ...row })),
      streamedInputRowsFile: `owned-vp8-v8-all-input-${build}.jsonl`,
      pixels: indices.map((index) => ({
        index,
        bytes: 6_220_800,
        sha256: digest,
        file: `owned-vp8-v8-low-input-${build}-${String(index).padStart(2, '0')}.rgb`,
      })),
      parsed: {
        canvas: { width: 1920, height: 1080 },
        totalDurationMs: 6400,
        frames: Array.from({ length: 77 }, () => ({})),
      },
    });
    const report = {
      scenario: 'owned-vp8-product-v8-low-inputs',
      status: 'passed',
      selectedInputIndices: indices,
      expectedObservedInputs: 77,
      fixture: {
        path: 'validation/windows/owned-vp8-inputs/v8.webm',
        bytes: 3_145_371,
        sha256: 'c6a21a3a7619ca7fbcbc1b4d012d7098d18f599f0200f735d31cae15a4772dd1',
        manifestSha256: digest,
      },
      settings: {
        quality: 'low',
        qualityPercent: 60,
        cadenceFps: 12,
        scale: 1,
        smartFrameSkip: 'off',
      },
      layout: {
        format: 'RGB',
        channels: 3,
        opaque: true,
        width: 1920,
        height: 1080,
        stride: 5760,
        bytesPerFrame: 6_220_800,
      },
      prior: {
        sourceSha: 'be35f5fa89a60189475fe2ef7fd446e9fa18cef4',
        legacyWasm: { sha256: '4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22' },
      },
      candidate: {
        ownedAsset: { sha256: 'bd170496ba1f2574bd095effdc55b7cd102b203dcc347a472141fcfbd9284b0e' },
      },
      captures: [capture('prior'), capture('candidate')],
      allInputComparison: rows.map((row) => ({
        index: row.index,
        priorSha256: digest,
        candidateSha256: digest,
        samePixels: true,
        sameFrameNum: true,
        samePresentation: true,
      })),
      comparison: indices.map((index) => ({
        index,
        priorSha256: digest,
        candidateSha256: digest,
        same: true,
      })),
    };
    expect(() => assertReportName('owned-vp8-product-v8-low-inputs.json')).not.toThrow();
    expect(assertV8InputCaptureReport(report).map(({ record }) => record.build)).toEqual([
      'prior',
      'candidate',
    ]);
    const nativeTerminal = structuredClone(report);
    for (const captured of nativeTerminal.captures) captured.streamedHashes[76]!.endUs = 6_400_333;
    expect(() => assertV8InputCaptureReport(nativeTerminal)).not.toThrow();
    const wrongTerminal = structuredClone(nativeTerminal);
    for (const captured of wrongTerminal.captures) captured.streamedHashes[76]!.endUs = 6_399_499;
    expect(() => assertV8InputCaptureReport(wrongTerminal)).toThrow(/rounded terminal endpoint/);
    const midIntervalOutside = structuredClone(nativeTerminal);
    for (const captured of midIntervalOutside.captures)
      captured.streamedHashes[38]!.endUs = 6_400_500;
    expect(() => assertV8InputCaptureReport(midIntervalOutside)).toThrow(/presentation interval/);
    const outOfWindow = structuredClone(nativeTerminal);
    for (const captured of outOfWindow.captures) captured.streamedHashes[76]!.startUs = 6_400_000;
    expect(() => assertV8InputCaptureReport(outOfWindow)).toThrow(/presentation interval/);
    const timeline = rows.map((row, index) => ({
      timestampMs: row.startUs / 1000,
      holdMs: index === 76 ? 320 : 80,
    }));
    expect(() => assertV8CapturedOutputTimeline(rows, timeline)).not.toThrow();
    const shifted = structuredClone(timeline);
    shifted[38]!.holdMs += 1;
    expect(() => assertV8CapturedOutputTimeline(rows, shifted)).toThrow(/output hold differs/);
    const compressed = structuredClone(timeline);
    compressed[42]!.timestampMs += 1;
    expect(() => assertV8CapturedOutputTimeline(rows, compressed)).toThrow(
      /output timestamp differs/
    );
    expect(() =>
      assertV8InputCaptureReport({ ...report, captures: [...report.captures].reverse() })
    ).toThrow(/prior V8 capture/);
    const wrongPixels = structuredClone(report);
    wrongPixels.captures[1]!.streamedHashes[19]!.sha256 = 'b'.repeat(64);
    expect(() => assertV8InputCaptureReport(wrongPixels)).toThrow(/selected RGB hash differs/);
    const wrongPresentation = structuredClone(report);
    wrongPresentation.captures[1]!.streamedHashes[37]!.startUs += 1;
    expect(() => assertV8InputCaptureReport(wrongPresentation)).toThrow(/V8 start mismatch/);
    const missing = structuredClone(report);
    missing.captures[0]!.streamedHashes.pop();
    expect(() => assertV8InputCaptureReport(missing)).toThrow(/input count differs/);
    const aliased = structuredClone(report);
    aliased.captures[1]!.pixels[1]!.file = aliased.captures[0]!.pixels[1]!.file;
    expect(() => assertV8InputCaptureReport(aliased)).toThrow(/selected RGB path differs/);
    const duplicate = structuredClone(report);
    duplicate.captures[0]!.pixels[1]!.file = duplicate.captures[0]!.pixels[0]!.file;
    expect(() => assertV8InputCaptureReport(duplicate)).toThrow(/selected RGB path differs/);
  });
  it('accepts only the exact large admitted report basename', () => {
    expect(() => assertReportName('owned-vp8-product-large-admitted.json')).not.toThrow();
    for (const name of [
      'owned-vp8-product-large-admitted-ba.json',
      '../owned-vp8-product-large-admitted.json',
      'owned-vp8-product-large-admitted.json/other',
    ])
      expect(() => assertReportName(name)).toThrow(/Invalid report name/);
  });
  it('requires a separate large admitted candidate output and prior outcome', () => {
    const saved = { file: 'large-candidate.webp', bytes: 8, sha256: 'a'.repeat(64) };
    const decodedFrameProbe = {
      installed: true,
      outputCount: 1,
      records: [{ codedWidth: 4096, codedHeight: 2457, displayWidth: 4032, displayHeight: 2457 }],
    };
    const report = {
      samples: [],
      functional: [
        {
          build: 'candidate',
          status: 'passed',
          fixture: 'large-admitted',
          saved,
          decodedFrameProbe,
        },
      ],
      largeAdmittedCandidateStatus: 'passed',
      largeAdmittedPriorStatus: 'failed',
    };
    expect(() => assertLargeAdmittedSavedRecords(report, declaredOutputs(report))).not.toThrow();
    expect(() =>
      assertLargeAdmittedSavedRecords(
        { ...report, largeAdmittedCandidateStatus: 'failed' },
        declaredOutputs(report)
      )
    ).toThrow(/candidate did not pass/);
    const wrong = {
      ...report,
      functional: [{ build: 'candidate', status: 'passed', fixture: 'near-cap', saved }],
    };
    expect(() => assertLargeAdmittedSavedRecords(wrong, declaredOutputs(wrong))).toThrow(
      /scene contract/
    );
    const missingProbe = {
      ...report,
      functional: [{ build: 'candidate', status: 'passed', fixture: 'large-admitted', saved }],
    };
    expect(() =>
      assertLargeAdmittedSavedRecords(missingProbe, declaredOutputs(missingProbe))
    ).toThrow(/observer is absent/);
    const failedPrior = {
      ...report,
      functional: [
        {
          build: 'prior',
          status: 'failed',
          fixture: 'large-admitted',
          saved: { ...saved, file: 'prior.webp' },
        },
        report.functional[0]!,
      ],
    };
    expect(() =>
      assertLargeAdmittedSavedRecords(failedPrior, declaredOutputs(failedPrior))
    ).not.toThrow();
    const relabeled = {
      ...failedPrior,
      functional: [{ ...failedPrior.functional[0]!, status: 'passed' }, report.functional[0]!],
    };
    expect(() => assertLargeAdmittedSavedRecords(relabeled, declaredOutputs(relabeled))).toThrow(
      /requirement status differs/
    );
  });
  it('requires near-cap candidate output and its full-scene fixture marker', () => {
    const saved = { file: 'candidate.webp', bytes: 8, sha256: 'a'.repeat(64) };
    const report = {
      samples: [],
      functional: [{ build: 'candidate', status: 'passed', fixture: 'near-cap', saved }],
      nearCapCandidateStatus: 'passed',
      nearCapPriorStatus: 'failed',
    };
    expect(() => assertNearCapSavedRecords(report, declaredOutputs(report))).not.toThrow();
    const withoutMarker = { ...report, functional: [{ build: 'candidate', saved }] };
    expect(() => assertNearCapSavedRecords(withoutMarker, declaredOutputs(withoutMarker))).toThrow(
      /scene contract/
    );
    expect(() =>
      assertNearCapSavedRecords(
        { ...report, nearCapCandidateStatus: 'failed' },
        declaredOutputs(report)
      )
    ).toThrow(/candidate did not pass/);
  });
  it('classifies every independently decoded cluster pixel and exposes a mixed frame', () => {
    const solid = new RgbaFrameCollector(2, 1, 1, true);
    solid.accept(Buffer.from([255, 0, 0, 255, 255, 0, 0, 255]));
    expect(solid.finish()[0]).toMatchObject({ scene: 'red', scenePixelCount: 2, totalPixels: 2 });
    const mixed = new RgbaFrameCollector(2, 1, 1, true);
    mixed.accept(Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]));
    expect(mixed.finish()[0]).toMatchObject({ scenePixelCount: 1, totalPixels: 2 });
  });
  it('reads PowerShell UTF-8 BOM metadata while preserving its exact receipt digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vp8-bom-receipt-'));
    try {
      const path = join(root, 'result.json');
      await writeFile(path, '\uFEFF{"status":"passed"}\r\n', 'utf8');
      expect(await readMetadata(path)).toEqual({
        value: { status: 'passed' },
        sha256: '8dff0e2036bae5ab4238c518bbdd4bf9d504b71e2c2053abf6010fdc3b10f59b',
      });
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('extracts odd-padded VP8 payloads into exact millisecond IVF frame boundaries', async () => {
    const bytes = animation(frame(83), frame(167));
    const { parsed, frames } = extractVp8Frames(bytes);
    expect(parsed.totalDurationMs).toBe(250);
    expect(frames.map((entry) => [entry.timestampMs, entry.holdMs, entry.payload.length])).toEqual([
      [0, 83, 11],
      [83, 167, 11],
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'wmc-animation-'));
    try {
      const path = join(directory, 'frames.ivf');
      const { buffer, ...identity } = await writeIvf(path, 2, 1, frames);
      const ivf = await readFile(path);
      expect(buffer.equals(ivf)).toBe(true);
      expect(identity).toEqual({
        bytes: ivf.length,
        sha256: '2c797b70a9b70ab8d7f6b3871926ecbc0ee1259d2e3b4a94f1b1daedc74305cd',
      });
      expect(ivf.toString('ascii', 0, 4)).toBe('DKIF');
      expect(ivf.readUInt32LE(16)).toBe(1000);
      expect(ivf.readUInt32LE(20)).toBe(1);
      expect(ivf.readUInt32LE(24)).toBe(2);
      expect(ivf.readUInt32LE(32)).toBe(11);
      expect(ivf.readBigUInt64LE(36)).toBe(0n);
      expect(ivf.readUInt32LE(55)).toBe(11);
      expect(ivf.readBigUInt64LE(59)).toBe(83n);
      expect(ivf.length).toBe(78);
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(writeIvf(path, 2, 1, frames)).rejects.toMatchObject({ code: 'EEXIST' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps decoder stdin bound to verified IVF bytes after its file path changes', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wmc-private-verifier-'));
    const directory = join(parent, 'new-output');
    try {
      await createPrivateOutputDirectory(directory);
      if (process.platform !== 'win32') expect((await stat(directory)).mode & 0o777).toBe(0o700);
      await expect(createPrivateOutputDirectory(directory)).rejects.toMatchObject({
        code: 'EEXIST',
      });
      const path = join(directory, 'frames.ivf');
      const { buffer, sha256 } = await writeIvf(
        path,
        2,
        1,
        extractVp8Frames(animation(frame(83))).frames
      );
      await rename(path, join(directory, 'original.ivf'));
      await writeFile(path, 'replacement', { flag: 'wx', mode: 0o600 });
      const delivered: Buffer[] = [];
      const sink = new Writable({
        write(part: Buffer, _encoding, done) {
          delivered.push(Buffer.from(part));
          done();
        },
      });
      await pipeline(Readable.from(ivfChunks(buffer)), sink);
      expect(Buffer.concat(delivered).equals(buffer)).toBe(true);
      expect(buffer.equals(await readFile(path))).toBe(false);
      expect(sha256).toBe('87e686ea97fd333b49bf1a03e584d12ed5ac79f14db0f36f8b97becb2432c766');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects linked evidence and a path replaced after its descriptor was opened', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vp8-file-identity-'));
    const path = join(root, 'saved.webp');
    const previous = join(root, 'previous.webp');
    const replacement = join(root, 'replacement.webp');
    const linked = join(root, 'linked.webp');
    try {
      await writeFile(path, 'content', { flag: 'wx', mode: 0o600 });
      await writeFile(replacement, 'content', { flag: 'wx', mode: 0o600 });
      await symlink(path, linked);
      await expect(readStableFile(linked, 32, 7, 'Saved output')).rejects.toBeDefined();
      const handle = await open(path, 'r');
      try {
        await rename(path, previous);
        // Replace the checked name atomically; do not reopen it to build the fixture.
        await rename(replacement, path);
        await expect(readOpenedFile(path, handle, 32, 7, 'Saved output')).rejects.toThrow(
          /changed identity/
        );
      } finally {
        await handle.close();
      }
      await expect(readStableFile(path, 32, 6, 'Saved output')).rejects.toThrow(/size differs/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects truncated child boundaries, non-keyframe payloads, and partial or extra raw frames', () => {
    const valid = animation(frame(83));
    const truncated = Buffer.from(valid);
    // The VP8 child length at offset 72 must remain inside its ANMF parent.
    truncated.writeUInt32LE(1000, 72);
    expect(() => extractVp8Frames(truncated)).toThrow(/child escapes frame/);
    expect(() => extractVp8Frames(animation(frame(83, 2, 1, 0x11)))).toThrow(/keyframe/);
    const collector = new RgbaFrameCollector(2, 1, 1);
    collector.accept(Buffer.alloc(7));
    expect(() => collector.finish()).toThrow(/partial RGBA frame/);
    collector.accept(Buffer.alloc(1));
    expect(collector.finish()).toHaveLength(1);
    expect(() => collector.accept(Buffer.alloc(1))).toThrow(/extra RGBA bytes/);
  });

  it('takes only declared saved sites and deduplicates repeated identities', () => {
    const saved = { file: 'one.webp', bytes: 10, sha256: 'a'.repeat(64) };
    const report = {
      samples: [{ saved, build: 'prior' }],
      functional: [
        {
          valid: { saved },
          activeStop: { recovery: { saved: { ...saved } } },
          injectedTrap: { explicitUserRetry: { saved: { ...saved } } },
        },
      ],
      unrelated: { saved: { file: 'ignored.webp', bytes: 1, sha256: 'b'.repeat(64) } },
    };
    expect(declaredOutputs(report)).toHaveLength(1);
    expect(() =>
      declaredOutputs({ ...report, samples: [{ saved: { ...saved, bytes: 11 } }] })
    ).toThrow(/Repeated saved identity differs/);
    expect(() =>
      declaredOutputs({
        ...report,
        functional: [{ injectedTrap: { explicitUserRetry: { saved: { ...saved, bytes: 11 } } } }],
      })
    ).toThrow(/Repeated saved identity differs/);
  });

  it('includes only the explicit controlled retry site and rejects a missing saved identity', () => {
    const saved = { file: 'sample.webp', bytes: 10, sha256: 'a'.repeat(64) };
    const retry = { file: 'retry.webp', bytes: 12, sha256: 'b'.repeat(64) };
    const report = {
      samples: [{ saved }],
      functional: [{ injectedTrap: { explicitUserRetry: { saved: retry } } }],
      unrelated: { saved: { file: 'ignored.webp', bytes: 1, sha256: 'c'.repeat(64) } },
    };
    expect(
      declaredOutputs(report).map(({ origin, record }) => [origin, record.saved.file])
    ).toEqual([
      ['samples[0]', 'sample.webp'],
      ['functional[0].injectedTrap.explicitUserRetry', 'retry.webp'],
    ]);
    expect(() =>
      declaredOutputs({ ...report, functional: [{ injectedTrap: { explicitUserRetry: {} } }] })
    ).toThrow(/Controlled trap retry has no saved identity/);
  });
});
