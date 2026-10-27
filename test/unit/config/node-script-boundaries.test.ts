import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

const project = resolve(import.meta.dirname, '../../..');
const roots: string[] = [];
const entries = [
  'scripts/build/clean.ts',
  'scripts/build/generate-licenses.ts',
  'scripts/build/postbuild.ts',
  'scripts/check/i18n.ts',
  'scripts/release/prepare.ts',
  'scripts/release/publication-guard.ts',
  'scripts/test/generate-e2e-video.ts',
  'scripts/test/run-e2e-on-free-port.ts',
] as const;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wmc node scripts with spaces '));
  roots.push(root);
  for (const path of [
    ...entries,
    'scripts/check/run-child.ts',
    'scripts/release/published-asset.ts',
    'scripts/build/deployment-state.ts',
    'scripts/build/verify-service-worker-output.ts',
  ]) {
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
  it('checks Node ambient types against the complete script project', () => {
    const root = mkdtempSync(join(project, '.node-ambient-'));
    roots.push(root);
    const compiler = join(project, 'node_modules/typescript/bin/tsc');
    const config = join(root, 'tsconfig.json');
    const run = () =>
      spawnSync(process.execPath, [compiler, '-p', config, '--noEmit'], {
        cwd: project,
        encoding: 'utf8',
      });
    writeFileSync(
      join(root, 'node-only.ts'),
      "import { readFileSync } from 'node:fs';\nprocess.stdout.write(Buffer.from(readFileSync('package.json')).toString());\n"
    );
    writeFileSync(join(root, 'browser-only.ts'), 'document.title;\nwindow.alert("no");\n');

    const writeConfig = (files: string[], lib?: string[]) =>
      writeFileSync(
        config,
        JSON.stringify({
          extends: '../tsconfig.scripts.json',
          files,
          ...(lib ? { compilerOptions: { lib } } : {}),
        })
      );
    writeConfig(['node-only.ts']);
    const loaded = spawnSync(process.execPath, [compiler, '-p', config, '--listFilesOnly'], {
      cwd: project,
      encoding: 'utf8',
    });
    expect(loaded.status, loaded.stderr).toBe(0);
    for (const script of ['scripts/build/run-vite.ts', 'scripts/release/publication-guard.ts']) {
      expect(loaded.stdout).toContain(join(project, script));
    }
    const nodeOnly = run();
    expect(nodeOnly.status, nodeOnly.stdout + nodeOnly.stderr).toBe(0);

    writeConfig(['node-only.ts', 'browser-only.ts']);
    const browserOnly = run();
    expect(browserOnly.status).not.toBe(0);
    const diagnostics = browserOnly.stdout.trim().split('\n');
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatch(
      /browser-only\.ts\(1,1\): error TS2584: Cannot find name 'document'/
    );
    expect(diagnostics[1]).toMatch(
      /browser-only\.ts\(2,1\): error TS2304: Cannot find name 'window'/
    );

    // A disposable DOM reintroduction must make the negative fixture compile.
    writeConfig(['node-only.ts', 'browser-only.ts'], ['ES2022', 'DOM']);
    const withDom = run();
    expect(withDom.status, withDom.stdout + withDom.stderr).toBe(0);
  });

  it('checks syntax of every bundled Windows module', () => {
    const moduleRoot = join(project, 'validation/windows');
    const modules = readdirSync(moduleRoot, { recursive: true })
      .map((path) => path.toString())
      .filter((path) => /\.(?:mjs|ts)$/.test(path) && !/\.d\.[cm]?ts$/.test(path))
      .sort();
    expect(modules.length).toBeGreaterThan(0);
    for (const module of modules) {
      const path = join(moduleRoot, module);
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      expect(result.status, `${path}: ${result.stderr}`).toBe(0);
    }
  });

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
      const result = spawnSync(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', code],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            SPAWN_RECORD: join(root, 'spawned'),
            RELEASE_VERSION: 'invalid',
            npm_execpath: join(root, 'missing-package-manager.mjs'),
          },
          encoding: 'utf8',
        }
      );
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

  it('generates license text from installed runtime dependencies', () => {
    const { root, run } = fixture();
    mkdirSync(join(root, 'node_modules/sample'), { recursive: true });
    mkdirSync(join(root, 'public'));
    writeFileSync(
      join(root, 'package.json'),
      '{"type":"module","dependencies":{"sample":"1.0.0"}}'
    );
    writeFileSync(
      join(root, 'node_modules/sample/package.json'),
      '{"version":"1.0.0","license":"MIT"}'
    );
    writeFileSync(
      join(root, 'node_modules/sample/LICENSE'),
      'MIT License\nCopyright sample authors\n'
    );
    const result = run('scripts/build/generate-licenses.ts');
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'public/LICENSES.md'), 'utf8')).toContain('## sample');
    expect(readFileSync(join(root, 'public/LICENSES.md'), 'utf8')).toContain('**Version:** 1.0.0');
    const generated = readFileSync(join(root, 'public/LICENSES.md'), 'utf8');
    expect(generated).toContain('Copyright sample authors');
    expect(generated).not.toContain('respective authors');
    expect(generated).not.toContain('No patent retaliation');
    const clock = join(root, 'clock.mjs');
    for (const instant of ['2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z']) {
      writeFileSync(
        clock,
        `globalThis.Date = class extends Date { constructor() { super('${instant}'); } };`
      );
      const dated = spawnSync(
        process.execPath,
        [
          '--import',
          clock,
          '--experimental-strip-types',
          join(root, 'scripts/build/generate-licenses.ts'),
        ],
        { cwd: root, encoding: 'utf8' }
      );
      expect(dated.status, dated.stderr).toBe(0);
      expect(readFileSync(join(root, 'public/LICENSES.md'), 'utf8')).toBe(generated);
    }
  });

  it('includes the installed Vite helper owner notice when Vite is declared', () => {
    const { root, run } = fixture();
    mkdirSync(join(root, 'node_modules/sample'), { recursive: true });
    mkdirSync(join(root, 'node_modules/vite'), { recursive: true });
    mkdirSync(join(root, 'public'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: { sample: '1.0.0' },
        devDependencies: { vite: 'npm:@voidzero-dev/vite-plus-core@1.4.0' },
      })
    );
    writeFileSync(
      join(root, 'node_modules/sample/package.json'),
      '{"version":"1.0.0","license":"MIT"}'
    );
    writeFileSync(join(root, 'node_modules/sample/LICENSE'), 'Copyright runtime author\n');
    writeFileSync(
      join(root, 'node_modules/vite/package.json'),
      '{"name":"@voidzero-dev/vite-plus-core","version":"1.4.0","license":"MIT"}'
    );
    writeFileSync(
      join(root, 'node_modules/vite/LICENSE'),
      'Copyright helper author\nThird-party helper notice\n'
    );

    const result = run('scripts/build/generate-licenses.ts');
    expect(result.status, result.stderr).toBe(0);
    const generated = readFileSync(join(root, 'public/LICENSES.md'), 'utf8');
    expect(generated).toContain('## sample');
    expect(generated).toContain('## Build-generated browser helper owner');
    expect(generated).toContain('### @voidzero-dev/vite-plus-core');
    expect(generated).toContain('**Version:** 1.4.0');
    expect(generated).toContain('**Purpose:** Build-generated Vite/Rolldown browser helpers');
    expect(generated).toContain('Copyright helper author');
    expect(generated).toContain('Third-party helper notice');
  });

  it.each([
    ['missing package', null, null, 'required dependency vite'],
    ['missing name', '{"version":"1.4.0","license":"MIT"}', 'notice', 'name'],
    [
      'missing license',
      '{"name":"@voidzero-dev/vite-plus-core","version":"1.4.0"}',
      'notice',
      'license',
    ],
    [
      'missing notice',
      '{"name":"@voidzero-dev/vite-plus-core","version":"1.4.0","license":"MIT"}',
      null,
      'notice',
    ],
    [
      'empty notice',
      '{"name":"@voidzero-dev/vite-plus-core","version":"1.4.0","license":"MIT"}',
      '',
      'notice',
    ],
  ] as const)(
    'preserves prior license output for %s in required Vite helper owner',
    (_case, metadata, notice, diagnostic) => {
      const { root, run } = fixture();
      mkdirSync(join(root, 'node_modules/sample'), { recursive: true });
      mkdirSync(join(root, 'public'));
      const output = join(root, 'public/LICENSES.md');
      writeFileSync(output, 'previous valid notice\n');
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          type: 'module',
          dependencies: { sample: '1.0.0' },
          devDependencies: { vite: 'npm:@voidzero-dev/vite-plus-core@1.4.0' },
        })
      );
      writeFileSync(
        join(root, 'node_modules/sample/package.json'),
        '{"version":"1.0.0","license":"MIT"}'
      );
      writeFileSync(join(root, 'node_modules/sample/LICENSE'), 'Copyright runtime author\n');
      if (metadata !== null) {
        mkdirSync(join(root, 'node_modules/vite'));
        writeFileSync(join(root, 'node_modules/vite/package.json'), metadata);
        if (notice !== null) writeFileSync(join(root, 'node_modules/vite/LICENSE'), notice);
      }
      const result = run('scripts/build/generate-licenses.ts');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(diagnostic);
      expect(readFileSync(output, 'utf8')).toBe('previous valid notice\n');
    }
  );

  it.each([1, 0])(
    'preserves prior license output when only %i of two required packages is installed',
    (installed) => {
      const { root, run } = fixture();
      mkdirSync(join(root, 'public'));
      const output = join(root, 'public/LICENSES.md');
      writeFileSync(output, 'previous valid notice\n');
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          type: 'module',
          dependencies: { sample: '1.0.0', missing: '1.0.0' },
        })
      );
      if (installed) {
        mkdirSync(join(root, 'node_modules/sample'), { recursive: true });
        writeFileSync(
          join(root, 'node_modules/sample/package.json'),
          JSON.stringify({ version: '1.0.0', license: 'MIT' })
        );
        writeFileSync(join(root, 'node_modules/sample/LICENSE'), 'MIT License\nCopyright sample\n');
      }
      const result = run('scripts/build/generate-licenses.ts');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('required dependency');
      expect(readFileSync(output, 'utf8')).toBe('previous valid notice\n');
    }
  );

  it.each([
    ['invalid JSON', '{', 'MIT License', 'sample'],
    ['missing version', '{"license":"MIT"}', 'MIT License', 'version'],
    ['missing license', '{"version":"1.0.0"}', 'MIT License', 'license'],
    ['unknown license', '{"version":"1.0.0","license":"Unknown"}', 'MIT License', 'license'],
    ['missing notice', '{"version":"1.0.0","license":"MIT"}', null, 'notice'],
    ['empty notice', '{"version":"1.0.0","license":"MIT"}', '', 'notice'],
  ] as const)(
    'rejects %s without replacing prior license output',
    (_case, metadata, notice, diagnostic) => {
      const { root, run } = fixture();
      mkdirSync(join(root, 'public'));
      mkdirSync(join(root, 'node_modules/sample'), { recursive: true });
      const output = join(root, 'public/LICENSES.md');
      writeFileSync(output, 'previous valid notice\n');
      writeFileSync(
        join(root, 'package.json'),
        '{"type":"module","dependencies":{"sample":"1.0.0"}}'
      );
      writeFileSync(join(root, 'node_modules/sample/package.json'), metadata);
      if (notice !== null) writeFileSync(join(root, 'node_modules/sample/LICENSE'), notice);
      const result = run('scripts/build/generate-licenses.ts');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(diagnostic);
      expect(readFileSync(output, 'utf8')).toBe('previous valid notice\n');
    }
  );

  it('deduplicates build output and validates references while rejecting inline or external scripts', () => {
    const { root, run } = fixture();
    mkdirSync(join(root, 'dist/assets'), { recursive: true });
    mkdirSync(join(root, 'public'));
    mkdirSync(join(root, 'worker'));
    const workerSource = 'self.addEventListener("fetch", () => {});\n';
    writeFileSync(join(root, 'worker/service-worker.ts'), workerSource);
    const workerHash = createHash('sha256').update(workerSource).digest('hex');
    writeFileSync(
      join(root, 'dist/service-worker.js'),
      `/* dropconvert-worker-source-sha256:${workerHash} */\nself.addEventListener("fetch",()=>{});`
    );
    writeFileSync(join(root, 'public/_headers'), '/*\n  X-Content-Type-Options: nosniff\n');
    writeFileSync(
      join(root, 'dist/index.html'),
      '<script type="module" src="/assets/app.js"></script>'
    );
    writeFileSync(join(root, 'dist/assets/a.wasm'), 'same');
    writeFileSync(join(root, 'dist/assets/b.wasm'), 'same');
    writeFileSync(join(root, 'dist/assets/app.js'), 'fetch("/assets/b.wasm")');
    writeFileSync(join(root, 'dist/test-video-sample.mp4'), 'omit');
    const result = run('scripts/build/postbuild.ts');
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'dist/assets/app.js'), 'utf8')).toContain('/assets/a.wasm');
    expect(existsSync(join(root, 'dist/assets/b.wasm'))).toBe(false);
    expect(existsSync(join(root, 'dist/test-video-sample.mp4'))).toBe(false);
    writeFileSync(
      join(root, 'dist/index.html'),
      '<script src="https://static.cloudflareinsights.com/beacon.min.js"></script>'
    );
    const external = run('scripts/build/postbuild.ts');
    expect(external.status).not.toBe(0);
    expect(external.stderr).toContain('External provider/CDN scripts are forbidden');
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
    // The short-tail generator rewrites real MP4 timing boxes after encoding.
    const box = (type: string, ...contents: Buffer[]): Buffer => {
      const body = Buffer.concat(contents);
      const header = Buffer.alloc(8);
      header.writeUInt32BE(body.length + 8);
      header.write(type, 4, 'ascii');
      return Buffer.concat([header, body]);
    };
    const clock = Buffer.alloc(24);
    clock.writeUInt32BE(1000, 12);
    clock.writeUInt32BE(1, 16);
    const track = Buffer.alloc(24);
    track.writeUInt32BE(1, 20);
    const timing = Buffer.alloc(16);
    timing.writeUInt32BE(1, 4);
    timing.writeUInt32BE(1, 8);
    timing.writeUInt32BE(1, 12);
    const edit = Buffer.alloc(20);
    edit.writeUInt32BE(1, 4);
    edit.writeUInt32BE(1, 8);
    const mp4Path = join(root, 'singleton.mp4');
    writeFileSync(
      mp4Path,
      box(
        'moov',
        box('mvhd', clock),
        box(
          'trak',
          box('tkhd', track),
          box('edts', box('elst', edit)),
          box('mdia', box('mdhd', clock), box('minf', box('stbl', box('stts', timing))))
        )
      )
    );
    const mkvPath = join(root, 'metadata.mkv');
    const mkvBytes = Buffer.concat([
      Buffer.from([0x12, 0x54, 0xc3, 0x67]),
      Buffer.from('fixture-artist'),
      Buffer.alloc(128, 0x61),
      Buffer.from([0x1f, 0x43, 0xb6, 0x75]),
    ]);
    writeFileSync(mkvPath, mkvBytes);
    const fragmentedPath = join(root, 'fragmented.mp4');
    const fragmentsWithoutIndex = Buffer.concat([
      box('ftyp', Buffer.from('isom')),
      box('moof', Buffer.alloc(0)),
      box('mdat', Buffer.from('one')),
      box('moof', Buffer.alloc(0)),
      box('mdat', Buffer.from('two')),
    ]);
    writeFileSync(
      fragmentedPath,
      Buffer.concat([fragmentsWithoutIndex, box('mfra', Buffer.from('index'))])
    );
    stub(
      join(bin, 'ffmpeg'),
      'for last do :; done\ncase "$last" in\n*short-tail.mp4) cp "$FAKE_MP4" "$last" ;;\n*fragmented-no-index.mp4) cp "$FAKE_FRAGMENTS" "$last" ;;\n*matroska-metadata.mkv) cp "$FAKE_MKV" "$last" ;;\n*) printf video > "$last" ;;\nesac'
    );
    stub(
      join(bin, 'ffprobe'),
      `for last do :; done
case "$last" in
*matroska-metadata.mkv)
  if [ "$FAKE_MKV_METADATA" = missing ]; then
    printf '%s\\n' '{"format":{"tags":{}},"streams":[]}'
  else
    printf '%s\\n' '{"format":{"tags":{"title":"matroska-skip","ARTIST":"fixture-artist"}},"streams":[{"codec_type":"attachment","tags":{"mimetype":"text/plain"}}]}'
  fi ;;
*) printf '%s\\n' '{"streams":[{"has_b_frames":1}],"packets_and_frames":[{"type":"packet","pts":2,"dts":0},{"type":"packet","pts":1,"dts":1},{"type":"frame","pict_type":"B"}]}' ;;
esac`
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      PREPARE_RESOURCE_FIXTURES: 'false',
      FAKE_MP4: mp4Path,
      FAKE_FRAGMENTS: fragmentedPath,
      FAKE_MKV: mkvPath,
      FAKE_MKV_METADATA: 'present',
    };
    const result = run('scripts/test/generate-e2e-video.ts', env);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'public/test-video-contract-bframes.mp4'), 'utf8')).toBe(
      'video'
    );
    expect(readFileSync(join(root, 'public/test-video-contract-fragmented-no-index.mp4'))).toEqual(
      fragmentsWithoutIndex
    );
    expect(readFileSync(join(root, 'public/test-video-matroska-metadata.mkv'))).toEqual(mkvBytes);
    expect(existsSync(join(root, 'public/test-video-matroska-metadata.mkv.attachment.txt'))).toBe(
      false
    );
    const shortTail = readFileSync(join(root, 'public/test-video-contract-short-tail.mp4'));
    const sttsType = shortTail.indexOf(Buffer.from('stts'));
    expect(shortTail.readUInt32BE(sttsType + 16)).toBe(10);
    expect(existsSync(join(root, 'public/test-video-contract-rotate-90.mp4.unrotated.mp4'))).toBe(
      false
    );
    const missingMetadata = run('scripts/test/generate-e2e-video.ts', {
      ...env,
      FAKE_MKV_METADATA: 'missing',
    });
    expect(missingMetadata.status).not.toBe(0);
    expect(missingMetadata.stderr).toContain('Matroska fixture lacks its tag or attachment');
    writeFileSync(mkvPath, Buffer.alloc(0));
    const emptyMatroska = run('scripts/test/generate-e2e-video.ts', env);
    expect(emptyMatroska.status).not.toBe(0);
    expect(emptyMatroska.stderr).toContain('Generated an empty E2E codec fixture');
    stub(join(bin, 'ffmpeg'), 'exit 7');
    const failed = run('scripts/test/generate-e2e-video.ts', env);
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('ffmpeg failed to generate');
  });

  it('closes the allocated port and propagates the package script exit status', () => {
    const { root, run } = fixture();
    const packageManager = join(root, 'fake-manager.mjs');
    writeFileSync(
      packageManager,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.FAKE_RESULT, JSON.stringify({ argv: process.argv.slice(2), port: process.env.PLAYWRIGHT_DEV_PORT }));\nprocess.exitCode = 7;\n`
    );
    const result = run('scripts/test/run-e2e-on-free-port.ts', {
      ...process.env,
      npm_execpath: packageManager,
      FAKE_RESULT: join(root, 'result.json'),
    });
    expect(result.status).toBe(7);
    const recorded = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')) as {
      argv: string[];
      port: string;
    };
    expect(recorded.argv).toEqual(['test:e2e:ci']);
    expect(Number(recorded.port)).toBeGreaterThan(0);
    const missing = run('scripts/test/run-e2e-on-free-port.ts', {
      ...process.env,
      npm_execpath: '',
    });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('npm_execpath is required');
  });
});
