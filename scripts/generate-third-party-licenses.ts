/**
 * Third-Party License Generator
 *
 * Build script that generates a comprehensive LICENSES.md file containing:
 * - All project dependencies and their license information
 * - FFmpeg core LGPL 2.1+ notice (important legal requirement)
 * - Repository URLs for reference
 *
 * Output: public/LICENSES.md (included in distribution)
 *
 * This script is automatically run during the build process to ensure
 * license compliance and transparency.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================
// Constants
// ============================================================

/** Standard license file names to search for (case-insensitive) */
const LICENSE_FILE_NAMES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'license',
  'license.md'
] as const;

/** Message when license text cannot be found */
const LICENSE_NOT_AVAILABLE =
  'License text not available in package. Please refer to the package repository for license details.';

/** Path to output file relative to project root */
const OUTPUT_RELATIVE_PATH = path.join('public', 'LICENSES.md');

// ============================================================
// Type Definitions
// ============================================================

/**
 * Information about a package's license and distribution details
 *
 * @remarks
 * Used to generate the licenses documentation. Repository URL is optional
 * for packages that don't publish it.
 */
interface LicenseInfo {
  /** Package name as listed in package.json */
  name: string;
  /** SPDX license identifier or custom string */
  license: string;
  /** Full license text or fallback message */
  text: string;
  /** Optional GitHub or npm repository URL */
  repository?: string;
}

/**
 * Parsed package.json data (subset of fields used)
 *
 * @remarks
 * Repository field can be a string URL or object with nested URL property
 */
interface PackageJsonData {
  /** SPDX license identifier */
  license?: string;
  /** Dependencies object mapping package name to version */
  dependencies?: Record<string, string>;
  /** Repository URL or repository metadata object */
  repository?: string | { url?: string };
}

// ============================================================
// Setup
// ============================================================

const dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(dirname, '..');

// ============================================================
// Functions
// ============================================================

/**
 * Read and parse the root package.json file
 *
 * @returns Parsed package.json data with dependencies
 * @throws Error if package.json cannot be read or parsed
 */
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

/**
 * Load license text from dependency package directory
 *
 * @param depPath - Absolute path to the dependency directory
 * @returns License text if found, or LICENSE_NOT_AVAILABLE fallback message
 *
 * @remarks
 * Searches for license files in standard locations and case variations.
 * Returns fallback message if no file found (user can check repository).
 */
function loadLicenseText(depPath: string): string {
  // Try each possible license file name
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

  // Fallback: license text not found
  return LICENSE_NOT_AVAILABLE;
}

/**
 * Extract and normalize repository URL from package metadata
 *
 * @param repoField - Repository field from package.json (string or object)
 * @returns Normalized repository URL, or empty string if not found
 *
 * @remarks
 * - Removes git+ prefix (e.g., "git+https://..." → "https://...")
 * - Removes .git suffix (e.g., ".../.git" → "...")
 * - Handles both string URLs and nested URL objects
 */
function extractRepositoryUrl(
  repoField: string | { url?: string } | undefined
): string {
  if (!repoField) {
    return '';
  }

  let repoUrl = '';

  // Handle both string and object formats
  if (typeof repoField === 'string') {
    repoUrl = repoField;
  } else if (repoField.url) {
    repoUrl = repoField.url;
  }

  // Normalize: remove git+ prefix and .git suffix
  return repoUrl.replace(/^git\+/, '').replace(/\.git$/, '');
}

/**
 * Read license information for a single dependency
 *
 * @param depName - Package name to read
 * @returns LicenseInfo for the dependency, or null if reading fails
 *
 * @remarks
 * Gracefully handles missing packages or unreadable metadata.
 * Returns null (skipped) rather than throwing to avoid interrupting
 * the license generation process for all dependencies.
 */
function readDependencyLicense(depName: string): LicenseInfo | null {
  const depPath = path.join(projectRoot, 'node_modules', depName);

  // Check if dependency directory exists
  if (!fs.existsSync(depPath)) {
    console.warn(`Warning: ${depName} not found in node_modules`);
    return null;
  }

  // Read package.json metadata
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

  // Load license text
  const licenseText = loadLicenseText(depPath);

  // Extract repository URL
  const repoUrl = extractRepositoryUrl(depPackageJson.repository);

  return {
    name: depName,
    license: depPackageJson.license || 'UNKNOWN',
    text: licenseText,
    repository: repoUrl,
  };
}

/**
 * Create FFmpeg core license entry (LGPL 2.1+)
 *
 * @returns LicenseInfo entry for FFmpeg core
 *
 * @remarks
 * FFmpeg is included via ffmpeg.wasm. While the wrapper is MIT,
 * the underlying FFmpeg core is LGPL 2.1+. This must be prominently
 * displayed as a legal requirement.
 */
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

/**
 * Generate markdown content for licenses documentation
 *
 * @param licenses - Array of license information entries
 * @returns Formatted markdown string ready to write to file
 *
 * @remarks
 * Includes a header notice about FFmpeg LGPL requirements and
 * formats each license entry with name, license type, repository,
 * and license text in readable markdown format.
 */
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

/**
 * Write licenses file to disk
 *
 * @param content - Markdown content to write
 * @throws Error if directory creation or file write fails
 *
 * @remarks
 * Creates the output directory if it doesn't exist, then writes
 * the license content with UTF-8 encoding.
 */
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

// ============================================================
// Main Execution
// ============================================================

try {
  // Load root package.json to get dependencies list
  const packageJson = loadRootPackageJson();
  const dependencies = Object.keys(packageJson.dependencies || {});

  // Start with FFmpeg core license entry
  const licenses: LicenseInfo[] = [createFFmpegLicenseEntry()];

  // Read license information for each dependency
  for (const dep of dependencies) {
    const licenseInfo = readDependencyLicense(dep);
    if (licenseInfo) {
      licenses.push(licenseInfo);
    }
  }

  // Generate and write markdown output
  const output = generateMarkdownOutput(licenses);
  writeLicensesFile(output);

  // Success output
  console.log(`Generated ${OUTPUT_RELATIVE_PATH}`);
  console.log(`Found ${licenses.length} dependencies (including FFmpeg core)`);
} catch (error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`License generation failed: ${errorMessage}`);
  process.exit(1);
}
