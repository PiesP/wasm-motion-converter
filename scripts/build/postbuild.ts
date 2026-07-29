#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP
/**
 * Post-build script: Cloudflare Pages deployment compatibility fixes.
 *
 * 1. Remove Cloudflare Pages auto-injected beacon scripts from index.html
 *    (Cloudflare injects Insights scripts that violate CSP strict-dynamic).
 *
 * 2. Verify that the application does not ship inline scripts. The production
 *    CSP intentionally has no application-owned inline-script hash; keeping
 *    initialization in the external module prevents HTML/hash drift.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve('dist');
const indexPath = resolve(dist, 'index.html');

// ── Step 1: Remove Cloudflare auto-injected scripts ──────────────────

const html = readFileSync(indexPath, 'utf-8');

// Remove Cloudflare Insights beacon script (injected by Cloudflare Pages)
// Loop until no more matches to prevent incomplete multi-character sanitization
// (CodeQL: js/incomplete-multi-character-sanitization)
const beaconRegex =
  /<script[^>]*src=["']https:\/\/static\.cloudflareinsights\.com\/beacon[^"']*["'][^>]*><\/script>/gi;
let previous = '';
let cleaned = html;
do {
  previous = cleaned;
  cleaned = cleaned.replace(beaconRegex, '');
} while (cleaned !== previous);

if (cleaned !== html) {
  writeFileSync(indexPath, cleaned);
  console.log('[postbuild] Removed Cloudflare Insights beacon script');
} else {
  console.log('[postbuild] No Cloudflare Insights beacon script found');
}

// ── Step 2: Enforce an external-script-only application policy ─────────

// Cloudflare's own scripts are injected after this build step and are covered
// by the stable hashes in public/_headers. Any application-owned inline script
// would reintroduce the HTML/header hash drift this check is meant to prevent.
const inlineScriptRegex = /<script(?![^>]*\bsrc\b)[^>]*>\s*([\s\S]*?)\s*<\/script>/gi;
if (inlineScriptRegex.test(cleaned)) {
  throw new Error(
    '[postbuild] Inline application scripts are forbidden; move initialization into an external module.'
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
