import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const distDir = join(root, 'dist');
const bundleDir = join(root, 'release-bundle');
const releaseDir = join(bundleDir, 'release');

const version = process.env.RELEASE_VERSION;
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('RELEASE_VERSION must be a semantic version in X.Y.Z form.');
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version?: string;
};
if (packageJson.version !== version) {
  throw new Error(
    `Release version ${version} does not match package.json ${packageJson.version ?? '(missing)'}.`
  );
}
if (!existsSync(distDir)) {
  throw new Error('dist/ does not exist. Run the production build before preparing a release.');
}

function changelogEntry(markdown: string, releaseVersion: string): string {
  const lines = markdown.split(/\r?\n/);
  const heading = new RegExp(`^## \\[${releaseVersion.replaceAll('.', '\\.')}\\](?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) {
    throw new Error(`CHANGELOG.md has no entry for version ${releaseVersion}.`);
  }
  const next = lines.findIndex((line, index) => index > start && /^## \[/.test(line));
  const entry = lines
    .slice(start + 1, next < 0 ? undefined : next)
    .join('\n')
    .trim();
  if (!entry) {
    throw new Error(`CHANGELOG.md entry for version ${releaseVersion} is empty.`);
  }
  return entry;
}

rmSync(bundleDir, { force: true, recursive: true });
mkdirSync(releaseDir, { recursive: true });
cpSync(distDir, join(bundleDir, 'dist'), { recursive: true });

const archiveName = `wasm-motion-converter-${version}.tar.gz`;
const archivePath = join(releaseDir, archiveName);
execFileSync(
  'tar',
  [
    '--sort=name',
    '--mtime=@0',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '-czf',
    archivePath,
    '-C',
    distDir,
    '.',
  ],
  { stdio: 'inherit' }
);

const buildDate = new Date().toISOString();
const commit = process.env.GITHUB_SHA ?? 'unknown';
const nodeVersion = process.env.NODE_VERSION ?? process.versions.node;
const runnerOs = process.env.RUNNER_OS ?? process.platform;
const runnerArch = process.env.RUNNER_ARCH ?? process.arch;
const runnerImage = process.env.ImageOS ?? 'unknown';
const runnerImageVersion = process.env.ImageVersion ?? 'unknown';

const metadataPath = join(releaseDir, 'metadata.json');
writeFileSync(
  metadataPath,
  `${JSON.stringify(
    {
      version,
      build_date: buildDate,
      commit,
      node_version: nodeVersion,
      runner_os: runnerOs,
      runner_arch: runnerArch,
      runner_image: runnerImage,
      runner_image_version: runnerImageVersion,
    },
    null,
    2
  )}\n`
);

const releaseAssets = [archivePath, metadataPath];
const checksumLines = releaseAssets.map((path) => {
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  return `${digest}  ./${basename(path)}`;
});
writeFileSync(join(releaseDir, 'checksums.txt'), `${checksumLines.join('\n')}\n`);

const changes = changelogEntry(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version);
const releaseNotes = `# 🚀 Release v${version}

## 📝 What's Changed

${changes}

## 📋 Build Details

- **Commit**: \`${commit}\`
- **Built**: ${buildDate.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}
- **Node.js**: \`${nodeVersion}\`
- **Runner**: \`${runnerOs}/${runnerArch}\` (\`${runnerImage} ${runnerImageVersion}\`)
`;
writeFileSync(join(bundleDir, 'RELEASE_NOTES.md'), releaseNotes);

console.log(`Prepared release-bundle/ for v${version} (${checksumLines.length} release assets).`);
