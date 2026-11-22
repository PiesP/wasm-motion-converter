import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
  excludeDeclaredPrivateInput,
  matchesOpenedPrivateInput,
  postbuild,
} from '../../../scripts/build/postbuild';
import { replacedApp } from '../../../tooling/vite/plugins/emit-service-worker';

const project = resolve(import.meta.dirname, '../../..');
const roots: string[] = [];
const entries = [
  'scripts/build/clean.ts',
  'scripts/build/generate-licenses.ts',
  'scripts/build/postbuild.ts',
  'scripts/check/i18n.ts',
  'scripts/test/generate-e2e-video.ts',
  'scripts/test/run-e2e-on-free-port.ts',
] as const;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wmc node scripts with spaces '));
  roots.push(root);
  for (const path of [
    ...entries,
    'scripts/check/run-child.ts',
    'scripts/build/deployment-state.ts',
    'src/utils/build-date.ts',
    'scripts/build/verify-service-worker-output.ts',
    'tooling/vite/plugins/emit-service-worker.ts',
    'scripts/build/heroicons-v1-LICENSE.txt',
    'scripts/build/heroicons-v2-LICENSE.txt',
    'scripts/build/modern-normalize-LICENSE.txt',
    'scripts/build/gifenc-pnn-NOTICES.txt',
    'scripts/build/gifenc-LICENSE.txt',
    'scripts/build/build-gif-scalar-wasm.ts',
    'validation/windows/gif-quantization-owner-video.json',
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(project, path), join(root, path));
  }
  mkdirSync(join(root, 'node_modules/@babel'), { recursive: true });
  symlinkSync(
    join(project, 'node_modules/@babel/parser'),
    join(root, 'node_modules/@babel/parser'),
    'dir'
  );
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

function copyRustNoticeInputs(root: string, names: string[]): void {
  for (const file of [
    'LICENSE',
    'public/notices/rust-1.100.0.html',
    ...names.map((name) => `crates/${name}/rust-toolchain.toml`),
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(project, file), join(root, file));
  }
}

