import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
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
  assertClosedCompilationInputs,
  assertPinnedToolchain,
  pinnedCargoEnvironment,
  readOpenedRegularFile,
} from '../../../scripts/build/build-gif-scalar-wasm';

const sourceRoot = resolve(import.meta.dirname, '../../..');
const sourcePaths = [
  'scripts/build/build-gif-scalar-wasm.ts',
  'crates/gif-scalar-quantizer/Cargo.toml',
  'crates/gif-scalar-quantizer/Cargo.lock',
  'crates/gif-scalar-quantizer/rust-toolchain.toml',
  'crates/gif-scalar-quantizer/src/lib.rs',
  'crates/gif-scalar-quantizer/wasm-provenance.json',
  'src/services/gif-scalar-quantizer.wasm',
];
const fixtures: string[] = [];

function populateFixture(root: string): void {
  for (const path of sourcePaths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(sourceRoot, path), join(root, path));
  }
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wmc-gif-bootstrap-'));
  fixtures.push(root);
  populateFixture(root);
  return root;
}

function verify(root: string): number | null {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(root, 'scripts/build/build-gif-scalar-wasm.ts')],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: join(root, 'no-compiler-on-path') },
    }
  );
  if (result.error) throw result.error;
  return result.status;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('GIF WASM source bootstrap', () => {
  it('rejects a path replaced after opening its source file', () => {
    const root = fixture();
    const source = join(root, 'crates/gif-scalar-quantizer/Cargo.lock');
    const target = join(root, 'private-target');
    writeFileSync(target, 'synthetic-private-target');
    const fd = openSync(source, constants.O_RDONLY);
    try {
      unlinkSync(source);
      symlinkSync(target, source);
      expect(() => readOpenedRegularFile(fd, source)).toThrow('unchanged regular file');
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(target, 'utf8')).toBe('synthetic-private-target');
  });

  it('ignores external Cargo state for Node verification but rejects it for regeneration', () => {
    for (const [path, contents] of [
      ['.cargo/config.toml', '[build]\nrustflags = []\n'],
      ['Cargo.toml', '[workspace]\n'],
    ] as const) {
      const outer = mkdtempSync(join(tmpdir(), 'wmc-gif-ancestor-'));
      fixtures.push(outer);
      const root = join(outer, 'checkout');
      populateFixture(root);
      mkdirSync(dirname(join(outer, path)), { recursive: true });
      writeFileSync(join(outer, path), contents);
      expect(() => assertClosedCompilationInputs(root)).not.toThrow();
      expect(verify(root)).toBe(0);
      expect(() => assertClosedCompilationInputs(root, true)).toThrow('ancestor Cargo');
    }
  });

  it('rejects undeclared Cargo sources and ancestor configuration', () => {
    const unexpected = [
      ['crates/gif-scalar-quantizer/build.rs', 'fn main() {}\n'],
      ['crates/gif-scalar-quantizer/src/extra.rs', 'pub fn extra() {}\n'],
      ['crates/gif-scalar-quantizer/.cargo/config.toml', '[build]\nrustflags = []\n'],
      ['.cargo/config', '[build]\nrustflags = []\n'],
      ['Cargo.toml', '[workspace]\n'],
    ] as const;
    for (const [path, contents] of unexpected) {
      const root = fixture();
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
      expect(() => assertClosedCompilationInputs(root)).toThrow();
      expect(verify(root)).not.toBe(0);
    }
    const root = fixture();
    appendFileSync(join(root, 'crates/gif-scalar-quantizer/Cargo.toml'), '\n[dependencies]\n');
    expect(() => assertClosedCompilationInputs(root)).toThrow('unexpected Cargo inputs');
  });

  it('requires the exact active Rust toolchain declaration', () => {
    const pinned = readFileSync(
      join(sourceRoot, 'crates/gif-scalar-quantizer/rust-toolchain.toml'),
      'utf8'
    );
    expect(() => assertPinnedToolchain(pinned)).not.toThrow();
    for (const altered of [
      pinned.replace('channel = "1.99.1"', '# channel = "1.99.1"\nchannel = "1.98.0"'),
      pinned.replace('channel = "1.99.1"', 'channel = "1.98.0"'),
      pinned.replace('channel = "1.99.1"', 'channel = "1.99.1"\nchannel = "1.98.0"'),
    ]) {
      expect(() => assertPinnedToolchain(altered)).toThrow('toolchain pin differs');
    }
  });

  it('leaves the vendored files untouched when explicit generation finds a wrong toolchain', () => {
    const root = fixture();
    const script = join(root, 'scripts/build/build-gif-scalar-wasm.ts');
    const asset = join(root, 'src/services/gif-scalar-quantizer.wasm');
    const manifest = join(root, 'crates/gif-scalar-quantizer/wasm-provenance.json');
    const originalAsset = readFileSync(asset);
    const originalManifest = readFileSync(manifest);
    writeFileSync(
      join(root, 'crates/gif-scalar-quantizer/rust-toolchain.toml'),
      '[toolchain]\nchannel = "1.98.0"\ntargets = ["wasm32-unknown-unknown"]\nprofile = "minimal"\n'
    );
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', script, '--generate'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: join(root, 'no-compiler-on-path') },
      }
    );
    if (result.error) throw result.error;
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Rust toolchain pin differs');
    expect(readFileSync(asset).equals(originalAsset)).toBe(true);
    expect(readFileSync(manifest).equals(originalManifest)).toBe(true);
  });

  it('removes ambient Cargo and Rust compiler overrides from regeneration', () => {
    const env = pinnedCargoEnvironment('/isolated', {
      PATH: '/tools',
      HOME: '/private-home',
      TASK_CREDENTIAL: 'private',
      RUSTUP_HOME: '/rustup',
      RUSTUP_TOOLCHAIN: 'nightly',
      RUSTFLAGS: '-C target-feature=+simd128',
      RUSTC_WRAPPER: '/wrapper',
      CARGO_ENCODED_RUSTFLAGS: '-C\u001ftarget-feature=+simd128',
      CARGO_PROFILE_RELEASE_OPT_LEVEL: '0',
      CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: '-C panic=unwind',
      CARGO_HOME: '/ambient-cargo',
    });
    expect(env.PATH).toBe('/tools');
    expect(env.HOME).toBe('/private-home');
    expect(env.TASK_CREDENTIAL).toBe('private');
    expect(env.RUSTUP_HOME).toBe('/rustup');
    expect(env.RUSTUP_TOOLCHAIN).toBe('1.99.1');
    expect(env.RUSTFLAGS).toBe(
      '-C link-arg=--export-memory -C target-feature=-simd128,-relaxed-simd'
    );
    expect(env.CARGO_HOME).toBe('/isolated/cargo-home');
    expect(env.CARGO_TARGET_DIR).toBe('/isolated/target');
    expect(env.RUSTC_WRAPPER).toBeUndefined();
    expect(env.CARGO_ENCODED_RUSTFLAGS).toBeUndefined();
    expect(env.CARGO_PROFILE_RELEASE_OPT_LEVEL).toBeUndefined();
    expect(env.CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS).toBeUndefined();
  });

  it('verifies the tracked source asset without Cargo or Rust on PATH', () => {
    expect(verify(fixture())).toBe(0);
  });

  it('rejects source, binary, and provenance tampering before a consuming build', () => {
    for (const path of [
      'crates/gif-scalar-quantizer/src/lib.rs',
      'src/services/gif-scalar-quantizer.wasm',
    ]) {
      const root = fixture();
      appendFileSync(join(root, path), path.endsWith('.wasm') ? Buffer.from([0]) : '\n ');
      expect(verify(root)).not.toBe(0);
    }
    const root = fixture();
    const manifest = join(root, 'crates/gif-scalar-quantizer/wasm-provenance.json');
    const provenance = JSON.parse(readFileSync(manifest, 'utf8')) as {
      artifact: { sha256: string };
    };
    provenance.artifact.sha256 = '0'.repeat(64);
    writeFileSync(manifest, JSON.stringify(provenance));
    expect(verify(root)).not.toBe(0);
  });
});
