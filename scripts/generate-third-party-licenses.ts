import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(dirname, '..');

interface LicenseInfo {
  name: string;
  license: string;
  text: string;
  repository?: string;
}

const packageJsonPath = path.join(projectRoot, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const dependencies = Object.keys(packageJson.dependencies || {});

const licenses: LicenseInfo[] = [];

// Add FFmpeg core LGPL notice at the beginning
licenses.push({
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
});

for (const dep of dependencies) {
  const depPath = path.join(projectRoot, 'node_modules', dep);

  if (!fs.existsSync(depPath)) {
    console.warn(`Warning: ${dep} not found in node_modules`);
    continue;
  }

  const depPackageJsonPath = path.join(depPath, 'package.json');
  let depPackageJson: { license?: string; repository?: string | { url?: string } } = {};

  try {
    depPackageJson = JSON.parse(fs.readFileSync(depPackageJsonPath, 'utf-8'));
  } catch (error) {
    console.warn(`Warning: Cannot read package.json for ${dep}`);
    continue;
  }

  let licenseText = '';

  // Try multiple license file names
  const licenseFileNames = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md'];

  for (const fileName of licenseFileNames) {
    const licensePath = path.join(depPath, fileName);
    if (fs.existsSync(licensePath)) {
      licenseText = fs.readFileSync(licensePath, 'utf-8');
      break;
    }
  }

  // If no license file found, try to get from common locations
  if (!licenseText) {
    licenseText = 'License text not available in package. Please refer to the package repository for license details.';
  }

  // Get repository URL
  let repoUrl = '';
  if (depPackageJson.repository) {
    if (typeof depPackageJson.repository === 'string') {
      repoUrl = depPackageJson.repository;
    } else if (depPackageJson.repository.url) {
      repoUrl = depPackageJson.repository.url;
    }
    // Clean up git+ prefix and .git suffix
    repoUrl = repoUrl.replace(/^git\+/, '').replace(/\.git$/, '');
  }

  licenses.push({
    name: dep,
    license: depPackageJson.license || 'UNKNOWN',
    text: licenseText,
    repository: repoUrl,
  });
}

const output = `# Third-Party Licenses

This project uses the following open-source libraries and components.

## Important Notice

This application uses FFmpeg through ffmpeg.wasm. While the JavaScript wrapper (ffmpeg.wasm)
is licensed under MIT, the underlying FFmpeg core is licensed under LGPL 2.1 or later.
As a user of this application, you are subject to the terms of the LGPL 2.1+ license
for the FFmpeg components.

---

${licenses
  .map(
    (l) => `
## ${l.name}

**License**: ${l.license}
${l.repository ? `**Repository**: ${l.repository}` : ''}

\`\`\`
${l.text}
\`\`\`
`
  )
  .join('\n---\n')}
`;

const outputPath = path.join(projectRoot, 'public', 'LICENSES.md');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output);

console.log('Generated public/LICENSES.md');
console.log(`Found ${licenses.length} dependencies (including FFmpeg core)`);
