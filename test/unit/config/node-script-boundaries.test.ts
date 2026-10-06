import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const project = resolve(import.meta.dirname, '../../..');
const roots: string[] = [];
const entries = [
  'scripts/build/clean.ts',
  'scripts/build/generate-licenses.ts',
  'scripts/build/postbuild.ts',
  'scripts/ci/deep-check-reuse.ts',
  'scripts/check/i18n.ts',
  'scripts/release/prepare.ts',
  'scripts/release/publication-guard.ts',
  'scripts/test/generate-e2e-video.ts',
  'scripts/test/run-e2e-on-free-port.ts',
] as const;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wmc node scripts with spaces '));
  roots.push(root);
  for (const path of [...entries, 'scripts/release/legacy-state.ts']) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(project, path), join(root, path));
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module","version":"0.2.2"}\n');
  const run = (entry: string, environment: NodeJS.ProcessEnv = process.env) =>
    spawnSync(process.execPath, ['--experimental-strip-types', join(root, entry)], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
    });
  return { root, run };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stub(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${contents}\n`);
  chmodSync(path, 0o755);
}

describe('direct Node script boundaries', () => {
  it('imports all entrypoints with invalid argv without spawning, deleting, or validating CLI inputs', () => {
    const { root } = fixture();
    mkdirSync(join(root, 'dist'));
    mkdirSync(join(root, 'public'));
    writeFileSync(join(root, 'dist/sentinel'), 'preserve');
    writeFileSync(join(root, 'public/LICENSES.md'), 'preserve');
    const bin = join(root, 'bin');
    for (const name of ['tar', 'ffmpeg', 'ffprobe'])
      stub(join(bin, name), 'printf invoked >> "$SPAWN_RECORD"\nexit 91');
    for (const entry of entries) {
      const code = `process.argv[1] = '/definitely/missing/entry.ts'; await import(${JSON.stringify(join(root, entry))});`;
      const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          SPAWN_RECORD: join(root, 'spawned'),
          RELEASE_VERSION: 'invalid',
          npm_execpath: join(root, 'missing-package-manager.mjs'),
        },
        encoding: 'utf8',
      });
      expect(result.status, `${entry}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toBe('');
    }
    expect(readFileSync(join(root, 'dist/sentinel'), 'utf8')).toBe('preserve');
    expect(readFileSync(join(root, 'public/LICENSES.md'), 'utf8')).toBe('preserve');
    expect(existsSync(join(root, 'spawned'))).toBe(false);
  });

  it('keeps clean scoped to dist and the Vite cache', () => {
    const { root, run } = fixture();
    mkdirSync(join(root, 'dist'));
    mkdirSync(join(root, 'node_modules/.vite'), { recursive: true });
    mkdirSync(join(root, 'node_modules/retain'));
    expect(run('scripts/build/clean.ts').status).toBe(0);
    expect(existsSync(join(root, 'dist'))).toBe(false);
    expect(existsSync(join(root, 'node_modules/.vite'))).toBe(false);
    expect(existsSync(join(root, 'node_modules/retain'))).toBe(true);
  });

  it('recognizes a symlinked deep-check CLI entry', () => {
    const { root } = fixture();
    symlinkSync(join(root, 'scripts/ci/deep-check-reuse.ts'), join(root, 'linked-deep.ts'));
    const result = spawnSync(process.execPath, ['--experimental-strip-types', join(root, 'linked-deep.ts'), 'unknown', 'duplication'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unknown command: unknown');
  });

  it('generates license text from installed runtime dependencies', () => {
    const { root, run } = fixture();
    mkdirSync(join(root, 'node_modules/sample'), { recursive: true });
    mkdirSync(join(root, 'public'));
    writeFileSync(join(root, 'package.json'), '{"type":"module","dependencies":{"sample":"1.0.0"}}');
    writeFileSync(join(root, 'node_modules/sample/package.json'), '{"version":"1.0.0","license":"MIT"}');
    const result = run('scripts/build/generate-licenses.ts');
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'public/LICENSES.md'), 'utf8')).toContain('### sample');
    expect(readFileSync(join(root, 'public/LICENSES.md'), 'utf8')).toContain('**Version:** 1.0.0');
  });

  it('sanitizes and deduplicates build output while rejecting inline scripts', () => {
    const { root, run } = fixture();
    mkdirSync(join(root, 'dist/assets'), { recursive: true });
    writeFileSync(join(root, 'dist/index.html'), '<script src="https://static.cloudflareinsights.com/beacon.min.js"></script><script type="module" src="/assets/app.js"></script>');
    writeFileSync(join(root, 'dist/assets/a.wasm'), 'same');
    writeFileSync(join(root, 'dist/assets/b.wasm'), 'same');
    writeFileSync(join(root, 'dist/assets/app.js'), 'fetch("/assets/b.wasm")');
    writeFileSync(join(root, 'dist/test-video-sample.mp4'), 'omit');
    const result = run('scripts/build/postbuild.ts');
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'dist/index.html'), 'utf8')).not.toContain('cloudflareinsights');
    expect(readFileSync(join(root, 'dist/assets/app.js'), 'utf8')).toContain('/assets/a.wasm');
    expect(existsSync(join(root, 'dist/assets/b.wasm'))).toBe(false);
    expect(existsSync(join(root, 'dist/test-video-sample.mp4'))).toBe(false);
    writeFileSync(join(root, 'dist/index.html'), '<script>window.bad=true</script>');
    const invalid = run('scripts/build/postbuild.ts');
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain('Inline application scripts are forbidden');
  });

  it('checks matching and mismatching locale keys through the real CLI', () => {
    const { root, run } = fixture();
    mkdirSync(join(root, 'src/i18n'), { recursive: true });
    writeFileSync(join(root, 'src/i18n/en.json'), '{"hello":"Hello"}');
    writeFileSync(join(root, 'src/i18n/ko.json'), '{"hello":"안녕"}');
    expect(run('scripts/check/i18n.ts').status).toBe(0);
    writeFileSync(join(root, 'src/i18n/ko.json'), '{"bye":"안녕"}');
    const invalid = run('scripts/check/i18n.ts');
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain('missing 1 keys');
    expect(invalid.stderr).toContain('extra keys');
  });

  it('generates bounded E2E fixtures with stubbed codec tools and propagates failures', () => {
    const { root, run } = fixture();
    const bin = join(root, 'bin');
    stub(join(bin, 'ffmpeg'), 'for last do :; done\nprintf video > "$last"');
    stub(join(bin, 'ffprobe'), `printf '%s\\n' '{"streams":[{"has_b_frames":1}],"packets_and_frames":[{"type":"packet","pts":2,"dts":0},{"type":"packet","pts":1,"dts":1},{"type":"frame","pict_type":"B"}]}'`);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, PREPARE_RESOURCE_FIXTURES: 'false' };
    const result = run('scripts/test/generate-e2e-video.ts', env);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'public/test-video-contract-bframes.mp4'), 'utf8')).toBe('video');
    expect(existsSync(join(root, 'public/test-video-contract-rotate-90.mp4.unrotated.mp4'))).toBe(false);
    stub(join(bin, 'ffmpeg'), 'exit 7');
    const failed = run('scripts/test/generate-e2e-video.ts', env);
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('ffmpeg failed to generate');
  });

  it('closes the allocated port and propagates the package script exit status', () => {
    const { root, run } = fixture();
    const packageManager = join(root, 'fake-manager.mjs');
    writeFileSync(packageManager, `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.FAKE_RESULT, JSON.stringify({ argv: process.argv.slice(2), port: process.env.PLAYWRIGHT_DEV_PORT }));\nprocess.exitCode = 7;\n`);
    const result = run('scripts/test/run-e2e-on-free-port.ts', {
      ...process.env,
      npm_execpath: packageManager,
      FAKE_RESULT: join(root, 'result.json'),
    });
    expect(result.status).toBe(7);
    const recorded = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')) as { argv: string[]; port: string };
    expect(recorded.argv).toEqual(['test:e2e:ci']);
    expect(Number(recorded.port)).toBeGreaterThan(0);
    const missing = run('scripts/test/run-e2e-on-free-port.ts', { ...process.env, npm_execpath: '' });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('npm_execpath is required');
  });
});
