#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Source-bound, import-free owned demux core; ordinary builds need no Rust install. */
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
const crate = join(root, 'crates/owned-demux');
const output = join(root, 'src/services/owned-demux.wasm');
const provenance = join(crate, 'wasm-provenance.json');
const compiler = '1.99.1';
const target = 'wasm32-unknown-unknown';
const cargoArgs = ['build', '--release', '--target', target, '--locked', '--offline'];
const maxLinearBytes = 64 * 1024 * 1024;
const rustflags =
  '-C link-arg=--export-memory -C target-feature=-simd128,-relaxed-simd -C link-arg=--max-memory=67108864';
const manifestSha = '934c8626a507d147f62a60053781000d1c2b080b9b2d475c0e5fb2e9ad72395d';
const lockSha = '518bba5599a091a0cc79aaa04ea5b2843e0f408191a8e6bd287d005231b6f024';
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

function sourcePaths(): string[] {
  if (
    digest(read(join(crate, 'Cargo.toml'))) !== manifestSha ||
    digest(read(join(crate, 'Cargo.lock'))) !== lockSha
  )
    throw new Error('Owned demux Cargo inputs or zero-dependency lock changed');
  assertPinnedToolchain(read(join(crate, 'rust-toolchain.toml')).toString());
  const allowed = new Set([
    '.gitignore',
    'Cargo.toml',
    'Cargo.lock',
    'rust-toolchain.toml',
    'src',
    'target',
    'wasm-provenance.json',
    'README.md',
  ]);
  for (const entry of readdirSync(crate))
    if (!allowed.has(entry) || lstatSync(join(crate, entry)).isSymbolicLink())
      throw new Error(`Unexpected owned demux crate input: ${entry}`);
  const sources = readdirSync(join(crate, 'src')).sort();
  if (
    sources.length < 1 ||
    sources.length > 64 ||
    sources.some(
      (name) => !/^[a-z][a-z0-9_]*\.rs$/.test(name) || !lstatSync(join(crate, 'src', name)).isFile()
    )
  )
    throw new Error('Owned demux requires a closed regular Rust source set');
  for (const name of sources) {
    const bytes = read(join(crate, 'src', name));
    if (bytes.length > 1024 * 1024 || /\binclude(?:_str|_bytes)?!\s*\(/.test(bytes.toString()))
      throw new Error('Owned demux source has an unrecorded include or exceeds its limit');
  }
  return [
    'crates/owned-demux/Cargo.toml',
    'crates/owned-demux/Cargo.lock',
    'crates/owned-demux/rust-toolchain.toml',
    ...sources.map((name) => `crates/owned-demux/src/${name}`),
    'scripts/build/build-owned-demux-wasm.ts',
    'scripts/build/build-gif-scalar-wasm.ts',
  ];
}

/** Inspect the declared memory bound without growing/allocating that capacity. */
function memoryMaximum(bytes: Uint8Array): void {
  let at = 8;
  const integer = (): number => {
    let value = 0,
      shift = 0;
    for (let count = 0; count < 5; count++) {
      const byte = bytes[at++];
      if (byte === undefined) throw new Error('Truncated owned demux WASM record');
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) {
        if (!Number.isSafeInteger(value) || value > 0xffff_ffff)
          throw new Error('Invalid WASM integer');
        return value;
      }
      shift += 7;
    }
    throw new Error('Unbounded owned demux WASM integer');
  };
  while (at < bytes.length) {
    const section = bytes[at++];
    const size = integer(),
      end = at + size;
    if (end > bytes.length) throw new Error('Truncated owned demux WASM section');
    if (section === 5) {
      if (integer() !== 1 || integer() !== 1)
        throw new Error('Owned demux needs one unshared fixed-width bounded memory');
      const minimum = integer(),
        maximum = integer();
      if (at !== end || minimum * 65536 > 4 * 1024 * 1024 || maximum * 65536 !== maxLinearBytes)
        throw new Error('Owned demux linear memory declaration differs from admission policy');
      return;
    }
    at = end;
  }
  throw new Error('Owned demux has no declared memory');
}

