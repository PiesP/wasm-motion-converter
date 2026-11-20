import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import {
  exactSourceFrames,
  mapObservedStarts,
  parseSourceProbe,
  qualityDelta,
  rgbPsnr,
  runBoundedSyncChild,
} from '../../../scripts/test/owned-vp8-v8-quality.ts';

const ticks = Array.from({ length: 192 }, (_, index) => String(Math.round((index * 1000) / 30)));

function observed() {
  return Array.from({ length: 77 }, (_, index) => {
    const sourceIndex = index === 76 ? 191 : index * 2 + (index >= 4 ? 3 : 0);
    const startUs = Number(ticks[sourceIndex]) * 1000;
    return {
      index,
      frameNum: index,
      startUs,
      endUs: index === 76 ? 6_400_333 : startUs + 33_333,
      sha256: 'a'.repeat(64),
    };
  });
}

describe('V8 original-reference timestamp mapping', () => {
  it('maps exact rational PTS rather than an index from the frame counter or nominal cadence', () => {
    const frames = exactSourceFrames('1/1000', ticks);
    const rows = observed();
    rows[4]!.frameNum = 99;
    for (let index = 5; index < rows.length; index++) rows[index]!.frameNum = index + 95;
    const mapped = mapObservedStarts(frames, rows);
    expect(mapped).toHaveLength(77);
    expect(mapped[4]).toMatchObject({
      sourceIndex: 11,
      observedFrameNum: 99,
      sourcePtsTicks: '367',
      observedStartUs: 367_000,
    });
    expect(mapped[76]).toMatchObject({ sourceIndex: 191, observedEndUs: 6_400_333 });
  });

  it('rejects fractional microseconds, repeated PTS and an inexact observed start', () => {
    expect(() => exactSourceFrames('1/3000', ticks)).toThrow(/integral microsecond/);
    const repeated = [...ticks];
    repeated[1] = repeated[0]!;
    expect(() => exactSourceFrames('1/1000', repeated)).toThrow(
      /missing, duplicated or out of order/
    );
    const rows = observed();
    rows[4]!.startUs += 1;
    expect(() => mapObservedStarts(exactSourceFrames('1/1000', ticks), rows)).toThrow(
      /no unique ordered source PTS/
    );
  });

  it('accepts only the frozen VP9 geometry, color and decoded frame PTS shape', () => {
    const frames = ticks.map((tick) => ({
      pts: Number(tick),
      best_effort_timestamp: Number(tick),
      width: 1920,
      height: 1080,
    }));
    const stream = {
      codec_name: 'vp9',
      width: 1920,
      height: 1080,
      pix_fmt: 'yuv420p',
      color_space: 'bt709',
      color_transfer: 'bt709',
      color_primaries: 'bt709',
      start_pts: 0,
      time_base: '1/1000',
    };
    expect(parseSourceProbe({ streams: [stream], frames })[191]).toMatchObject({
      index: 191,
      ptsTicks: '6367',
      ptsUs: 6_367_000,
    });
    expect(() =>
      parseSourceProbe({
        streams: [stream],
        frames: frames.map((frame, index) =>
          index === 4 ? { ...frame, best_effort_timestamp: frame.pts + 1 } : frame
        ),
      })
    ).toThrow(/decoded frame 4 PTS differs/);
  });
});

describe('V8 RGB quality arithmetic', () => {
  it('reports MSE and finite RGB PSNR, and keeps exact equality explicit', () => {
    const reference = Uint8Array.from([0, 0, 0]);
    expect(rgbPsnr(reference, reference)).toEqual({ mse: 0, exact: true, db: null });
    const score = rgbPsnr(reference, Uint8Array.from([1, 0, 0]));
    expect(score.mse).toBeCloseTo(1 / 3);
    expect(score.db).toBeCloseTo(10 * Math.log10(65_025 * 3));
  });

  it('checks the unchanged -1 dB and -0.01 floors without averaging failures', () => {
    expect(
      qualityDelta({ exact: false, db: 30 }, { exact: false, db: 29 }, 0.9, 0.89)
    ).toMatchObject({ psnrPass: true, ssimPass: true });
    expect(
      qualityDelta({ exact: false, db: 30 }, { exact: false, db: 28.9 }, 0.9, 0.889)
    ).toMatchObject({ psnrPass: false, ssimPass: false });
    expect(
      qualityDelta({ exact: true, db: null }, { exact: false, db: 40 }, 1, 0.99)
    ).toMatchObject({ psnrPass: false, psnrDeltaDb: null, psnrRelation: 'prior-exact' });
  });
});

