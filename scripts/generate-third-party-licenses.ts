
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LICENSE_FILE_NAMES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'license',
  'license.md'
] as const;

const LICENSE_NOT_AVAILABLE =
  'License text not available in package. Please refer to the package repository for license details.';

const OUTPUT_RELATIVE_PATH = path.join('public', 'LICENSES.md');

interface LicenseInfo {
  name: string;
  license: string;
  text: string;
  repository?: string;
}

interface PackageJsonData {
  license?: string;
  dependencies?: Record<string, string>;
  repository?: string | { url?: string };
}

const dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(dirname, '..');
function loadRootPackageJson(): PackageJsonData {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  try {
    const content = fs.readFileSync(packageJsonPath, 'utf-8');
    return JSON.parse(content) as PackageJsonData;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Failed to read package.json: ${errorMessage}`);
    throw error;
  }
}

function loadLicenseText(depPath: string): string {
  for (const fileName of LICENSE_FILE_NAMES) {
    const licensePath = path.join(depPath, fileName);
    if (fs.existsSync(licensePath)) {
      try {
        return fs.readFileSync(licensePath, 'utf-8');
      } catch (error) {
        console.warn(`Warning: Could not read license file ${fileName} in ${depPath}`);
      }
    }
  }

  return LICENSE_NOT_AVAILABLE;
}

function extractRepositoryUrl(
  repoField: string | { url?: string } | undefined
): string {
  if (!repoField) {
    return '';
  }

  let repoUrl = '';

  if (typeof repoField === 'string') {
    repoUrl = repoField;
  } else if (repoField.url) {
    repoUrl = repoField.url;
  }

  return repoUrl.replace(/^git\+/, '').replace(/\.git$/, '');
}

function readDependencyLicense(depName: string): LicenseInfo | null {
  const depPath = path.join(projectRoot, 'node_modules', depName);

  if (!fs.existsSync(depPath)) {
    console.warn(`Warning: ${depName} not found in node_modules`);
    return null;
  }

  const depPackageJsonPath = path.join(depPath, 'package.json');
  let depPackageJson: PackageJsonData = {};

  try {
    const content = fs.readFileSync(depPackageJsonPath, 'utf-8');
    depPackageJson = JSON.parse(content) as PackageJsonData;
  } catch (error) {
    console.warn(
      `Warning: Cannot read package.json for ${depName}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }

  const licenseText = loadLicenseText(depPath);

  const repoUrl = extractRepositoryUrl(depPackageJson.repository);

  return {
    name: depName,
    license: depPackageJson.license || 'UNKNOWN',
    text: licenseText,
    repository: repoUrl,
  };
}

function createFFmpegLicenseEntry(): LicenseInfo {
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

function generateMarkdownOutput(licenses: LicenseInfo[]): string {
  const licenseEntries = licenses
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
    .join('\n---\n');

  return `# Third-Party Licenses

This project uses the following open-source libraries and components.

## Important Notice

This application uses FFmpeg through ffmpeg.wasm. While the JavaScript wrapper (ffmpeg.wasm)
is licensed under MIT, the underlying FFmpeg core is licensed under LGPL 2.1 or later.
As a user of this application, you are subject to the terms of the LGPL 2.1+ license
for the FFmpeg components.

---

${licenseEntries}
`;
}

function writeLicensesFile(content: string): void {
  const outputPath = path.join(projectRoot, OUTPUT_RELATIVE_PATH);
  const outputDir = path.dirname(outputPath);

  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, content, 'utf-8');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Failed to write licenses file: ${errorMessage}`);
    throw error;
  }
}

try {
  const packageJson = loadRootPackageJson();
  const dependencies = Object.keys(packageJson.dependencies || {});

  const licenses: LicenseInfo[] = [createFFmpegLicenseEntry()];

  for (const dep of dependencies) {
    const licenseInfo = readDependencyLicense(dep);
    if (licenseInfo) {
      licenses.push(licenseInfo);
    }
  }

  const output = generateMarkdownOutput(licenses);
  writeLicensesFile(output);

  console.log(`Generated ${OUTPUT_RELATIVE_PATH}`);
  console.log(`Found ${licenses.length} dependencies (including FFmpeg core)`);
} catch (error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`License generation failed: ${errorMessage}`);
  process.exit(1);
}
