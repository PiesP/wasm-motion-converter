#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP
/**
 * Finalize the static Pages distribution and its source/byte inventory.
 * Provider-side HTML injection is controlled in Pages settings, after build.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { fingerprintedAssetHeaders, writeDeploymentState } from './deployment-state.ts';
import { verifyServiceWorkerOutput } from './verify-service-worker-output.ts';

export type PrivateInputFingerprint = { bytes: number; sha256: string };

function declaredPrivateInput(root: string): PrivateInputFingerprint {
  const declaration = JSON.parse(
    readFileSync(resolve(root, 'validation/windows/gif-quantization-owner-video.json'), 'utf8')
  ) as unknown;
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
    throw new Error('Invalid declared private input');
  }
  const record = declaration as { schemaVersion?: unknown; input?: unknown };
  const input = record.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid declared private input');
  }
  const fields = input as { path?: unknown; bytes?: unknown; sha256?: unknown };
  if (
    record.schemaVersion !== 1 ||
    typeof fields.path !== 'string' ||
    !/^validation\/windows\/private-inputs\/[A-Za-z0-9._-]+\.mp4$/u.test(fields.path) ||
    typeof fields.bytes !== 'number' ||
    !Number.isSafeInteger(fields.bytes) ||
    fields.bytes <= 0 ||
    typeof fields.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(fields.sha256)
  ) {
    throw new Error('Invalid declared private input');
  }
  return { bytes: fields.bytes, sha256: fields.sha256 };
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function matchesPrivateInput(path: string, expected: PrivateInputFingerprint): boolean {
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  );
  try {
    return matchesOpenedPrivateInput(fd, path, expected);
  } finally {
    closeSync(fd);
  }
}

export function matchesOpenedPrivateInput(
  fd: number,
  path: string,
  expected: PrivateInputFingerprint
): boolean {
  const opened = fstatSync(fd);
  const pathname = lstatSync(path);
  if (!opened.isFile() || !pathname.isFile() || !sameFile(opened, pathname)) {
    throw new Error('Private input candidate changed before reading');
  }
  if (opened.size !== expected.bytes) {
    if (!sameFile(opened, fstatSync(fd)) || !sameFile(opened, lstatSync(path))) {
      throw new Error('Private input candidate changed before exclusion');
    }
    return false;
  }
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < expected.bytes) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, expected.bytes - offset), offset);
    if (count === 0) throw new Error('Private input candidate truncated while reading');
    hash.update(chunk.subarray(0, count));
    offset += count;
  }
  if (!sameFile(opened, fstatSync(fd)) || !sameFile(opened, lstatSync(path))) {
    throw new Error('Private input candidate changed while reading');
  }
  return hash.digest('hex') === expected.sha256;
}

export function excludeDeclaredPrivateInput(
  root: string,
  dist: string,
  remove: (path: string) => void = unlinkSync
): number {
  try {
    const expected = declaredPrivateInput(root);
    const distRoot = resolve(dist);
    let removed = 0;
    const walk = (directory: string): void => {
      if (!lstatSync(directory).isDirectory()) throw new Error('Unexpected non-directory in dist');
      for (const name of readdirSync(directory).sort()) {
        const path = resolve(directory, name);
        const inside = relative(distRoot, path);
        if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
          throw new Error('Path escaped dist');
        }
        const state = lstatSync(path);
        if (state.isDirectory()) walk(path);
        else if (state.isFile()) {
          if (matchesPrivateInput(path, expected)) {
            remove(path);
            removed += 1;
          }
        } else {
          throw new Error('Unexpected link or special file in dist');
        }
      }
    };
    walk(distRoot);
    return removed;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'invalid';
    throw new Error(`[postbuild] Declared private input exclusion failed (${code})`);
  }
}

export function postbuild(
  root = resolve('.'),
  removePrivateCopy: (path: string) => void = unlinkSync
): void {
  const dist = resolve(root, 'dist');
  const excluded = excludeDeclaredPrivateInput(root, dist, removePrivateCopy);
  console.log(`[postbuild] Excluded ${excluded} declared private input copies from dist`);
  const indexPath = resolve(dist, 'index.html');
  const workerHash = verifyServiceWorkerOutput(root, dist);
  console.log(`[postbuild] Verified emitted service-worker.js ${workerHash}`);

  const html = readFileSync(indexPath, 'utf-8');
  // Application initialization stays in bundled external modules.
  const inlineScriptRegex = /<script(?![^>]*\bsrc\b)[^>]*>\s*([\s\S]*?)\s*<\/script>/gi;
  if (inlineScriptRegex.test(html)) {
    throw new Error(
      '[postbuild] Inline application scripts are forbidden; move initialization into an external module.'
    );
  }
  if (/<script[^>]*\bsrc\s*=\s*["'](?:https?:)?\/\//i.test(html)) {
    throw new Error(
      '[postbuild] External provider/CDN scripts are forbidden in application output.'
    );
  }
  console.log('[postbuild] Verified no application-owned inline scripts');

  // ── Step 3: Deduplicate byte-identical WASM assets ───────────────────

  const assetsDir = resolve(dist, 'assets');
  const wasmByDigest = new Map<string, string[]>();

  for (const fileName of readdirSync(assetsDir).filter((entry) => entry.endsWith('.wasm'))) {
    const contents = readFileSync(resolve(assetsDir, fileName));
    const digest = createHash('sha256').update(contents).digest('hex');
    const matches = wasmByDigest.get(digest) ?? [];
    matches.push(fileName);
    wasmByDigest.set(digest, matches);
  }

  let deduplicatedBytes = 0;
  for (const duplicateNames of wasmByDigest.values()) {
    duplicateNames.sort();
    const [canonicalName, ...redundantNames] = duplicateNames;
    if (!canonicalName || redundantNames.length === 0) continue;

    for (const redundantName of redundantNames) {
      for (const chunkName of readdirSync(assetsDir).filter((entry) => entry.endsWith('.js'))) {
        const chunkPath = resolve(assetsDir, chunkName);
        const chunk = readFileSync(chunkPath, 'utf8');
        const rewritten = chunk.replaceAll(redundantName, canonicalName);
        if (rewritten !== chunk) writeFileSync(chunkPath, rewritten);
      }

      const redundantPath = resolve(assetsDir, redundantName);
      deduplicatedBytes += statSync(redundantPath).size;
      rmSync(redundantPath);
      console.log(`[postbuild] Reused ${canonicalName} for duplicate ${redundantName}`);
    }
  }

  console.log(`[postbuild] Removed ${deduplicatedBytes} duplicate WASM bytes`);

  for (const chunkName of readdirSync(assetsDir).filter((entry) => entry.endsWith('.js'))) {
    const chunk = readFileSync(resolve(assetsDir, chunkName), 'utf8');
    const referencedWasmAssets = [...chunk.matchAll(/\/assets\/([\w.-]+\.wasm)/g)].map(
      (match) => match[1]!
    );
    for (const referencedWasm of referencedWasmAssets) {
      if (!existsSync(resolve(assetsDir, referencedWasm))) {
        throw new Error(`[postbuild] ${chunkName} references missing WASM asset ${referencedWasm}`);
      }
    }
  }
  console.log('[postbuild] Verified all emitted WASM references resolve');

  // ── Step 4: Remove test video files from production dist ─────────────
  // Test videos (~12MB total) are placed in public/ for dev convenience
  // but should not ship in the production deployment.

  const publicDir = resolve(dist);
  try {
    for (const entry of readdirSync(publicDir)) {
      if (entry.startsWith('test-video-') || entry === 'test-assets') {
        rmSync(resolve(publicDir, entry), { recursive: true, force: true });
        console.log(`[postbuild] Removed test asset: ${entry}`);
      }
    }
  } catch (err) {
    console.warn('[postbuild] Could not clean test assets from dist:', err);
  }

  writeFileSync(
    resolve(dist, '_headers'),
    fingerprintedAssetHeaders(
      readFileSync(resolve(root, 'public/_headers'), 'utf8'),
      readdirSync(assetsDir)
    )
  );
  writeDeploymentState(root, dist);
}

if (import.meta.main) postbuild();