function inspect(bytes: Buffer): object {
  if (bytes.length > 256 * 1024 || gzipSync(bytes).length > 96 * 1024)
    throw new Error('Owned demux executable byte budget exceeded');
  memoryMaximum(bytes);
  const module = new wasm.Module(bytes);
  if (wasm.Module.imports(module).length) throw new Error('Owned demux must not import a runtime');
  const exports = new Map(wasm.Module.exports(module).map((entry) => [entry.name, entry.kind]));
  for (const name of [
    'demux_abi_version',
    'demux_init',
    'demux_input_ptr',
    'demux_step',
    'demux_feed',
    'demux_track',
    'demux_description_ptr',
    'demux_codec_ptr',
    'demux_packet_count',
    'demux_packet',
    'demux_prepare_packets',
    'demux_probe_vp9',
    'demux_packet_begin',
    'demux_packet_feed',
    'demux_packet_finish',
    'demux_snapshot_begin',
    'demux_snapshot_next',
    'demux_snapshot_import_begin',
    'demux_snapshot_import_feed',
    'demux_snapshot_import_step',
    'demux_release',
  ])
    if (exports.get(name) !== 'function')
      throw new Error(`Owned demux is missing ABI export ${name}`);
  if (exports.get('memory') !== 'memory') throw new Error('Owned demux lacks owned linear memory');
  const instance = new wasm.Instance(module, {});
  if (
    typeof instance.exports.demux_abi_version !== 'function' ||
    instance.exports.demux_abi_version() !== 3
  )
    throw new Error('Owned demux ABI version differs');
  return {
    sha256: digest(bytes),
    rawBytes: bytes.length,
    gzipBytes: gzipSync(bytes).length,
    maxLinearBytes,
  };
}

function expected(bytes: Buffer): object {
  return {
    schemaVersion: 1,
    compiler,
    target,
    cargoArgs,
    rustflags,
    sourceSha256: Object.fromEntries(
      sourcePaths().map((path) => [path, digest(read(join(root, path)))])
    ),
    artifact: inspect(bytes),
  };
}

function compile(): Buffer {
  sourcePaths();
  for (let directory = crate; ; directory = dirname(directory)) {
    if (
      existsSync(join(directory, '.cargo/config')) ||
      existsSync(join(directory, '.cargo/config.toml')) ||
      (directory !== crate && existsSync(join(directory, 'Cargo.toml')))
    )
      throw new Error('Owned demux refuses ambient Cargo configuration/workspaces');
    if (dirname(directory) === directory) break;
  }
  const temporary = mkdtempSync(join(tmpdir(), 'wmc-owned-demux-'));
  let completed = false;
  try {
    const env = { ...pinnedCargoEnvironment(temporary), RUSTFLAGS: rustflags };
    for (const executable of ['rustc', 'cargo'])
      if (
        !execFileSync(executable, ['--version'], { cwd: crate, env, encoding: 'utf8' }).startsWith(
          `${executable} ${compiler} `
        )
      )
        throw new Error('Owned demux compiler pin differs');
    execFileSync('cargo', cargoArgs, { cwd: crate, env, stdio: 'inherit' });
    const bytes = read(join(env.CARGO_TARGET_DIR, target, 'release/owned_demux.wasm'));
    inspect(bytes);
    completed = true;
    return bytes;
  } finally {
    if (completed) rmSync(temporary, { recursive: true, force: true });
    else console.error(`[owned-demux] Preserved failed compilation at ${temporary}`);
  }
}

export function buildOwnedDemuxWasm(mode: 'verify' | 'check' | 'generate' = 'verify'): void {
  if (mode === 'generate') {
    const bytes = compile();
    writeFileSync(output, bytes);
    writeFileSync(provenance, `${JSON.stringify(expected(bytes), null, 2)}\n`);
  } else {
    const bytes = read(output);
    deepStrictEqual(JSON.parse(read(provenance).toString()), expected(bytes));
    if (mode === 'check' && !compile().equals(bytes))
      throw new Error('Owned demux source does not reproduce the vendored core');
  }
  console.log('[owned-demux]', inspect(read(output)), mode);
}
if (import.meta.main)
  buildOwnedDemuxWasm(
    process.argv.includes('--generate')
      ? 'generate'
      : process.argv.includes('--check')
        ? 'check'
        : 'verify'
  );
