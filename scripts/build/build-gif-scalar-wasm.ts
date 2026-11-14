#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { deepStrictEqual } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '../..');
const crate = join(root, 'crates/gif-scalar-quantizer');
const output = join(root, 'src/services/gif-scalar-quantizer.wasm');
const provenance = join(crate, 'wasm-provenance.json');
const sourcePaths = [
  'crates/gif-scalar-quantizer/Cargo.toml',
  'crates/gif-scalar-quantizer/Cargo.lock',
  'crates/gif-scalar-quantizer/rust-toolchain.toml',
  'crates/gif-scalar-quantizer/src/lib.rs',
  'scripts/build/build-gif-scalar-wasm.ts',
] as const;
const compiler = '1.99.1';
const target = 'wasm32-unknown-unknown';
const cargoArgs = ['build', '--release', '--target', target, '--locked', '--offline'];
const rustflags = '-C link-arg=--export-memory -C target-feature=-simd128,-relaxed-simd';
const crateManifestSha = 'dc1417eb297a04391c841aec5635a97a074dc74885deb5b94c3b8b521485213f';
const cargoLockSha = 'c51878d6042db126c8210ce237011bba55b7224d8db874eeab2b588caacafccc';
const pinnedToolchain = `[toolchain]
channel = "${compiler}"
targets = ["${target}"]
profile = "minimal"
`;
const wasmRuntime = (
  globalThis as typeof globalThis & {
    WebAssembly: {
      Module: {
        new (bytes: Uint8Array): object;
        imports(module: object): Array<{ module: string; name: string; kind: string }>;
        exports(module: object): Array<{ name: string; kind: string }>;
      };
      Instance: new (module: object, imports: object) => { exports: Record<string, unknown> };
    };
  }
).WebAssembly;

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function readOpenedRegularFile(fd: number, path: string): Buffer {
  const opened = fstatSync(fd);
  const pathname = lstatSync(path);
  if (!opened.isFile() || !pathname.isFile() || !sameFile(opened, pathname)) {
    throw new Error(`GIF scalar WASM requires an unchanged regular file: ${path}`);
  }
  const bytes = readFileSync(fd);
  if (!sameFile(opened, fstatSync(fd)) || !sameFile(opened, lstatSync(path))) {
    throw new Error(`GIF scalar WASM file changed while reading: ${path}`);
  }
  return bytes;
}

