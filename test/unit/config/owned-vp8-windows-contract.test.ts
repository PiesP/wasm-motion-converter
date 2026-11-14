import { readFileSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { checkOwnedVp8Inputs } from '../../../scripts/check/owned-vp8-inputs.ts';
import { parseAnimatedWebp } from '../../../validation/windows/helpers/owned-vp8-product.ts';

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
      'owned-vp8-product-v8',
      'owned-vp8-product-v8-ba',
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
    expect(() => parseAnimatedWebp(animation(frame(83, 3, 1)))).toThrow(/geometry/);
    expect(() => parseAnimatedWebp(bytes.subarray(0, -1))).toThrow(/RIFF length/);
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
