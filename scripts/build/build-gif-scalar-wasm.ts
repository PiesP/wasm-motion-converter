#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '../..');
const crate = join(root, 'crates/gif-scalar-quantizer');
const source = join(crate, 'target/wasm32-unknown-unknown/release/gif_scalar_quantizer.wasm');
const output = join(root, 'src/services/gif-scalar-quantizer.wasm');
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

export function buildGifScalarWasm(): void {
  rmSync(output, { force: true });
  execFileSync(
    'cargo',
    ['build', '--release', '--target', 'wasm32-unknown-unknown', '--locked', '--offline'],
    {
      cwd: crate,
      env: {
        ...process.env,
        RUSTFLAGS: '-C link-arg=--export-memory -C target-feature=-simd128,-relaxed-simd',
      },
      stdio: 'inherit',
    }
  );
  const bytes = readFileSync(source);
  const module = new wasmRuntime.Module(bytes);
  const imports = wasmRuntime.Module.imports(module);
  if (imports.length) {
    throw new Error(`GIF scalar WASM has unexpected imports: ${JSON.stringify(imports)}`);
  }
  const exports = new Map(wasmRuntime.Module.exports(module).map((item) => [item.name, item.kind]));
  for (const [name, kind] of [
    ['memory', 'memory'],
    ['input_ptr', 'function'],
    ['reserve_input', 'function'],
    ['palette_ptr', 'function'],
    ['quantize', 'function'],
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
  const compressedBytes = gzipSync(bytes).byteLength;
  if (bytes.byteLength > 128 * 1024 || compressedBytes > 48 * 1024) {
    throw new Error(
      `GIF scalar WASM byte budget exceeded: ${bytes.byteLength} raw, ${compressedBytes} gzip`
    );
  }
  copyFileSync(source, output);
  console.log(
    `[gif-wasm] ${createHash('sha256').update(bytes).digest('hex')} ${bytes.byteLength} raw / ${compressedBytes} gzip`
  );
}

if (import.meta.main) buildGifScalarWasm();
