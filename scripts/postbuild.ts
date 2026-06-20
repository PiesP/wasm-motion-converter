// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP
/**
 * Post-build script: Remove Cloudflare Pages auto-injected beacon script
 * from the built index.html to prevent CSP/MIME-type console errors.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const indexPath = resolve('dist', 'index.html');
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

// Also remove data-cfasync script we added to index.html
const cfAsyncRegex = /<script data-cfasync="false">[^>]*<\/script>/gi;
let prev2 = '';
let cleaned2 = cleaned;
do {
  prev2 = cleaned2;
  cleaned2 = cleaned2.replace(cfAsyncRegex, '');
} while (cleaned2 !== prev2);

if (cleaned2 !== cleaned) {
  writeFileSync(indexPath, cleaned2);
  console.log('[postbuild] Removed data-cfasync script');
}
