import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vite-plus/test';

import { prepareNearCapFile } from '../../../scripts/test/generate-owned-vp8-near-cap.ts';

function withOutput(run: (path: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'wmc-vp8-near-cap-generator-'));
  try {
    run(join(root, 'dist-validation', 'owned-vp8-near-cap.webm'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const validate = (path: string): void => {
  if (readFileSync(path, 'utf8') !== 'expected') throw new Error('source digest differs');
};

describe('explicit near-cap generator publication', () => {
  it('publishes a verified new attempt and reuses exact existing bytes without regeneration', () => {
    withOutput((path) => {
      const generate = vi.fn((attempt: string) =>
        writeFileSync(attempt, 'expected', { flag: 'wx' })
      );
      expect(prepareNearCapFile(path, generate, validate)).toBe('generated');
      expect(readFileSync(path, 'utf8')).toBe('expected');
      expect(readdirSync(dirname(path))).toEqual(['owned-vp8-near-cap.webm']);
      expect(prepareNearCapFile(path, generate, validate)).toBe('reused');
      expect(generate).toHaveBeenCalledTimes(1);
    });
  });

  it('preserves mismatched existing bytes and a symlink target', () => {
    withOutput((path) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'wrong', { flag: 'wx' });
      const generate = vi.fn();
      expect(() => prepareNearCapFile(path, generate, validate)).toThrow(/source digest differs/);
      expect(readFileSync(path, 'utf8')).toBe('wrong');
      unlinkSync(path);
      const target = join(dirname(path), 'user-source.webm');
      writeFileSync(target, 'user bytes', { flag: 'wx' });
      symlinkSync(target, path);
      expect(() => prepareNearCapFile(path, generate, validate)).toThrow(/not a regular file/);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('user bytes');
      expect(generate).not.toHaveBeenCalled();
    });
  });

  it('retains partial attempt bytes and a diagnostic when generation fails', () => {
    withOutput((path) => {
      expect(() =>
        prepareNearCapFile(
          path,
          (attempt) => {
            writeFileSync(attempt, 'partial', { flag: 'wx' });
            throw new Error('ffmpeg failed');
          },
          validate
        )
      ).toThrow(/retained attempt/);
      const attempt = readdirSync(dirname(path)).find((name) =>
        name.startsWith('.owned-vp8-near-cap-attempt-')
      );
      expect(attempt).toBeDefined();
      expect(readFileSync(join(dirname(path), attempt!, 'near-cap.webm'), 'utf8')).toBe('partial');
      expect(
        JSON.parse(readFileSync(join(dirname(path), attempt!, 'failure.json'), 'utf8'))
      ).toMatchObject({ stage: 'generate', error: 'Error: ffmpeg failed' });
      expect(readdirSync(dirname(path))).toEqual([attempt]);
    });
  });

  it('cannot clobber a destination created while the private attempt is generated', () => {
    withOutput((path) => {
      expect(() =>
        prepareNearCapFile(
          path,
          (attempt) => {
            writeFileSync(attempt, 'expected', { flag: 'wx' });
            writeFileSync(path, 'racer', { flag: 'wx' });
          },
          validate
        )
      ).toThrow(/retained attempt/);
      expect(readFileSync(path, 'utf8')).toBe('racer');
      const attempt = readdirSync(dirname(path)).find((name) =>
        name.startsWith('.owned-vp8-near-cap-attempt-')
      );
      expect(attempt).toBeDefined();
      expect(readFileSync(join(dirname(path), attempt!, 'near-cap.webm'), 'utf8')).toBe('expected');
      expect(
        JSON.parse(readFileSync(join(dirname(path), attempt!, 'failure.json'), 'utf8'))
      ).toMatchObject({ stage: 'publish' });
    });
  });
});
