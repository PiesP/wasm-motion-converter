#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Rebuild the shipped VP8 software encoder from a closed source set. */
import { deepStrictEqual } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  assertPinnedToolchain,
  pinnedCargoEnvironment,
  readOpenedRegularFile,
} from './build-gif-scalar-wasm.ts';

const root = resolve(import.meta.dirname, '../..');
const crate = join(root, 'crates/owned-vp8');
const output = join(crate, 'owned-vp8.wasm');
const provenance = join(crate, 'wasm-provenance.json');
const compiler = '1.100.0';
const compilerCommit = '0ef1bc386059596dada8fb65b50425aab2ea637a';
const target = 'wasm32-unknown-unknown';
const cargoArgs = [
  'build',
  '--release',
  '--target',
  target,
  '--locked',
  '--offline',
  '--features',
  'activity-allocation',
];
const maxLinearBytes = 192 * 1024 * 1024;
const maximumRawBytes = 482_273;
const maximumGzipBytes = 184_377;
const rustflags =
  '-C link-arg=--export-memory -C target-feature=+simd128,-relaxed-simd -C link-arg=--max-memory=201326592';
const pathRemapping = { checkout: '/wmc', rustLibrary: `/rustc/${compilerCommit}` };
const manifestSha = 'ac6f79bca9f586a4fae7dceb6b808c7332c95404df6d6199537d62ed0e116be8';
const lockSha = 'cc03cead7fdcd8a393696571a65db032193f1a9c4a6fd0102f1307c2ffda44b0';
const requiredExports = [
  'vp8_v2_abi_version',
  'vp8_v2_request_ptr',
  'vp8_v2_response_ptr',
  'vp8_v2_plan',
  'vp8_v2_reserve_step',
  'vp8_v2_begin',
  'vp8_v2_step',
  'vp8_v2_abort',
  'vp8_v2_release_input',
  'vp8_v2_release_output',
  'vp8_v2_retire',
] as const;
const wasm = (
  globalThis as typeof globalThis & {
    WebAssembly: {
      Module: {
        new (bytes: Uint8Array): object;
        imports(module: object): unknown[];
        exports(module: object): Array<{ name: string; kind: string }>;
      };
      Instance: new (module: object, imports: object) => { exports: Record<string, unknown> };
    };
  }
).WebAssembly;

