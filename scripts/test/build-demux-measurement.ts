// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

import { appAliases } from '../../tooling/vite/aliases.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const entry = resolve(root, 'validation/windows/demux-measurement-entry/index.ts');
const output = resolve(root, 'temp/owned-demux-measurement');

function git(...arguments_: string[]): string {
  return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' }).trim();
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function buildDemuxMeasurement(): Promise<void> {
  if (git('status', '--porcelain'))
    throw new Error('Demux measurement source checkout must be clean');
  const sourceSha = git('rev-parse', 'HEAD');
  // The source SHA comes from the controller's exact checkout guard. This
  // development-only bundle is never copied into the application distribution.
  await build({
    configFile: false,
    root,
    base: '/',
    mode: 'production',
    define: { __APP_SOURCE_SHA__: JSON.stringify(sourceSha) },
    resolve: { alias: appAliases },
    build: {
      target: 'es2022',
      outDir: output,
      emptyOutDir: true,
      assetsInlineLimit: 0,
      manifest: true,
      rollupOptions: {
        input: entry,
        preserveEntrySignatures: 'strict',
        output: {
          entryFileNames: 'entry.js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  });
  const assets = await readdir(resolve(output, 'assets')).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });
  const files = ['entry.js', ...assets.map((name) => `assets/${name}`)];
  const inventory = await Promise.all(
    files.map(async (path) => {
      if (!/^(?:entry\.js|assets\/[\w.-]+\.(?:js|wasm))$/.test(path))
        throw new Error(`Unexpected demux measurement artifact: ${path}`);
      const bytes = await readFile(resolve(output, path));
      if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024)
        throw new Error(`Demux measurement artifact exceeds its bound: ${path}`);
      return { path, bytes: bytes.length, sha256: sha256(bytes), base64: bytes.toString('base64') };
    })
  );
  if (!inventory.some((file) => file.path === 'entry.js'))
    throw new Error('Demux measurement entry was not emitted');
  const packageBytes = Buffer.from(`${JSON.stringify({ schema: 1, sourceSha, inventory })}\n`);
  if (packageBytes.byteLength > 4 * 1024 * 1024)
    throw new Error('Demux measurement package exceeds its byte bound');
  const validationDir = resolve(root, 'dist-validation');
  await mkdir(validationDir, { recursive: true });
  await writeFile(resolve(validationDir, 'owned-demux-measurement.json'), packageBytes);
}

if (import.meta.main) await buildDemuxMeasurement();
