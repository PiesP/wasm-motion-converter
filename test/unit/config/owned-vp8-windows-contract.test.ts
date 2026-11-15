import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { checkOwnedVp8Inputs } from '../../../scripts/check/owned-vp8-inputs.ts';
import { isWorkerRequest } from '../../../src/services/conversion-worker/guards.ts';
import {
  DIRECT_WORKER_CLUSTER_CONFIG,
  DIRECT_WORKER_OPTIONS,
  captureFailure,
  instrumentOwnedInstance,
  parseAnimatedWebp,
} from '../../../validation/windows/helpers/owned-vp8-product.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, '__wmcVp8AbiProbe');
});

const root = resolve(import.meta.dirname, '../../..');

function chunk(tag: string, body: Buffer) {
  const header = Buffer.alloc(8);
  header.write(tag, 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, Buffer.alloc(body.length & 1)]);
}

function frame(durationMs: number, width = 2, height = 1) {
  const header = Buffer.alloc(16);
  header.writeUIntLE(width - 1, 6, 3);
  header.writeUIntLE(height - 1, 9, 3);
  header.writeUIntLE(durationMs, 12, 3);
  const vp8 = Buffer.from([0x10, 0, 0, 0x9d, 0x01, 0x2a, width, 0, height, 0]);
  return chunk('ANMF', Buffer.concat([header, chunk('VP8 ', vp8)]));
}

function animation(...frames: Buffer[]) {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x02;
  vp8x.writeUIntLE(1, 4, 3); // 2 x 1 canvas
  const body = Buffer.concat([chunk('VP8X', vp8x), chunk('ANIM', Buffer.alloc(6)), ...frames]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0);
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8);
  return Buffer.concat([header, body]);
}