function stub(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${contents}\n`);
  chmodSync(path, 0o755);
}

function declareSyntheticOwnerInput(root: string, bytes: Buffer): void {
  writeFileSync(
    join(root, 'validation/windows/gif-quantization-owner-video.json'),
    JSON.stringify({
      schemaVersion: 1,
      input: {
        path: 'validation/windows/private-inputs/motion-owner-video.mp4',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    })
  );
}

describe('direct Node script boundaries', () => {
  it('checks Node ambient types against the script project', () => {
    const root = mkdtempSync(join(project, 'node_modules/node-ambient-'));
    roots.push(root);
    const checker = join(project, 'node_modules/vite-plus/bin/vp');
    const source = join(root, 'probe.ts');
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ extends: '../../scripts/tsconfig.json', include: ['probe.ts'] })
    );
    const run = () =>
      spawnSync(process.execPath, [checker, 'check', '--no-fmt', '--no-lint', source], {
        cwd: project,
        encoding: 'utf8',
      });
    writeFileSync(
      source,
      "import { readFileSync } from 'node:fs';\nprocess.stdout.write(Buffer.from(readFileSync('package.json')).toString());\n"
    );
    const nodeOnly = run();
    expect(nodeOnly.status, nodeOnly.stdout + nodeOnly.stderr).toBe(0);
    expect(nodeOnly.stdout).toContain('Found no type errors in 1 file');

    writeFileSync(source, 'document.title;\nwindow.alert("no");\n');
    const browserOnly = run();
    expect(browserOnly.status).not.toBe(0);
    expect(browserOnly.stdout).toMatch(/typescript\([^)]*\):[^\n]*document/);
    expect(browserOnly.stdout).toMatch(/typescript\([^)]*\):[^\n]*window/);
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
    for (const name of ['ffmpeg', 'ffprobe'])
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

  it('keeps owned VP8 MIT, libwebp and RFC attribution without wasm-webp', () => {
    const { root, run } = fixture();
    mkdirSync(join(root, 'node_modules/sample'), { recursive: true });
    mkdirSync(join(root, 'crates/owned-vp8'), { recursive: true });
    mkdirSync(join(root, 'public'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: { sample: '1.0.0' },
        scripts: { 'build:vp8-wasm': 'build owned VP8' },
      })
    );
    writeFileSync(
      join(root, 'node_modules/sample/package.json'),
      '{"version":"1.0.0","license":"MIT"}'
    );
    writeFileSync(join(root, 'node_modules/sample/LICENSE'), 'Sample MIT notice\n');
    copyRustNoticeInputs(root, ['owned-vp8']);
    writeFileSync(join(root, 'LICENSE'), 'Owned MIT notice\n');
    writeFileSync(
      join(root, 'crates/owned-vp8/Cargo.toml'),
      '[package]\nname = "owned-vp8"\nversion = "0.1.0"\nlicense = "MIT AND BSD-3-Clause"\n'
    );
    writeFileSync(join(root, 'crates/owned-vp8/LICENSE.libwebp'), 'Pinned libwebp BSD notice\n');
    writeFileSync(join(root, 'crates/owned-vp8/PATENTS.libwebp'), 'Pinned libwebp patent grant\n');
    writeFileSync(
      join(root, 'crates/owned-vp8/LICENSE.rfc6386'),
      'Pinned reference code BSD notice\n'
    );
    writeFileSync(
      join(root, 'crates/owned-vp8/PATENTS.rfc6386'),
      'Pinned reference patent grant\n'
    );

    const output = join(root, 'public/LICENSES.md');
    const result = run('scripts/build/generate-licenses.ts');
    expect(result.status, result.stderr).toBe(0);
    const notices = readFileSync(output, 'utf8');
    expect(notices).toContain('## Owned VP8 source attribution');
    expect(notices).toContain('**License:** MIT AND BSD-3-Clause');
    expect(notices).toContain('Owned MIT notice');
    expect(notices).toContain('Pinned libwebp BSD notice');
    expect(notices).toContain('Pinned libwebp patent grant');
    expect(notices).toContain('RFC 6386');
    expect(notices).toContain('Pinned reference code BSD notice');
    expect(notices).toContain('Pinned reference patent grant');
    expect(notices).toContain('notices/rust-1.100.0.html');
    expect(notices).not.toContain('## wasm-webp');

    unlinkSync(join(root, 'crates/owned-vp8/PATENTS.libwebp'));
    const missingGrant = run('scripts/build/generate-licenses.ts');
    expect(missingGrant.status).toBe(1);
    expect(missingGrant.stderr).toContain('PATENTS.libwebp');
    expect(readFileSync(output, 'utf8')).toBe(notices);
  });

  it('ships the GIF source, toolkit and demux notices independently of npm oracles', () => {
    const { root, run } = fixture();
    const gif = 'crates/gif-scalar-quantizer';
    const distributedSource = join(root, 'public/notices/gif-source.json');
    copyRustNoticeInputs(root, ['gif-scalar-quantizer', 'owned-demux']);
    for (const file of [
      `${gif}/Cargo.toml`,
      `${gif}/LICENSE.pnn`,
      `${gif}/NOTICE.md`,
      `${gif}/Cargo.lock`,
      `${gif}/src/lib.rs`,
      `${gif}/src/lzw.rs`,
      `${gif}/src/mapper.rs`,
      `${gif}/src/palette.rs`,
      'src/services/gif-scalar-quantizer.wasm',
      'public/notices/gif-source.json',
      'public/notices/pnn-upstream-gpl-3.0.txt',
      'crates/owned-demux/Cargo.toml',
    ]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(join(project, file), join(root, file));
    }
    mkdirSync(join(root, 'node_modules/sample'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      '{"type":"module","dependencies":{"sample":"1.0.0"}}'
    );
    writeFileSync(
      join(root, 'node_modules/sample/package.json'),
      '{"version":"1.0.0","license":"MIT"}'
    );
    writeFileSync(join(root, 'node_modules/sample/LICENSE'), 'Sample license');
    const output = join(root, 'public/LICENSES.md');
    const generate = () => run('scripts/build/generate-licenses.ts');
    const result = generate();
    expect(result.status, result.stderr).toBe(0);
    const text = readFileSync(output, 'utf8');
    expect(text).toContain('src/services/owned-demux.wasm');
    expect(text).toContain('src/services/gif-scalar-quantizer.wasm');
    expect(text).toContain('notices/gif-source.json');
    expect(text).toContain('Mozilla Public License Version 2.0');
    expect(text).toContain('Copyright (c) 2017 Matt DesLauriers');
    expect(text).toContain('Kevin Weiner');
    expect(text).toContain('Historical PNN quantizer');
    expect(text).not.toContain('Development-only demux oracle');

    writeFileSync(distributedSource, '// stale');
    expect(generate().stderr).toContain('Published GIF source differs');
    copyFileSync(join(project, 'public/notices/gif-source.json'), distributedSource);
    const toolchain = join(root, 'crates/owned-demux/rust-toolchain.toml');
    writeFileSync(toolchain, '[toolchain]\nchannel = "1.101.0"\n');
    expect(generate().stderr).toContain('Review Rust standard library notices for owned-demux');
    copyFileSync(join(project, 'crates/owned-demux/rust-toolchain.toml'), toolchain);
    writeFileSync(join(root, 'public/notices/rust-1.100.0.html'), 'unverified notice');
    expect(generate().stderr).toContain('Rust standard library notice digest mismatch');
    expect(readFileSync(output, 'utf8')).toBe(text);

    copyFileSync(
      join(project, 'public/notices/rust-1.100.0.html'),
      join(root, 'public/notices/rust-1.100.0.html')
    );
    rmSync(join(root, 'crates/owned-demux'), { recursive: true });
    mkdirSync(join(root, 'src/services'), { recursive: true });
    writeFileSync(join(root, 'src/services/owned-demux.wasm'), Buffer.from([0, 97, 115, 109]));
    expect(generate().stderr).toContain('crates/owned-demux/Cargo.toml');
    unlinkSync(join(root, 'src/services/owned-demux.wasm'));
    writeFileSync(
      join(root, 'package.json'),
      '{"type":"module","dependencies":{"sample":"1.0.0"},"scripts":{"build:demux-wasm":"build"}}'
    );
    expect(generate().stderr).toContain('crates/owned-demux/Cargo.toml');
    expect(readFileSync(output, 'utf8')).toBe(text);
  });

  it('retains gifenc MIT text and its source-pinned PNN attribution', () => {
    const { root, run } = fixture();
    mkdirSync(join(root, 'node_modules/gifenc/src'), { recursive: true });
    mkdirSync(join(root, 'public'));
    writeFileSync(
      join(root, 'package.json'),
      '{"type":"module","dependencies":{"gifenc":"1.0.3"}}'
    );
    const metadata = {
      version: '1.0.3',
      license: 'MIT',
      repository: { url: 'https://github.com/mattdesl/gifenc' },
    };
    const metadataPath = join(root, 'node_modules/gifenc/package.json');
    writeFileSync(metadataPath, JSON.stringify(metadata));
    writeFileSync(
      join(root, 'node_modules/gifenc/LICENSE'),
      'MIT License\nCopyright (c) 2017 Matt DesLauriers\n'
    );
    const lzwPath = 'node_modules/gifenc/src/lzwEncode.js';
    copyFileSync(join(project, lzwPath), join(root, lzwPath));
    const sourcePath = join(root, 'node_modules/gifenc/src/pnnquant2.js');
    const source = `// Modified from:
// https://github.com/mcychan/PnnQuant.js/blob/master/src/pnnquant.js

/* Fast pairwise nearest neighbor based algorithm for multilevel thresholding
Copyright (C) 2004-2019 Mark Tyler and Dmitry Groshev
Copyright (c) 2018-2021 Miller Cy Chan
* error measure; time used is proportional to number of bins squared - WJ */

export const quantize = () => {};
`;
    writeFileSync(sourcePath, source);
    const output = join(root, 'public/LICENSES.md');
    const generated = run('scripts/build/generate-licenses.ts');
    expect(generated.status, generated.stderr).toBe(0);
    const notices = readFileSync(output, 'utf8');
    expect(notices).toContain('MIT License');
    expect(notices).toContain('Copyright (c) 2017 Matt DesLauriers');
    expect(notices).toContain('Copyright (C) 2004-2019 Mark Tyler and Dmitry Groshev');
    expect(notices).toContain('Copyright (c) 2018-2021 Miller Cy Chan');
    expect(notices).toContain('https://github.com/mcychan/PnnQuant.js/blob/master/src/pnnquant.js');

    writeFileSync(sourcePath, source.replace('Mark Tyler', 'Changed author'));
    const changedHeader = run('scripts/build/generate-licenses.ts');
    expect(changedHeader.status).toBe(1);
    expect(changedHeader.stderr).toContain('Review changed gifenc PNN source header');
    expect(readFileSync(output, 'utf8')).toBe(notices);

    writeFileSync(sourcePath, source);
    writeFileSync(join(root, lzwPath), '/* Changed LZW source attribution */');
    expect(run('scripts/build/generate-licenses.ts').stderr).toContain(
      'Review gifenc PNN and LZW credits'
    );
    expect(readFileSync(output, 'utf8')).toBe(notices);
    copyFileSync(join(project, lzwPath), join(root, lzwPath));
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, version: '1.0.4' }));
    const changedVersion = run('scripts/build/generate-licenses.ts');
    expect(changedVersion.status).toBe(1);
    expect(changedVersion.stderr).toContain('Review PNN attribution for the new gifenc version');
    expect(readFileSync(output, 'utf8')).toBe(notices);
  });

  it('keeps the v0.2.4 MediaBunny patch and links its original Git blob from generated notices', () => {
    const { root, run } = fixture();
    const pkg = 'node_modules/mediabunny';
    const patch = 'patches/mediabunny@1.62.1.patch';
    mkdirSync(join(root, pkg), { recursive: true });
    mkdirSync(join(root, 'public'));
    mkdirSync(join(root, 'patches'));
    copyFileSync(join(project, patch), join(root, patch));
    writeFileSync(
      join(root, 'package.json'),
      '{"type":"module","dependencies":{"mediabunny":"1.62.1"}}'
    );
    writeFileSync(join(root, pkg, 'package.json'), '{"version":"1.62.1","license":"MPL-2.0"}');
    writeFileSync(join(root, pkg, 'LICENSE'), 'Fixture license text');
    const result = run('scripts/build/generate-licenses.ts');
    expect(result.status, result.stderr).toBe(0);
    const notices = readFileSync(join(root, 'public/LICENSES.md'), 'utf8');
    expect(notices).toContain('https://registry.npmjs.org/mediabunny/-/mediabunny-1.62.1.tgz');
    expect(notices).toContain(patch);
    // This is the Git blob delivered from the v0.2.4 source commit, 6de815e3.
    expect(notices).toContain('/git/blobs/697740a86c92752f768ed982ceeb3095b74d22ee');
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
    const tailwindLicense = 'node_modules/tailwindcss/LICENSE';
    mkdirSync(dirname(join(root, tailwindLicense)), { recursive: true });
    copyFileSync(join(project, tailwindLicense), join(root, tailwindLicense));
    const noticesPath = join(root, 'dist/LICENSES.md');
    const notices = readFileSync(join(project, 'public/LICENSES.md'), 'utf8');
    writeFileSync(noticesPath, notices);
    const workerSource = 'self.addEventListener("fetch", () => {});\n';
    writeFileSync(join(root, 'worker/service-worker.ts'), workerSource);
    const workerHash = createHash('sha256').update(workerSource).digest('hex');
    const html = '<script type="module" src="/assets/app.js"></script>';
    const app = 'import("./lazy-codec.js")';
    const pin = (path: string, source: string) => ({
      path,
      size: Buffer.byteLength(source),
      sha256: createHash('sha256').update(source).digest('hex'),
    });
    const shell = {
      document: pin('/index.html', html),
      eager: [pin('/assets/app.js', app)],
      predecessorOnly: [],
      predecessorShared: [],
      replacement: {
        source: replacedApp.source,
        document: replacedApp.document,
        workers: replacedApp.workers,
        only: replacedApp.assets,
        shared: [],
      },
    };
    writeFileSync(
      join(root, 'dist/service-worker.js'),
      `/* dropconvert-worker-source-sha256:${workerHash} */\nconst __DROP_CONVERT_SHELL__=${JSON.stringify(shell)};\n${workerSource}`
    );
    writeFileSync(join(root, 'public/_headers'), '/*\n  X-Content-Type-Options: nosniff\n');
    writeFileSync(join(root, 'dist/index.html'), html);
    writeFileSync(join(root, 'dist/assets/a.wasm'), 'same');
    writeFileSync(join(root, 'dist/assets/b.wasm'), 'same');
    writeFileSync(join(root, 'dist/assets/app.js'), app);
    writeFileSync(join(root, 'dist/assets/lazy-codec.js'), 'fetch("/assets/b.wasm")');
    writeFileSync(join(root, 'dist/test-video-sample.mp4'), 'omit');
    const privateBytes = Buffer.from('synthetic-private-owner-input');
    declareSyntheticOwnerInput(root, privateBytes);
    writeFileSync(join(root, 'public/preserved-original.mp4'), privateBytes);
    mkdirSync(join(root, 'dist/nested'));
    writeFileSync(join(root, 'dist/nested/arbitrary-name.bin'), privateBytes);
    const safeBytes = Buffer.from(privateBytes);
    safeBytes[0] = 0;
    writeFileSync(join(root, 'dist/nested/safe-same-size.bin'), safeBytes);
    const result = run('scripts/build/postbuild.ts');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Excluded 1 declared private input copies');
    expect(result.stdout).not.toContain('arbitrary-name.bin');
    expect(existsSync(join(root, 'dist/nested/arbitrary-name.bin'))).toBe(false);
    expect(readFileSync(join(root, 'dist/nested/safe-same-size.bin'))).toEqual(safeBytes);
    expect(readFileSync(join(root, 'public/preserved-original.mp4'))).toEqual(privateBytes);
    expect(readFileSync(join(root, 'dist/assets/app.js'), 'utf8')).toBe(app);
    expect(readFileSync(join(root, 'dist/assets/lazy-codec.js'), 'utf8')).toContain(
      '/assets/a.wasm'
    );
    expect(existsSync(join(root, 'dist/assets/b.wasm'))).toBe(false);
    expect(existsSync(join(root, 'dist/test-video-sample.mp4'))).toBe(false);
    for (const heading of ['Tailwind CSS', 'Heroicons v1', 'Heroicons v2']) {
      // Leave the component and its license label in the delivered file but remove its terms.
      const incomplete = notices
        .split(/^## /m)
        .map((section) =>
          section.startsWith(`${heading}\n`) ? `${heading}\n\nMIT License\n\n` : section
        )
        .join('## ');
      writeFileSync(noticesPath, incomplete);
      const missing = run('scripts/build/postbuild.ts');
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain(`missing the full ${heading} notice`);
    }
    const upstreamCredit = 'Copyright (c) Jonathan Neal';
    expect(notices).toContain(upstreamCredit);
    writeFileSync(noticesPath, notices.replace(upstreamCredit, ''));
    const missingPreflightCredit = run('scripts/build/postbuild.ts');
    expect(missingPreflightCredit.status).not.toBe(0);
    expect(missingPreflightCredit.stderr).toContain('modern-normalize-LICENSE.txt');
    writeFileSync(noticesPath, notices);
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

  it('fails postbuild when an exact private copy cannot be removed', () => {
    const { root } = fixture();
    mkdirSync(join(root, 'dist'));
    const privateBytes = Buffer.from('synthetic-removal-failure');
    declareSyntheticOwnerInput(root, privateBytes);
    const copy = join(root, 'dist/arbitrary-name.bin');
    writeFileSync(copy, privateBytes);
    expect(() =>
      postbuild(root, () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      })
    ).toThrow('Declared private input exclusion failed (EACCES)');
    expect(readFileSync(copy)).toEqual(privateBytes);
    expect(existsSync(join(root, 'dist/deployment-state.json'))).toBe(false);
  });

  it('rejects a dist symlink without reading or removing its external target', () => {
    const { root } = fixture();
    mkdirSync(join(root, 'dist'));
    mkdirSync(join(root, 'public'));
    const privateBytes = Buffer.from('synthetic-symlink-target');
    declareSyntheticOwnerInput(root, privateBytes);
    const original = join(root, 'public/preserved-original.mp4');
    writeFileSync(original, privateBytes);
    symlinkSync(original, join(root, 'dist/linked-copy.bin'));
    expect(() => excludeDeclaredPrivateInput(root, join(root, 'dist'))).toThrow(
      'Declared private input exclusion failed'
    );
    expect(readFileSync(original)).toEqual(privateBytes);
  });

  it('rejects a private candidate path replaced after its file is opened', () => {
    const { root } = fixture();
    mkdirSync(join(root, 'dist'));
    mkdirSync(join(root, 'public'));
    const bytes = Buffer.from('synthetic-opened-candidate');
    const path = join(root, 'dist/candidate.bin');
    const target = join(root, 'public/private-target');
    writeFileSync(path, bytes);
    writeFileSync(target, 'synthetic-private-target');
    const fd = openSync(path, constants.O_RDONLY);
    try {
      unlinkSync(path);
      symlinkSync(target, path);
      expect(() =>
        matchesOpenedPrivateInput(fd, path, {
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })
      ).toThrow('changed before reading');
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(target, 'utf8')).toBe('synthetic-private-target');
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
});
