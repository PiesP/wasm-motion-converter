#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP
//
// generate-licenses.ts — Collect notices for runtime dependencies and
// build-generated Vite browser helpers in public/LICENSES.md.
//
// Usage: node --experimental-strip-types scripts/build/generate-licenses.ts
// Called automatically during `vp run build` via the `prebuild` script.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
    gifenc:
      'Owned GIF source adaptation (PNN, RGB565 mapping, GIF blocks and LZW); development-only differential oracle',
    'wasm-webp': 'WebP encoding via WebAssembly (encodeRGB)',
    mediabunny:
      'Development-only patched metadata and demux differential oracle; no production executable',
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

function notice(file: string): { file: string; text: string } {
  const text = readFileSync(join(ROOT, file), 'utf-8').trim();
  if (!text) throw new Error(`Empty notice ${file}.`);
  return { file, text };
}

function noticeBlock(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => (line.trimEnd() ? `    ${line.trimEnd()}` : ''))
      .join('\n') + '\n\n'
  );
}

function tomlString(path: string, field: string): string {
  const contents = readFileSync(join(ROOT, path), 'utf8');
  const match = contents.match(new RegExp(`^${field}\\s*=\\s*"([^"]+)"\\s*$`, 'm'));
  return requiredString(match?.[1], field, path);
}

const wasmModules = [
  {
    name: 'gif-scalar-quantizer',
    buildScript: 'build:gif-wasm',
    artifact: 'src/services/gif-scalar-quantizer.wasm',
    purpose: 'GIF quantization, indexing and LZW',
  },
  {
    name: 'owned-demux',
    buildScript: 'build:demux-wasm',
    artifact: 'src/services/owned-demux.wasm',
    purpose: 'Container parsing and packet indexing',
  },
  {
    name: 'owned-vp8',
    buildScript: 'build:vp8-wasm',
    artifact: 'crates/owned-vp8/owned-vp8.wasm',
    purpose: 'Software VP8 encoding for WebP',
  },
] as const;

function wasmLicenseIndex(modules: (typeof wasmModules)[number][]): string {
  if (!modules.length) return '';
  const version = '1.100.0';
  const report = `notices/rust-${version}.html`;
  const expectedHash = '626556344c12679d7cab2c1aa2ce80de01937b62c2c88c62f0650a469be18799';
  const actualHash = createHash('sha256')
    .update(readFileSync(join(ROOT, 'public', report)))
    .digest('hex');
  if (actualHash !== expectedHash)
    throw new Error(`Rust standard library notice digest mismatch: ${report}`);
  let md = '## Shipped Rust/WASM modules\n\n';
  md +=
    '| Browser artifact (before bundling) | Purpose | License information |\n| --- | --- | --- |\n';
  for (const { name, artifact, purpose } of modules) {
    const crate = `crates/${name}`;
    const manifest = `${crate}/Cargo.toml`;
    if (tomlString(manifest, 'name') !== name)
      throw new Error(`Unexpected crate name in ${manifest}.`);
    if (tomlString(`${crate}/rust-toolchain.toml`, 'channel') !== version) {
      throw new Error(
        `Review Rust standard library notices for ${name} after changing its toolchain.`
      );
    }
    let license: string;
    if (name === 'gif-scalar-quantizer') {
      if (tomlString(manifest, 'license-file') !== 'NOTICE.md')
        throw new Error(`Review GIF license file in ${manifest}.`);
      license = 'gifenc MIT; PnnQuant.js MPL-2.0; earlier PNN rights under review';
    } else {
      license = tomlString(manifest, 'license');
    }
    md += `| \`${artifact}\` | ${purpose} | ${license} |\n`;
  }
  md += `\n[Standard library copyright and third-party notices for Rust ${version}](${report}). The pinned Rust release supplies this report for its standard library across targets.\n\n`;
  md += '### Project MIT license\n\n' + noticeBlock(notice('LICENSE').text);
  if (modules.some(({ name }) => name === 'gif-scalar-quantizer')) {
    const source = 'crates/gif-scalar-quantizer/src/lib.rs';
    const distributed = 'notices/gif-scalar-source.txt';
    if (!readFileSync(join(ROOT, source)).equals(readFileSync(join(ROOT, 'public', distributed)))) {
      throw new Error(`Published GIF source differs from ${source}.`);
    }
    const upstreamLicense = 'notices/pnn-upstream-gpl-3.0.txt';
    notice(`public/${upstreamLicense}`);
    md += '### GIF source availability and PNN license\n\n';
    md += `[Get the exact GIF Rust source distributed with this build](${distributed}). The following crate notice records the upstream terms and the unresolved earlier PNN provenance. [Earlier upstream GPLv3 license text](${upstreamLicense}).\n\n`;
    md += noticeBlock(notice('crates/gif-scalar-quantizer/NOTICE.md').text);
    md += noticeBlock(notice('crates/gif-scalar-quantizer/LICENSE.pnn').text);
  }
  return md;
}