describe('owned VP8 Windows product contract', () => {
  it('retains bounded flat DOM, page errors, and screenshot before closing a failed page', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'wmc-vp8-failure-'));
    vi.stubGlobal('document', { documentElement: { outerHTML: 'x'.repeat(40_000) } });
    const page = {
      url: () => 'http://127.0.0.1:8787/',
      evaluate: async (callback: () => string) => callback(),
      screenshot: async () => Buffer.from('viewport screenshot'),
    } as unknown as Page;
    try {
      await captureFailure(
        page,
        directory,
        'owned-vp8-test',
        new Error('original failure'),
        Array.from({ length: 40 }, () => 'e'.repeat(600))
      );
      const report = JSON.parse(
        await readFile(resolve(directory, 'owned-vp8-test-failure.json'), 'utf8')
      ) as { error: string; dom: string; pageErrors: string[]; screenshot: { file: string } };
      expect(report.error).toBe('Error: original failure');
      expect(report.dom).toHaveLength(32_768);
      expect(report.pageErrors).toHaveLength(32);
      expect(report.pageErrors.every((message) => message.length === 512)).toBe(true);
      expect(report.screenshot.file).toBe('owned-vp8-test-failure.jpg');
      expect(await readFile(resolve(directory, report.screenshot.file))).toEqual(
        Buffer.from('viewport screenshot')
      );
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('binds its direct Worker request to the generated VP9 cluster oracle and current protocol', () => {
    const oracle = JSON.parse(
      readFileSync(resolve(root, 'test/fixtures/owned-demux/oracle.json'), 'utf8')
    ) as {
      fixtures: Array<{
        id: string;
        config: Record<string, unknown>;
        duration: number;
        stats: { averagePacketRate: number };
      }>;
    };
    const cluster = oracle.fixtures.find(
      (fixture) => fixture.id === 'test-video-contract-clusters.webm'
    );
    expect(cluster).toBeDefined();
    const { description, ...config } = cluster!.config;
    expect(description).toBeNull();
    expect(DIRECT_WORKER_CLUSTER_CONFIG).toEqual(config);
    expect(DIRECT_WORKER_OPTIONS).toMatchObject({
      format: 'webp',
      quality: 'medium',
      fps: cluster!.stats.averagePacketRate,
      trimStart: 0,
      trimEnd: cluster!.duration,
      scale: 1,
      smartFrameSkip: 'off',
    });
    expect(
      isWorkerRequest({
        type: 'start',
        requestId: 'owned-vp8-direct-worker',
        inputBuffer: new ArrayBuffer(1),
        config: DIRECT_WORKER_CLUSTER_CONFIG,
        options: DIRECT_WORKER_OPTIONS,
        duration: cluster!.duration,
        framerate: cluster!.stats.averagePacketRate,
      })
    ).toBe(true);
  });

  it('registers balanced selectors with the same two deterministic fixtures and prior build', () => {
    const profile = JSON.parse(
      readFileSync(resolve(root, 'validation/windows/profile.json'), 'utf8')
    ) as {
      preparation: {
        selector_files: string[];
        scenarios: Record<
          string,
          { selector: string; required_inputs: string[]; build_commands: string[][] }
        >;
      };
      assets: string[];
    };
    for (const scenario of [
      'owned-vp8-product',
      'owned-vp8-product-ba',
      'owned-vp8-product-v8-low',
      'owned-vp8-product-v8-low-ba',
      'owned-vp8-product-v8-medium',
      'owned-vp8-product-v8-medium-ba',
      'owned-vp8-product-v8-high',
      'owned-vp8-product-v8-high-ba',
    ]) {
      const selected = profile.preparation.scenarios[scenario];
      expect(selected?.selector).toBe(`${scenario}.json`);
      expect(profile.preparation.selector_files).toContain(`${scenario}.json`);
      expect(selected?.required_inputs).toContain('validation/windows/prior-dist');
      if (scenario.includes('-v8')) {
        expect(selected?.required_inputs).toContain('validation/windows/owned-vp8-inputs');
        expect(selected?.required_inputs).toContain('validation/windows/owned-vp8-v8.json');
        expect(selected?.build_commands).toEqual([['vp', 'run', 'build:ci']]);
      } else {
        expect(selected?.required_inputs).toContain('public/test-video-ci-h264.mp4');
        expect(selected?.required_inputs).toContain('public/test-video-contract-clusters.webm');
      }
      expect(profile.assets).toContain('validation/windows/helpers/owned-vp8-product.ts');
    }
    expect(profile.assets).toContain('validation/windows/owned-vp8-inputs');
    expect(profile.assets).not.toContain('validation/windows/owned-vp8-inputs/v8.webm');
    const buildConfig = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');
    expect(buildConfig).toMatch(
      /'build:ci':\s*\{\s*command:\s*\[\s*'vp run check:owned-vp8-inputs'/
    );
  });

  it('parses each RIFF hold in order and rejects an invalid nested geometry', () => {
    const bytes = animation(frame(83), frame(167));
    const parsed = parseAnimatedWebp(bytes);
    expect(parsed.canvas).toEqual({ width: 2, height: 1 });
    expect(parsed.frames.map((entry) => entry.durationMs)).toEqual([83, 167]);
    expect(parsed.totalDurationMs).toBe(250);
    expect(parsed.icc).toEqual({ flag: false, payload: null });
    expect(() => parseAnimatedWebp(animation(frame(83, 3, 1)))).toThrow(/geometry/);
    expect(() => parseAnimatedWebp(bytes.subarray(0, -1))).toThrow(/RIFF length/);
  });

  it('records the actual ICCP payload and requires it to agree with the VP8X flag', () => {
    const plain = animation(frame(83));
    const profile = Buffer.from('synthetic-test-profile');
    const iccp = chunk('ICCP', profile);
    const body = Buffer.concat([plain.subarray(12, 30), iccp, plain.subarray(30)]);
    const withIcc = Buffer.concat([plain.subarray(0, 12), body]);
    withIcc.writeUInt32LE(withIcc.length - 8, 4);
    withIcc[20] = 0x22;
    expect(parseAnimatedWebp(withIcc).icc).toEqual({
      flag: true,
      payload: {
        bytes: profile.length,
        sha256: createHash('sha256').update(profile).digest('hex'),
      },
    });
    const missingChunk = Buffer.from(plain);
    missingChunk[20] = 0x22;
    expect(() => parseAnimatedWebp(missingChunk)).toThrow(/ICC flag/);
    withIcc[20] = 0x02;
    expect(() => parseAnimatedWebp(withIcc)).toThrow(/ICC flag/);
  });

  it('counts only successful ABI2 begin calls from fresh owned instances', () => {
    const statuses = [10, 12, 10];
    class FakeInstance {
      exports = {
        vp8_v2_begin: () => statuses.shift(),
        vp8_v2_step: () => 11,
      };
    }
    vi.stubGlobal('WebAssembly', { Instance: FakeInstance });
    instrumentOwnedInstance();
    const instance = new WebAssembly.Instance({} as WebAssembly.Module);
    const exported = instance.exports as { vp8_v2_begin: () => number; vp8_v2_step: () => number };
    expect([exported.vp8_v2_begin(), exported.vp8_v2_begin(), exported.vp8_v2_begin()]).toEqual([
      10, 12, 10,
    ]);
    expect(exported.vp8_v2_step()).toBe(11);
    expect(Reflect.get(globalThis, '__wmcVp8AbiProbe')).toMatchObject({
      instances: 1,
      successfulBeginCalls: 2,
      beginStatusCounts: { '10': 2, '12': 1 },
      stepCalls: 1,
    });
  });

  it('injects one RuntimeError only after a real step and tracks retirement before a fresh instance', () => {
    const step = vi.fn(() => 10);
    const retire = vi.fn(() => 0);
    class FakeRuntimeError extends Error {}
    class FakeInstance {
      exports = { vp8_v2_step: step, vp8_v2_retire: retire };
    }
    vi.stubGlobal('WebAssembly', { Instance: FakeInstance, RuntimeError: FakeRuntimeError });
    instrumentOwnedInstance();
    const probe = Reflect.get(globalThis, '__wmcVp8AbiProbe') as {
      injectNextStepTrap: boolean;
      injectedErrorCount: number;
      instances: number;
      records: Array<{
        id: number;
        stepCalls: number;
        retireCalls: number;
        retireStatus: number | null;
      }>;
    };
    const first = new WebAssembly.Instance({} as WebAssembly.Module).exports as {
      vp8_v2_step: () => number;
      vp8_v2_retire: () => number;
    };
    probe.injectNextStepTrap = true;
    expect(() => first.vp8_v2_step()).toThrow(FakeRuntimeError);
    expect(step).toHaveBeenCalledTimes(1);
    expect(probe).toMatchObject({
      instances: 1,
      injectedErrorCount: 1,
      injectNextStepTrap: false,
      records: [{ id: 1, stepCalls: 1, retireCalls: 0, retireStatus: null }],
    });
    expect(first.vp8_v2_retire()).toBe(0);
    const second = new WebAssembly.Instance({} as WebAssembly.Module).exports as {
      vp8_v2_step: () => number;
      vp8_v2_retire: () => number;
    };
    expect(second.vp8_v2_step()).toBe(10);
    expect(second.vp8_v2_retire()).toBe(0);
    expect(step).toHaveBeenCalledTimes(2);
    expect(retire).toHaveBeenCalledTimes(2);
    expect(probe.records).toEqual([
      { id: 1, stepCalls: 1, retireCalls: 1, retireStatus: 0 },
      { id: 2, stepCalls: 1, retireCalls: 1, retireStatus: 0 },
    ]);
  });

  it('admits a README-only normal build and rejects extra, linked, or wrong V8 media', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'wmc-owned-vp8-inputs-'));
    const manifest = resolve(root, 'validation/windows/owned-vp8-v8.json');
    try {
      await writeFile(resolve(directory, 'README.md'), 'fixture boundary\n');
      await expect(checkOwnedVp8Inputs(directory, manifest)).resolves.toBe('readme-only');
      await writeFile(resolve(directory, 'other.webm'), 'unrelated media');
      await expect(checkOwnedVp8Inputs(directory, manifest)).rejects.toThrow(/unexpected entries/);
      await rm(resolve(directory, 'other.webm'));
      await writeFile(resolve(directory, 'v8.webm'), 'wrong bytes');
      await expect(checkOwnedVp8Inputs(directory, manifest)).rejects.toThrow(/size differs/);
      await rm(resolve(directory, 'v8.webm'));
      await symlink(resolve(directory, 'README.md'), resolve(directory, 'v8.webm'));
      await expect(checkOwnedVp8Inputs(directory, manifest)).rejects.toThrow(/ordinary file/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