function readRegularFile(path: string): Buffer {
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  );
  try {
    return readOpenedRegularFile(fd, path);
  } finally {
    closeSync(fd);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function inspectWasm(bytes: Buffer): { sha256: string; rawBytes: number; gzipBytes: number } {
  const module = new wasmRuntime.Module(bytes);
  const imports = wasmRuntime.Module.imports(module);
  if (imports.length) {
    throw new Error(`GIF scalar WASM has unexpected imports: ${JSON.stringify(imports)}`);
  }
  const exports = new Map(wasmRuntime.Module.exports(module).map((item) => [item.name, item.kind]));
  for (const [name, kind] of [
    ['memory', 'memory'],
    ['abi_version', 'function'],
    ['input_ptr', 'function'],
    ['reserve_input', 'function'],
    ['prepare_rgba', 'function'],
    ['palette_ptr', 'function'],
    ['quantize', 'function'],
    ['indices_ptr', 'function'],
    ['map_palette', 'function'],
    ['lzw_bound', 'function'],
    ['lzw_output_ptr', 'function'],
    ['lzw_encode', 'function'],
  ] as const) {
    if (exports.get(name) !== kind) throw new Error(`GIF scalar WASM missing ${kind} ${name}`);
  }
  const instance = new wasmRuntime.Instance(module, {});
  const memory = instance.exports.memory;
  if (
    typeof memory !== 'object' ||
    memory === null ||
    !('buffer' in memory) ||
    !(memory.buffer instanceof ArrayBuffer) ||
    memory.buffer.byteLength > 8 * 1024 * 1024
  ) {
    throw new Error('GIF scalar WASM must export unshared initial memory at most 8 MiB');
  }
  const gzipBytes = gzipSync(bytes).byteLength;
  if (bytes.byteLength > 128 * 1024 || gzipBytes > 48 * 1024) {
    throw new Error(
      `GIF scalar WASM byte budget exceeded: ${bytes.byteLength} raw, ${gzipBytes} gzip`
    );
  }
  return { sha256: sha256(bytes), rawBytes: bytes.byteLength, gzipBytes };
}

export function assertPinnedToolchain(contents: string): void {
  if (contents !== pinnedToolchain) {
    throw new Error('GIF scalar WASM Rust toolchain pin differs from generator');
  }
}

export function assertClosedCompilationInputs(
  projectRoot: string,
  includeExternalAncestors = false
): void {
  const checkoutRoot = resolve(projectRoot);
  const crateRoot = join(checkoutRoot, 'crates/gif-scalar-quantizer');
  if (
    !lstatSync(join(crateRoot, 'src')).isDirectory() ||
    !lstatSync(join(crateRoot, 'src/lib.rs')).isFile() ||
    readdirSync(join(crateRoot, 'src')).sort().join('\n') !== 'lib.rs'
  ) {
    throw new Error('GIF scalar WASM has unexpected Rust source inputs');
  }
  const expectedCrateEntries = [
    'Cargo.lock',
    'Cargo.toml',
    'rust-toolchain.toml',
    'src',
    'wasm-provenance.json',
  ];
  if (
    readdirSync(crateRoot)
      .filter((entry) => entry !== 'target')
      .sort()
      .join('\n') !== expectedCrateEntries.sort().join('\n') ||
    sha256(readRegularFile(join(crateRoot, 'Cargo.toml'))) !== crateManifestSha ||
    sha256(readRegularFile(join(crateRoot, 'Cargo.lock'))) !== cargoLockSha
  ) {
    throw new Error('GIF scalar WASM has unexpected Cargo inputs');
  }
  for (let directory = crateRoot; ; directory = dirname(directory)) {
    if (
      existsSync(join(directory, '.cargo/config')) ||
      existsSync(join(directory, '.cargo/config.toml'))
    ) {
      throw new Error('GIF scalar WASM has an ancestor Cargo configuration');
    }
    if (directory !== crateRoot && existsSync(join(directory, 'Cargo.toml'))) {
      throw new Error('GIF scalar WASM has an ancestor Cargo workspace');
    }
    if (
      (directory === checkoutRoot && !includeExternalAncestors) ||
      dirname(directory) === directory
    ) {
      break;
    }
  }
}

export function pinnedCargoEnvironment(
  targetDirectory: string,
  ambient: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv & { CARGO_TARGET_DIR: string } {
  // Cargo/Rust overrides can change code generation without changing these source files.
  // Keep the caller's unrelated environment (including PATH and private credentials).
  const env = Object.fromEntries(
    Object.entries(ambient).filter(
      ([key]) => !key.startsWith('CARGO') && (!key.startsWith('RUST') || key === 'RUSTUP_HOME')
    )
  );
  return {
    ...env,
    RUSTUP_TOOLCHAIN: compiler,
    RUSTFLAGS: rustflags,
    CARGO_HOME: join(targetDirectory, 'cargo-home'),
    CARGO_TARGET_DIR: join(targetDirectory, 'target'),
  };
}

function expectedProvenance(bytes: Buffer): object {
  assertClosedCompilationInputs(root);
  const toolchain = readRegularFile(join(crate, 'rust-toolchain.toml')).toString('utf8');
  assertPinnedToolchain(toolchain);
  return {
    schemaVersion: 1,
    compiler,
    target,
    cargoArgs,
    rustflags,
    sourceSha256: Object.fromEntries(
      sourcePaths.map((path) => [path, sha256(readRegularFile(join(root, path)))])
    ),
    artifact: inspectWasm(bytes),
  };
}

function verifyVendored(): Buffer {
  // The ordinary build checks commit-local consistency. Only --check proves
  // the pinned source and compiler reproduce the exact vendored bytes.
  const bytes = readRegularFile(output);
  const actual = JSON.parse(readRegularFile(provenance).toString('utf8')) as unknown;
  try {
    deepStrictEqual(actual, expectedProvenance(bytes));
  } catch {
    throw new Error('GIF scalar WASM source, binary, or provenance mismatch');
  }
  return bytes;
}

function compilePinned(): Buffer {
  // Cargo also reads configuration from directories above the checkout.
  assertClosedCompilationInputs(root, true);
  assertPinnedToolchain(readRegularFile(join(crate, 'rust-toolchain.toml')).toString('utf8'));
  const temporary = mkdtempSync(join(tmpdir(), 'wmc-gif-wasm-'));
  let completed = false;
  try {
    const env = pinnedCargoEnvironment(temporary);
    const rustc = execFileSync('rustc', ['--version'], {
      cwd: crate,
      env,
      encoding: 'utf8',
    }).trim();
    const cargo = execFileSync('cargo', ['--version'], {
      cwd: crate,
      env,
      encoding: 'utf8',
    }).trim();
    if (!rustc.startsWith(`rustc ${compiler} `) || !cargo.startsWith(`cargo ${compiler} `)) {
      throw new Error(`GIF scalar WASM compiler mismatch: ${rustc}; ${cargo}`);
    }
    execFileSync('cargo', cargoArgs, { cwd: crate, env, stdio: 'inherit' });
    const bytes = readRegularFile(
      join(env.CARGO_TARGET_DIR, target, 'release/gif_scalar_quantizer.wasm')
    );
    inspectWasm(bytes);
    completed = true;
    return bytes;
  } finally {
    if (completed) rmSync(temporary, { recursive: true, force: true });
    else console.error(`[gif-wasm] Preserved failed isolated Cargo output at ${temporary}`);
  }
}

export function buildGifScalarWasm(mode: 'verify' | 'check' | 'generate' = 'verify'): void {
  if (mode === 'generate') {
    const bytes = compilePinned();
    const manifest = `${JSON.stringify(expectedProvenance(bytes), null, 2)}\n`;
    writeFileSync(output, bytes);
    writeFileSync(provenance, manifest);
  } else {
    const vendored = verifyVendored();
    if (mode === 'check') {
      const compiled = compilePinned();
      if (!compiled.equals(vendored)) {
        throw new Error(
          `GIF scalar WASM rebuild mismatch: vendored ${sha256(vendored)}, rebuilt ${sha256(compiled)}`
        );
      }
    }
  }
  const { sha256: digest, rawBytes, gzipBytes } = inspectWasm(readRegularFile(output));
  console.log(`[gif-wasm] ${digest} ${rawBytes} raw / ${gzipBytes} gzip (${mode})`);
}

if (import.meta.main) {
  const argument = process.argv[2];
  if (
    process.argv.length > 3 ||
    (argument !== undefined && argument !== '--check' && argument !== '--generate')
  ) {
    throw new Error('Usage: build-gif-scalar-wasm.ts [--check|--generate]');
  }
  buildGifScalarWasm(
    argument === '--check' ? 'check' : argument === '--generate' ? 'generate' : 'verify'
  );
}
