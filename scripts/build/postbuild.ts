#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP
/**
 * Finalize the static Pages distribution and its source/byte inventory.
 * Provider-side HTML injection is controlled in Pages settings, after build.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { fingerprintedAssetHeaders, writeDeploymentState } from './deployment-state.ts';
import { verifyServiceWorkerOutput } from './verify-service-worker-output.ts';

export function postbuild(): void {
  const dist = resolve('dist');
  const indexPath = resolve(dist, 'index.html');
  const workerHash = verifyServiceWorkerOutput(resolve('.'), dist);
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
      readFileSync(resolve('public/_headers'), 'utf8'),
      readdirSync(assetsDir)
    )
  );
  writeDeploymentState(resolve('.'), dist);
}

if (import.meta.main) postbuild();