describe('V8 bounded child receipts', () => {
  it('retains a real timeout signal and raw pipes without assigning a synthetic exit code', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'v8-child-deadline-'));
    try {
      await expect(
        runBoundedSyncChild(
          directory,
          'deadline-test',
          process.execPath,
          [
            '-e',
            "process.stdout.write('out'); process.stderr.write('err'); setInterval(() => {}, 1000)",
          ],
          500,
          1024
        )
      ).rejects.toThrow(/deadline-test failed/);
      const status = JSON.parse(
        await readFile(join(directory, 'deadline-test.status.json'), 'utf8')
      );
      expect(status).toMatchObject({
        timedOut: true,
        code: null,
        errorCode: 'ETIMEDOUT',
        stdoutBytes: 3,
        stderrBytes: 3,
      });
      expect(status.signal).toBeTruthy();
      expect(await readFile(join(directory, 'deadline-test.stdout'), 'utf8')).toBe('out');
      expect(await readFile(join(directory, 'deadline-test.stderr'), 'utf8')).toBe('err');
      const request = JSON.parse(
        await readFile(join(directory, 'deadline-test.request.json'), 'utf8')
      );
      expect(request).toMatchObject({ timeoutMs: 500, killSignal: 'SIGKILL' });
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('does not write a failure receipt into an existing output directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'v8-existing-output-'));
    const run = join(parent, 'runtime-combined-preparation-01', 'windows-all77-ffa113-01');
    const output = join(parent, 'existing-output');
    const verification = join(
      parent,
      'runtime-combined-preparation-01',
      'all77-animation-verification-02',
      'verification.json'
    );
    try {
      await mkdir(run, { recursive: true });
      await mkdir(output);
      await writeFile(join(output, 'marker.txt'), 'original');
      const script = resolve(import.meta.dirname, '../../../scripts/test/owned-vp8-v8-quality.ts');
      const result = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          script,
          '--run',
          run,
          '--verification',
          verification,
          '--output',
          output,
          '--ffprobe',
          process.execPath,
        ],
        { encoding: 'utf8', timeout: 10_000 }
      );
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(await readdir(output)).toEqual(['marker.txt']);
      expect(await readFile(join(output, 'marker.txt'), 'utf8')).toBe('original');
    } finally {
      await rm(parent, { recursive: true });
    }
  });

  it('uses a source-map failure status without inventing completed row files', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'v8-source-failure-'));
    const run = join(parent, 'runtime-combined-preparation-01', 'windows-all77-ffa113-01');
    const output = join(parent, 'new-output');
    const verification = join(
      parent,
      'runtime-combined-preparation-01',
      'all77-animation-verification-02',
      'verification.json'
    );
    try {
      const script = resolve(import.meta.dirname, '../../../scripts/test/owned-vp8-v8-quality.ts');
      const result = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          script,
          '--run',
          run,
          '--verification',
          verification,
          '--output',
          output,
          '--ffprobe',
          process.execPath,
        ],
        { encoding: 'utf8', timeout: 10_000 }
      );
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      const failure = JSON.parse(await readFile(join(output, 'failure.json'), 'utf8'));
      expect(failure).toMatchObject({ status: 'SOURCE_MAP_FAILED', purpose: 'source-map' });
      expect(failure).not.toHaveProperty('rowArtifacts');
      expect(await readdir(output)).toEqual(['failure.json']);
    } finally {
      await rm(parent, { recursive: true });
    }
  });
});