function collectOwnedVp8Attribution(): LicenseEntry {
  const manifest = 'crates/owned-vp8/Cargo.toml';
  const license = tomlString(manifest, 'license');
  if (license !== 'MIT AND BSD-3-Clause') {
    throw new Error('Review owned VP8 crate license before generating notices.');
  }
  const version = tomlString(manifest, 'version');
  return {
    name: 'owned-vp8',
    version,
    license,
    url: 'https://github.com/PiesP/wasm-motion-converter/tree/master/crates/owned-vp8',
    purpose:
      'Conversion-owned Rust VP8 encoder: original MIT code, attributed libwebp transform, color, source-activity, quantization and filter calculations, and RFC 6386 format constants',
    notices: [
      notice('crates/owned-vp8/LICENSE.libwebp'),
      notice('crates/owned-vp8/PATENTS.libwebp'),
      notice('crates/owned-vp8/LICENSE.rfc6386'),
      notice('crates/owned-vp8/PATENTS.rfc6386'),
      {
        file: 'RFC 6386 format reference',
        text: 'RFC 6386 (VP8 Data Format and Decoding Guide), sections 7, 9, 11, 13, 14 and 19.2, Copyright (c) 2011 IETF Trust and the identified contributors. Sections 20.26 and 20.27 contain separate notices for the reference source code and tables. https://www.rfc-editor.org/rfc/rfc6386.html',
      },
    ],
  };
}

