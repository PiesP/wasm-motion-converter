// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outputPath = path.join(rootDir, 'public', 'LICENSES.md');

interface LicenseEntry {
  name: string;
  versions: string[];
  license: string;
  homepage?: string;
  description?: string;
  repository?: string;
}

interface FFmpegLicense {
  name: string;
  license: string;
  text: string;
  repository: string;
}

function getRepositoryUrl(entry: LicenseEntry): string | undefined {
  if (entry.repository) return entry.repository;
  if (entry.homepage) return entry.homepage;
  if (entry.description?.toLowerCase().includes('github')) return undefined;
  return undefined;
}

function flattenPackagesByLicense(raw: unknown): LicenseEntry[] {
  const packages: LicenseEntry[] = [];

  if (!raw || typeof raw !== 'object') return packages;

  for (const [, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;

    for (const entry of entries as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;

      const { name, versions, license, homepage, description, repository } = entry as Record<
        string,
        unknown
      >;

      if (typeof name !== 'string' || !name) continue;

      packages.push({
        name,
        versions: Array.isArray(versions) ? versions.map(String) : [],
        license: typeof license === 'string' ? license : 'UNKNOWN',
        homepage: typeof homepage === 'string' ? homepage : undefined,
        description: typeof description === 'string' ? description : undefined,
        repository: typeof repository === 'string' ? repository : undefined,
      });
    }
  }

  // Sort by package name
  packages.sort((a, b) => a.name.localeCompare(b.name, 'en'));

  return packages;
}

function createFFmpegLicenseEntry(): FFmpegLicense {
  return {
    name: 'FFmpeg (WebAssembly Core)',
    license: 'LGPL 2.1+',
    text: `FFmpeg is licensed under the GNU Lesser General Public License (LGPL) version 2.1 or later.

This application uses FFmpeg through ffmpeg.wasm, which compiles FFmpeg to WebAssembly.
The FFmpeg core libraries used are licensed under LGPL 2.1+.

For more information, see:
- FFmpeg License: https://ffmpeg.org/legal.html
- FFmpeg Source Code: https://github.com/FFmpeg/FFmpeg
- ffmpeg.wasm Core: https://github.com/ffmpegwasm/ffmpeg.wasm-core

IMPORTANT: This is LGPL software. If you modify the FFmpeg core libraries, you must
make the source code of your modifications available under the LGPL license.`,
    repository: 'https://github.com/FFmpeg/FFmpeg',
  };
}

function generateMarkdownOutput(packages: LicenseEntry[]): string {
  const entries = packages.map((pkg) => {
    const version = pkg.versions.length > 0 ? ` v${pkg.versions.join(', v')}` : '';
    const repoUrl = getRepositoryUrl(pkg);

    return `
## ${pkg.name}${version}

**License**: ${pkg.license}
${repoUrl ? `**Repository**: ${repoUrl}` : ''}
${pkg.description ? `\n${pkg.description}` : ''}
`;
  });

  const ffmpegEntry = `
## ${createFFmpegLicenseEntry().name}

**License**: ${createFFmpegLicenseEntry().license}
**Repository**: ${createFFmpegLicenseEntry().repository}

\`\`\`
${createFFmpegLicenseEntry().text}
\`\`\`
`;

  return `# Third-Party Licenses

This project uses the following open-source libraries and components.

## Important Notice

This application uses FFmpeg through ffmpeg.wasm. While the JavaScript wrapper (ffmpeg.wasm)
is licensed under MIT, the underlying FFmpeg core is licensed under LGPL 2.1 or later.
As a user of this application, you are subject to the terms of the LGPL 2.1+ license
for the FFmpeg components.

---

${entries.join('---\n')}

---${ffmpegEntry}
`;
}

async function runPnpmLicenses(): Promise<unknown> {
  const args = ['-s', 'licenses', 'list', '--json', '--prod'];
  const { stdout } = await execFileAsync('pnpm', args, {
    cwd: rootDir,
    maxBuffer: 20 * 1024 * 1024,
    env: process.env,
  });

  return JSON.parse(stdout) as unknown;
}

async function main(): Promise<void> {
  const raw = await runPnpmLicenses();
  const packages = flattenPackagesByLicense(raw);

  const markdown = generateMarkdownOutput(packages);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, markdown, 'utf8');

  console.log(`Generated ${path.relative(rootDir, outputPath)}`);
  console.log(`Found ${packages.length} dependencies (plus FFmpeg core)`);
}

main().catch((err) => {
  console.error('Failed to generate third-party licenses:', err);
  process.exitCode = 1;
});
