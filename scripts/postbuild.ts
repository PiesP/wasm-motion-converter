// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP
/**
 * Post-build script: Cloudflare Pages deployment compatibility fixes.
 *
 * 1. Remove Cloudflare Pages auto-injected beacon scripts from index.html
 *    (Cloudflare injects Insights scripts that violate CSP strict-dynamic).
 *
 * 2. Generate CSP hashes for inline scripts in index.html and inject them
 *    into _headers so inline scripts are not blocked by Content-Security-Policy.
 *    Without this, inline scripts for lang detection and error suppression
 *    fail with "inline script violates CSP directive" errors.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve('dist');
const indexPath = resolve(dist, 'index.html');
const headersPath = resolve(dist, '_headers');

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

// ── Step 2: Generate CSP hashes for inline scripts ───────────────────

// Use the HTML (after Cloudflare script removal) for hash generation
// so we don't create hashes for scripts that will be stripped at deploy time.
const finalHtml = cleaned;

// Find inline <script> blocks (no src attribute)
const inlineScriptRegex = /<script(?![^>]*\bsrc\b)[^>]*>\s*([\s\S]*?)\s*<\/script>/gi;
const hashes: string[] = [];
let match: RegExpExecArray | null;

while ((match = inlineScriptRegex.exec(finalHtml)) !== null) {
  const content = match[1]!;
  const hash = createHash('sha256').update(content).digest('base64');
  hashes.push(`'sha256-${hash}'`);
}

if (hashes.length > 0) {
  console.log(`[postbuild] Computed ${hashes.length} CSP hashes for inline scripts`);

  // Read _headers and inject hashes into script-src
  let headers = readFileSync(headersPath, 'utf-8');

  // Find the CSP line and inject hashes into script-src
  // Pattern: script-src 'self' 'unsafe-eval' ...;
  const cspScriptSrcRegex = /(script-src\s+'self'\s+'unsafe-eval')([^;]*);/;
  const hashStr = hashes.join(' ');

  if (cspScriptSrcRegex.test(headers)) {
    headers = headers.replace(cspScriptSrcRegex, `$1 ${hashStr}$2;`);
    writeFileSync(headersPath, headers);
    console.log(`[postbuild] Injected CSP hashes into _headers`);
  } else {
    console.warn('[postbuild] Could not find script-src in _headers to inject hashes');
  }
} else {
  console.log('[postbuild] No inline scripts found — CSP hash injection skipped');
}