function checkGifencSource(entry: LicenseEntry): void {
  if (entry.version !== '1.0.3') {
    throw new Error(
      'Review PNN attribution for the new gifenc version before generating licenses.'
    );
  }
  const source = readFileSync(join(ROOT, 'node_modules/gifenc/src/pnnquant2.js'), 'utf-8');
  const header = `${source.split('\n').slice(0, 8).join('\n')}\n`;
  if (
    createHash('sha256').update(header).digest('hex') !==
    '8707698903f06b547aeb06ccb3233671baef59d067db6ab930550cae7643836e'
  ) {
    throw new Error('Review changed gifenc PNN source header before generating licenses.');
  }
  const credits = notice('scripts/build/gifenc-pnn-NOTICES.txt').text;
  const lzw = readFileSync(join(ROOT, 'node_modules/gifenc/src/lzwEncode.js'), 'utf8');
  const lzwHeader = lzw.match(/^\/\*[\s\S]*?\*\//)?.[0];
  if (!credits.includes(header.trimEnd()) || !lzwHeader || !credits.includes(lzwHeader)) {
    throw new Error('Review gifenc PNN and LZW credits against the installed source.');
  }
}

function generateLicenseText(
  sections: { entry: LicenseEntry; title: string }[],
  viteHelperOwner: LicenseEntry | null,
  wasmIndex: string
): string {
  let md = `# Third-Party Licenses

> Auto-generated by \`scripts/build/generate-licenses.ts\`.
> Do not edit manually — run \`vp run build\` to regenerate.

The sections below identify the shipped code and the separate development oracles.

${wasmIndex}`;
  for (const { entry, title } of sections) {
    md += `## ${title}\n\n`;
    md += `- **Version:** ${entry.version}\n`;
    md += `- **License:** ${entry.license}\n`;
    if (entry.url) md += `- **Repository:** ${entry.url}\n`;
    md += `- **Purpose:** ${entry.purpose}\n\n`;
    if (entry.name === 'mediabunny' || entry.name === 'wasm-webp') {
      md += `Local modifications: https://github.com/PiesP/wasm-motion-converter/blob/master/patches/${entry.name}@${entry.version}.patch\n\n`;
    }
    if (entry.name === 'gifenc') {
      md +=
        'The owned GIF implementation adapts gifenc 1.0.3. The gifenc license and source credits follow.\n\n';
      const text = readFileSync(join(__dirname, 'gifenc-pnn-NOTICES.txt'), 'utf-8').trim();
      if (!text) throw new Error('Empty supplemental PNN attribution for gifenc.');
      entry.notices.push({ file: 'PNN and LZW source attribution', text });
    }
    if (entry.name === 'wasm-webp') {
      if (entry.version !== '0.1.0') {
        throw new Error(
          'Review bundled native notices for the new wasm-webp version before generating licenses.'
        );
      }
      const text = readFileSync(join(__dirname, 'wasm-webp-NOTICES.txt'), 'utf-8').trim();
      if (!text) throw new Error('Empty bundled native notices for wasm-webp.');
      entry.notices.push({ file: 'Native and generated notices from the pinned package', text });
    }
    for (const notice of entry.notices) {
      md += `### ${notice.file}\n\n`;
      md += noticeBlock(notice.text);
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
      md += noticeBlock(notice.text);
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

  const dev = pkg.devDependencies;
  // Source adaptations ship even when a development oracle is removed.
  const scripts = pkg.scripts;
  const modules = wasmModules.filter(
    ({ name, artifact, buildScript }) =>
      (scripts && typeof scripts === 'object' && buildScript in scripts) ||
      existsSync(join(ROOT, 'crates', name)) ||
      existsSync(join(ROOT, artifact))
  );
  const sections = entries.map((entry) => ({ entry, title: entry.name }));
  const gifDependency = entries.find((entry) => entry.name === 'gifenc');
  if (gifDependency) {
    checkGifencSource(gifDependency);
  } else if (dev && typeof dev === 'object' && 'gifenc' in dev) {
    const entry = collectInstalledDependency('gifenc', inferPurpose('gifenc'));
    checkGifencSource(entry);
    sections.push({ entry, title: 'Owned GIF source attribution (gifenc)' });
  } else if (modules.some(({ name }) => name === 'gif-scalar-quantizer')) {
    sections.push({
      title: 'Owned GIF source attribution (gifenc)',
      entry: {
        name: 'gifenc',
        version: '1.0.3',
        license: 'MIT',
        url: 'https://github.com/mattdesl/gifenc',
        purpose: 'Source adapted by the owned GIF implementation',
        notices: [notice('scripts/build/gifenc-LICENSE.txt')],
      },
    });
  }
  if (
    dev &&
    typeof dev === 'object' &&
    'mediabunny' in dev &&
    !entries.some((entry) => entry.name === 'mediabunny')
  ) {
    sections.push({
      entry: collectInstalledDependency('mediabunny', inferPurpose('mediabunny')),
      title: 'Development-only demux oracle (MediaBunny)',
    });
  }
  if (modules.some(({ name }) => name === 'owned-vp8')) {
    sections.push({ entry: collectOwnedVp8Attribution(), title: 'Owned VP8 source attribution' });
  }
  if (
    dev &&
    typeof dev === 'object' &&
    'wasm-webp' in dev &&
    !entries.some((entry) => entry.name === 'wasm-webp')
  ) {
    sections.push({
      entry: collectInstalledDependency(
        'wasm-webp',
        'Pinned development-only VP8 comparison encoder'
      ),
      title: 'Development-only VP8 oracle (wasm-webp)',
    });
  }
  const licenseMd = `${generateLicenseText(sections, viteHelperOwner, wasmLicenseIndex(modules)).trimEnd()}\n`;
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
