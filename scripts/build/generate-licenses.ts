#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP
//
// generate-licenses.ts — Collect license info from all runtime dependencies
// and generate public/LICENSES.md automatically.
//
// Usage: node --experimental-strip-types scripts/build/generate-licenses.ts
// Called automatically during `pnpm build` via the `prebuild` script.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  url: string | null;
  purpose: string;
  note?: string;
}

function readPackageJson(pkgName: string): Record<string, unknown> | null {
  const pkgPath = join(ROOT, 'node_modules', pkgName, 'package.json');
  if (!existsSync(pkgPath)) {
    console.warn(`  ⚠ Package not found: ${pkgName} (run pnpm install)`);
    return null;
  }
  return JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
}

function extractLicense(pkgJson: Record<string, unknown>): string {
  if (typeof pkgJson.license === 'string') return pkgJson.license;
  if (typeof pkgJson.license === 'object' && pkgJson.license !== null) {
    const lic = pkgJson.license as { type?: string };
    if (lic.type) return lic.type;
  }
  if (Array.isArray(pkgJson.licenses) && pkgJson.licenses.length > 0) {
    return pkgJson.licenses
      .map((l: { type?: string } | string) => (typeof l === 'string' ? l : (l.type ?? '')))
      .join(', ');
  }
  return 'Unknown';
}

function extractUrl(pkgJson: Record<string, unknown>): string | null {
  if (typeof pkgJson.homepage === 'string') return pkgJson.homepage;
  if (typeof pkgJson.repository === 'object' && pkgJson.repository !== null) {
    const repo = pkgJson.repository as { url?: string };
    if (typeof repo.url === 'string') {
      return repo.url.replace(/^git\+/, '').replace(/\.git$/, '');
    }
  }
  return null;
}

function inferPurpose(name: string): string {
  const purposes: Record<string, string> = {
    gifenc: 'GIF encoding (quantize, applyPalette, GIFEncoder)',
    'wasm-webp': 'WebP encoding via WebAssembly (encodeRGB)',
    mediabunny: 'Video demuxing (Input, BufferSource, EncodedPacketSink)',
    'solid-js': 'UI framework (reactive signals, components)',
  };
  return purposes[name] || 'Runtime dependency';
}

function collectRuntimeDeps(): LicenseEntry[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as Record<
    string,
    unknown
  >;
  const deps = (pkg.dependencies as Record<string, string> | undefined) ?? {};

  const entries: LicenseEntry[] = [];

  for (const name of Object.keys(deps)) {
    const pkgJson = readPackageJson(name);
    if (!pkgJson) continue;

    const version = pkgJson.version as string;
    const license = extractLicense(pkgJson);
    const url = extractUrl(pkgJson);

    entries.push({
      name,
      version,
      license,
      url,
      purpose: inferPurpose(name),
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function getMitLicense(): string {
  return `MIT License

Copyright (c) respective authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
}

function generateLicenseText(entries: LicenseEntry[]): string {
  const now = new Date().toISOString().slice(0, 10);

  let md = `# Third-Party Licenses

> Auto-generated on ${now} by \`scripts/build/generate-licenses.ts\`.
> Do not edit manually — run \`pnpm build\` to regenerate.

This project uses the following open-source libraries.

## Runtime Dependencies

`;

  for (const entry of entries) {
    md += `### ${entry.name}\n\n`;
    md += `- **Version:** ${entry.version}\n`;
    md += `- **License:** ${entry.license}\n`;
    if (entry.url) md += `- **Repository:** ${entry.url}\n`;
    md += `- **Purpose:** ${entry.purpose}\n`;
    if (entry.note) md += `- **Note:** ${entry.note}\n`;
    md += '\n';
  }

  // Group by license type
  const byLicense: Record<string, LicenseEntry[]> = {};
  for (const entry of entries) {
    const key = entry.license;
    if (!byLicense[key]) byLicense[key] = [];
    byLicense[key].push(entry);
  }

  md += '## License Texts\n\n';

  for (const [license, items] of Object.entries(byLicense)) {
    const names = items.map((i) => i.name).join(', ');
    md += `### ${license} (${names})\n\n`;

    if (license === 'MIT') {
      md += `\`\`\`\n${getMitLicense()}\n\`\`\`\n\n`;
    } else if (license === 'MPL-2.0') {
      md +=
        'Mozilla Public License Version 2.0. See https://www.mozilla.org/en-US/MPL/2.0/ for full text.\n\n';
      md +=
        'Key points:\n- Source code modifications to the library itself must be made available under MPL-2.0\n';
      md +=
        '- This project (wasm-motion-converter) remains under MIT\n- No patent retaliation clause applies\n\n';
    } else {
      md += 'See the package repository for full license text.\n\n';
    }
  }

  return md;
}

// ── Main ──────────────────────────────────────────────────────────

console.log('📋 Collecting license information...\n');

const entries = collectRuntimeDeps();

if (entries.length === 0) {
  console.error('❌ No runtime dependencies found. Run `pnpm install` first.');
  process.exit(1);
}

console.log(`  Found ${entries.length} runtime dependencies:`);
for (const entry of entries) {
  console.log(`    • ${entry.name}@${entry.version} — ${entry.license}`);
}

const licenseMd = `${generateLicenseText(entries).trimEnd()}\n`;
const outputPath = join(ROOT, 'public', 'LICENSES.md');
writeFileSync(outputPath, licenseMd, 'utf-8');

console.log(`\n✅ Generated ${outputPath}`);
