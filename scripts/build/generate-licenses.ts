#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP
//
// generate-licenses.ts — Collect notices for runtime dependencies and
// build-generated Vite browser helpers in public/LICENSES.md.
//
// Usage: node --experimental-strip-types scripts/build/generate-licenses.ts
// Called automatically during `vp run build` via the `prebuild` script.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
  notices: { file: string; text: string }[];
}

function readJson(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected a JSON object in ${path}`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, name: string): string {
  if (typeof value !== 'string' || !value.trim() || /^(unknown|unlicensed)$/i.test(value.trim())) {
    throw new Error(
      `Missing or unresolved ${field} for ${name}; check its installed package metadata.`
    );
  }
  return value.trim();
}

function extractLicense(pkg: Record<string, unknown>, name: string): string {
  const license = pkg.license;
  if (typeof license === 'string') return requiredString(license, 'license', name);
  if (license && typeof license === 'object' && 'type' in license) {
    return requiredString(license.type, 'license', name);
  }
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) {
    return pkg.licenses
      .map((entry: unknown) => {
        const value = entry && typeof entry === 'object' && 'type' in entry ? entry.type : entry;
        return requiredString(value, 'license', name);
      })
      .join(', ');
  }
  return requiredString(undefined, 'license', name);
}

function extractUrl(pkgJson: Record<string, unknown>): string | null {
  if (typeof pkgJson.repository === 'object' && pkgJson.repository !== null) {
    const repo = pkgJson.repository as { url?: string };
    if (typeof repo.url === 'string') {
      return repo.url
        .replace(/^git\+/, '')
        .replace(/^git:\/\//, 'https://')
        .replace(/\.git$/, '');
    }
  }
  return typeof pkgJson.homepage === 'string' ? pkgJson.homepage : null;
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

function collectInstalledDependency(
  declaredName: string,
  purpose: string,
  useInstalledName = false
): LicenseEntry {
  const directory = join(ROOT, 'node_modules', declaredName);
  let metadata: Record<string, unknown>;
  try {
    metadata = readJson(join(directory, 'package.json'));
  } catch (error) {
    throw new Error(
      `Cannot collect required dependency ${declaredName}; run vp install --frozen-lockfile.`,
      { cause: error }
    );
  }
  const name = useInstalledName
    ? requiredString(metadata.name, 'name', declaredName)
    : declaredName;
  const version = requiredString(metadata.version, 'version', name);
  const license = extractLicense(metadata, name);
  const notices = readdirSync(directory)
    .filter((file) => /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(file))
    .sort()
    .map((file) => {
      const text = readFileSync(join(directory, file), 'utf-8').trim();
      if (!text) throw new Error(`Empty installed notice ${name}/${file}.`);
      return { file, text };
    });
  if (!notices.length)
    throw new Error(
      `No installed license/notice text for ${name}; review this dependency before generating notices.`
    );
  return {
    name,
    version,
    license,
    url: extractUrl(metadata),
    purpose,
    notices,
  };
}

function collectRuntimeDeps(pkg: Record<string, unknown>): LicenseEntry[] {
  const deps = pkg.dependencies;
  if (!deps || typeof deps !== 'object' || Array.isArray(deps) || !Object.keys(deps).length) {
    throw new Error(
      'No declared runtime dependencies; check package.json before generating notices.'
    );
  }

  return Object.keys(deps)
    .sort()
    .map((name) => collectInstalledDependency(name, inferPurpose(name)));
}

function collectViteHelperOwner(pkg: Record<string, unknown>): LicenseEntry | null {
  const devDeps = pkg.devDependencies;
  if (!devDeps || typeof devDeps !== 'object' || Array.isArray(devDeps) || !('vite' in devDeps)) {
    return null;
  }
  return collectInstalledDependency('vite', 'Build-generated Vite/Rolldown browser helpers', true);
}

function generateLicenseText(
  entries: LicenseEntry[],
  viteHelperOwner: LicenseEntry | null
): string {
  let md = `# Third-Party Licenses

> Auto-generated by \`scripts/build/generate-licenses.ts\`.
> Do not edit manually — run \`vp run build\` to regenerate.

Declared runtime dependencies and their installed license/notice texts follow.
Bundled native source references and their attribution limits are recorded with wasm-webp.

`;
  for (const entry of entries) {
    md += `## ${entry.name}\n\n`;
    md += `- **Version:** ${entry.version}\n`;
    md += `- **License:** ${entry.license}\n`;
    if (entry.url) md += `- **Repository:** ${entry.url}\n`;
    md += `- **Purpose:** ${entry.purpose}\n\n`;
    if (entry.name === 'mediabunny' || entry.name === 'wasm-webp') {
      md += `Local modifications: https://github.com/PiesP/wasm-motion-converter/blob/master/patches/${entry.name}@${entry.version}.patch\n\n`;
    }
    if (entry.name === 'wasm-webp') {
      if (entry.version !== '0.1.0') {
        throw new Error(
          'Review bundled native notices for the new wasm-webp version before generating licenses.'
        );
      }
      const text = readFileSync(join(__dirname, 'wasm-webp-NOTICES.txt'), 'utf-8').trim();
      if (!text) throw new Error('Empty bundled native notices for wasm-webp.');
      entry.notices.push({ file: 'Bundled native and generated runtime notices', text });
    }
    for (const notice of entry.notices) {
      md += `### ${notice.file}\n\n`;
      md +=
        notice.text
          .split('\n')
          .map((line) => (line.trimEnd() ? `    ${line.trimEnd()}` : ''))
          .join('\n') + '\n\n';
    }
  }
  if (viteHelperOwner) {
    md += '## Build-generated browser helper owner\n\n';
    md +=
      'The declared Vite development dependency emits browser helpers in the production build. Its installed license/notice text follows; this section does not inventory every build dependency.\n\n';
    md += `### ${viteHelperOwner.name}\n\n`;
    md += `- **Version:** ${viteHelperOwner.version}\n`;
    md += `- **License:** ${viteHelperOwner.license}\n`;
    if (viteHelperOwner.url) md += `- **Repository:** ${viteHelperOwner.url}\n`;
    md += `- **Purpose:** ${viteHelperOwner.purpose}\n\n`;
    for (const notice of viteHelperOwner.notices) {
      md += `#### ${notice.file}\n\n`;
      md +=
        notice.text
          .split('\n')
          .map((line) => (line.trimEnd() ? `    ${line.trimEnd()}` : ''))
          .join('\n') + '\n\n';
    }
  }
  return md;
}

// ── Main ──────────────────────────────────────────────────────────

export function generateLicenses(): void {
  console.log('📋 Collecting license information...\n');

  const pkg = readJson(join(ROOT, 'package.json'));
  const entries = collectRuntimeDeps(pkg);
  const viteHelperOwner = collectViteHelperOwner(pkg);

  console.log(`  Found ${entries.length} runtime dependencies:`);
  for (const entry of entries) {
    console.log(`    • ${entry.name}@${entry.version} — ${entry.license}`);
  }
  if (viteHelperOwner)
    console.log(
      `  Build-generated helper owner: ${viteHelperOwner.name}@${viteHelperOwner.version}`
    );

  const licenseMd = `${generateLicenseText(entries, viteHelperOwner).trimEnd()}\n`;
  const outputPath = join(ROOT, 'public', 'LICENSES.md');
  writeFileSync(outputPath, licenseMd, 'utf-8');

  console.log(`\n✅ Generated ${outputPath}`);
}

if (import.meta.main) {
  try {
    generateLicenses();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