function read(path: string): Buffer {
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
function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function compressedSize(bytes: Buffer): number {
  const compressed = gzipSync(bytes, { level: 9 });
  if (compressed.subarray(4, 8).some((value) => value !== 0))
    throw new Error('Owned VP8 gzip timestamp must be zero');
  return compressed.length;
}

function sourcePaths(): string[] {
  if (
    digest(read(join(crate, 'Cargo.toml'))) !== manifestSha ||
    digest(read(join(crate, 'Cargo.lock'))) !== lockSha
  )
    throw new Error('Owned VP8 Cargo inputs or zero-dependency lock changed');
  assertPinnedToolchain(read(join(crate, 'rust-toolchain.toml')).toString());
  const documentation = [
    'LICENSE.libwebp',
    'PATENTS.libwebp',
    'LICENSE.rfc6386',
    'PATENTS.rfc6386',
    'README.md',
  ];
  const allowed = new Set([
    '.gitignore',
    'Cargo.toml',
    'Cargo.lock',
    ...documentation,
    'rust-toolchain.toml',
    'src',
    'target',
    'owned-vp8.wasm',
    'wasm-provenance.json',
  ]);
  for (const entry of readdirSync(crate))
    if (!allowed.has(entry) || lstatSync(join(crate, entry)).isSymbolicLink())
      throw new Error(`Unexpected owned VP8 crate input: ${entry}`);
  for (const name of documentation)
    if (read(join(crate, name)).length > 64 * 1024)
      throw new Error(`Owned VP8 provenance input exceeds its limit: ${name}`);
  const sources = readdirSync(join(crate, 'src')).sort();
  if (
    sources.length < 1 ||
    sources.length > 64 ||
    sources.some(
      (name) => !/^[a-z][a-z0-9_]*\.rs$/.test(name) || !lstatSync(join(crate, 'src', name)).isFile()
    )
  )
    throw new Error('Owned VP8 requires a closed regular Rust source set');
  for (const name of sources) {
    const bytes = read(join(crate, 'src', name));
    if (bytes.length > 1024 * 1024 || /\binclude(?:_str|_bytes)?!\s*\(/.test(bytes.toString()))
      throw new Error('Owned VP8 source has an unrecorded include or exceeds its limit');
  }
  return [
    'crates/owned-vp8/Cargo.toml',
    'crates/owned-vp8/Cargo.lock',
    'crates/owned-vp8/rust-toolchain.toml',
    ...documentation.map((name) => `crates/owned-vp8/${name}`),
    ...sources.map((name) => `crates/owned-vp8/src/${name}`),
    'scripts/build/build-owned-vp8-wasm.ts',
    'scripts/build/build-gif-scalar-wasm.ts',
  ];
}

/** Read the actual WASM memory section before instantiating any linear memory. */
export function inspectDeclaredMemory(bytes: Uint8Array): {
  minimumBytes: number;
  maximumBytes: number;
} {
  if (
    bytes.length < 8 ||
    !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
  )
    throw new Error('Invalid owned VP8 WASM header or version');
  let at = 8;
  const integer = (): number => {
    let value = 0;
    let shift = 0;
    for (let count = 0; count < 5; count++) {
      const byte = bytes[at++];
      if (byte === undefined) throw new Error('Truncated owned VP8 WASM integer');
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) {
        if (!Number.isSafeInteger(value) || value > 0xffff_ffff)
          throw new Error('Invalid owned VP8 WASM integer');
        return value;
      }
      shift += 7;
    }
    throw new Error('Unbounded owned VP8 WASM integer');
  };
  while (at < bytes.length) {
    const section = bytes[at++];
    const size = integer();
    const end = at + size;
    if (end > bytes.length) throw new Error('Truncated owned VP8 WASM section');
    if (section === 5) {
      if (integer() !== 1 || integer() !== 1)
        throw new Error('Owned VP8 needs one unshared 32-bit bounded memory');
      const minimum = integer();
      const maximum = integer();
      if (at !== end || minimum * 65_536 > 8 * 1024 * 1024 || maximum * 65_536 !== maxLinearBytes)
        throw new Error('Owned VP8 memory declaration differs from admission policy');
      return { minimumBytes: minimum * 65_536, maximumBytes: maximum * 65_536 };
    }
    at = end;
  }
  throw new Error('Owned VP8 has no declared memory');
}

/** Validate executable syntax, imports, ABI2 and pointers before this artifact can be used. */
export function inspectOwnedVp8Wasm(bytes: Buffer): object {
  const gzipBytes = compressedSize(bytes);
  if (bytes.length > maximumRawBytes || gzipBytes > maximumGzipBytes)
    throw new Error('Owned VP8 executable byte budget exceeded');
  const memory = inspectDeclaredMemory(bytes);
  const module = new wasm.Module(bytes);
  if (wasm.Module.imports(module).length) throw new Error('Owned VP8 must not import a runtime');
  const exports = new Map(wasm.Module.exports(module).map((entry) => [entry.name, entry.kind]));
  for (const name of requiredExports)
    if (exports.get(name) !== 'function')
      throw new Error(`Owned VP8 is missing ABI2 export ${name}`);
  if (exports.get('memory') !== 'memory') throw new Error('Owned VP8 lacks owned linear memory');
  for (const name of exports.keys())
    if (name.startsWith('vp8_') && !name.startsWith('vp8_v2_'))
      throw new Error(`Owned VP8 retains an ABI1 export: ${name}`);
  const instance = new wasm.Instance(module, {});
  const api = instance.exports;
  const current = api.vp8_v2_abi_version;
  if (typeof current !== 'function' || current() !== 2)
    throw new Error('Owned VP8 ABI2 version differs');
  const memoryExport = api.memory;
  if (
    typeof memoryExport !== 'object' ||
    memoryExport === null ||
    !('buffer' in memoryExport) ||
    !(memoryExport.buffer instanceof ArrayBuffer)
  )
    throw new Error('Owned VP8 memory export is invalid');
  const actualBytes = memoryExport.buffer.byteLength;
  if (actualBytes !== memory.minimumBytes)
    throw new Error('Owned VP8 initial memory differs from its declaration');
  const request = api.vp8_v2_request_ptr;
  const response = api.vp8_v2_response_ptr;
  if (typeof request !== 'function' || typeof response !== 'function')
    throw new Error('Owned VP8 ABI2 record pointers are missing');
  const requestAt = request();
  const responseAt = response();
  if (
    !Number.isInteger(requestAt) ||
    !Number.isInteger(responseAt) ||
    requestAt <= 0 ||
    responseAt <= 0 ||
    requestAt + 12 * 4 > actualBytes ||
    responseAt + 24 * 4 > actualBytes ||
    (requestAt < responseAt + 24 * 4 && responseAt < requestAt + 12 * 4)
  )
    throw new Error('Owned VP8 ABI2 record pointers are invalid');
  return {
    sha256: digest(bytes),
    rawBytes: bytes.length,
    gzipBytes,
    gzipMethod: 'gzip level 9, mtime 0',
    initialLinearBytes: memory.minimumBytes,
    maxLinearBytes: memory.maximumBytes,
  };
}

function expected(bytes: Buffer): object {
  return {
    schemaVersion: 1,
    role: 'VP8 ABI2 software fallback for the application and conversion Worker',
    compiler,
    compilerCommit,
    target,
    cargoArgs,
    rustflags,
    pathRemapping,
    sourceSha256: Object.fromEntries(
      sourcePaths().map((path) => [path, digest(read(join(root, path)))])
    ),
    artifact: inspectOwnedVp8Wasm(bytes),
  };
}

function compile(validate?: (bytes: Buffer) => void): Buffer {
  sourcePaths();
  for (let directory = crate; ; directory = dirname(directory)) {
    if (
      existsSync(join(directory, '.cargo/config')) ||
      existsSync(join(directory, '.cargo/config.toml')) ||
      (directory !== crate && existsSync(join(directory, 'Cargo.toml')))
    )
      throw new Error('Owned VP8 refuses ambient Cargo configuration/workspaces');
    if (dirname(directory) === directory) break;
  }
  const temporary = mkdtempSync(join(tmpdir(), 'wmc-owned-vp8-'));
  let completed = false;
  try {
    const cargoEnv = pinnedCargoEnvironment(temporary);
    const env: NodeJS.ProcessEnv = { ...cargoEnv };
    for (const executable of ['rustc', 'cargo'])
      if (
        !execFileSync(executable, ['--version'], { cwd: crate, env, encoding: 'utf8' }).startsWith(
          `${executable} ${compiler} `
        )
      )
        throw new Error('Owned VP8 compiler pin differs');
    const verbose = execFileSync('rustc', ['--version', '--verbose'], {
      cwd: crate,
      env,
      encoding: 'utf8',
    });
    if (!verbose.split(/\r?\n/).includes(`commit-hash: ${compilerCommit}`))
      throw new Error('Owned VP8 compiler commit differs');
    const sysroot = execFileSync('rustc', ['--print', 'sysroot'], {
      cwd: crate,
      env,
      encoding: 'utf8',
    }).trim();
    delete env.RUSTFLAGS;
    env.CARGO_ENCODED_RUSTFLAGS = [
      ...rustflags.split(' '),
      `--remap-path-prefix=${root}=${pathRemapping.checkout}`,
      `--remap-path-prefix=${join(sysroot, 'lib/rustlib/src/rust')}=${pathRemapping.rustLibrary}`,
    ].join('\x1f');
    execFileSync('cargo', cargoArgs, { cwd: crate, env, stdio: 'inherit' });
    const bytes = read(join(cargoEnv.CARGO_TARGET_DIR, target, 'release/owned_vp8.wasm'));
    inspectOwnedVp8Wasm(bytes);
    validate?.(bytes);
    completed = true;
    return bytes;
  } finally {
    if (completed) rmSync(temporary, { recursive: true, force: true });
    else console.error(`[owned-vp8] Preserved failed compilation or comparison at ${temporary}`);
  }
}

export function buildOwnedVp8Wasm(
  mode: 'generate' | 'check' | 'verify-prebuilt' = 'verify-prebuilt'
): void {
  if (mode === 'generate') {
    const bytes = compile();
    writeFileSync(output, bytes);
    writeFileSync(provenance, `${JSON.stringify(expected(bytes), null, 2)}\n`);
  } else {
    const bytes = read(output);
    deepStrictEqual(JSON.parse(read(provenance).toString()), expected(bytes));
    if (mode === 'check')
      compile((rebuilt) => {
        if (!rebuilt.equals(bytes))
          throw new Error(
            `Owned VP8 rebuild mismatch: recorded ${digest(bytes)}, rebuilt ${digest(rebuilt)}`
          );
      });
  }
  console.log('[owned-vp8]', inspectOwnedVp8Wasm(read(output)), mode);
}
if (import.meta.main) {
  const mode = process.argv[2];
  if (
    process.argv.length > 3 ||
    ![undefined, '--generate', '--check', '--verify-prebuilt'].includes(mode)
  )
    throw new Error('Usage: build-owned-vp8-wasm.ts [--generate|--check|--verify-prebuilt]');
  buildOwnedVp8Wasm(
    mode === '--generate' ? 'generate' : mode === '--check' ? 'check' : 'verify-prebuilt'
  );
}
