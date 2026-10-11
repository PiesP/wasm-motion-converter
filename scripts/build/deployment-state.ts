import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface DeploymentFile {
  path: string;
  size: number;
  sha256: string;
}

export interface DeploymentState {
  schemaVersion: 1;
  sourceSha: string;
  treeSha: string;
  coreSha: string;
  version: string;
  branch: string;
  sourceDirty: boolean;
  headersSha256: string;
  files: DeploymentFile[];
}

const sourceShaPattern = /^[a-f0-9]{40}$/;
const fingerprintedAsset = /^[\w.-]+[.-][\w-]{8}\.(js|css|wasm)$/;

export function fingerprintedAssetHeaders(template: string, assets: string[]): string {
  const rules = assets.filter((asset) => fingerprintedAsset.test(asset)).sort();
  if (rules.length + 6 > 100) throw new Error('Pages header rule limit exceeded');
  return `${template.trimEnd()}\n\n# Emitted fingerprinted assets only; missing paths keep Pages revalidation.\n${rules
    .map((asset) => `/assets/${asset}\n  Cache-Control: public, max-age=31536000, immutable\n`)
    .join('\n')}`;
}

export function distributionFiles(dist: string): DeploymentFile[] {
  const files: DeploymentFile[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        visit(path);
      } else {
        const key = relative(dist, path).replaceAll('\\', '/');
        if (
          [
            'deployment-state.json',
            '_headers',
            '_redirects',
            '_routes.json',
            '_worker.js',
          ].includes(key)
        )
          continue;
        const bytes = readFileSync(path);
        files.push({
          path: key,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  };
  visit(dist);
  return files;
}

function readSource(root: string): { sourceSha: string; sourceDirty: boolean } | null {
  const git = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  let sourceSha: string;
  try {
    sourceSha = git(['rev-parse', 'HEAD']);
  } catch (error) {
    if (process.env.CF_PAGES) throw error;
    return null;
  }
  if (!sourceShaPattern.test(sourceSha)) throw new Error('Invalid build source SHA');
  if (process.env.CF_PAGES_COMMIT_SHA && process.env.CF_PAGES_COMMIT_SHA !== sourceSha) {
    throw new Error('Pages source SHA does not match checked-out source');
  }
  return {
    sourceSha,
    sourceDirty: git(['status', '--porcelain', '--untracked-files=all'])
      .split('\n')
      .some((line) => line && !line.endsWith(' public/LICENSES.md')),
  };
}

// Compile the running app's identity, never a version or metadata fetched later.
// Dirty and non-Git local builds cannot claim an exact checked-in source.
export function applicationSourceSha(root: string): string | null {
  const source = readSource(root);
  return source && !source.sourceDirty ? source.sourceSha : null;
}

export function writeDeploymentState(root: string, dist: string): void {
  const source = readSource(root);
  if (!source) {
    console.log('[postbuild] Source metadata unavailable outside a Git checkout');
    return;
  }
  const git = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const coreSha = git(['rev-parse', 'HEAD:packages/core']);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version: string;
  };
  const state: DeploymentState = {
    schemaVersion: 1,
    sourceSha: source.sourceSha,
    treeSha: git(['rev-parse', 'HEAD^{tree}']),
    coreSha,
    version: manifest.version,
    branch: process.env.CF_PAGES_BRANCH || git(['rev-parse', '--abbrev-ref', 'HEAD']),
    sourceDirty: source.sourceDirty,
    headersSha256: createHash('sha256')
      .update(readFileSync(join(dist, '_headers')))
      .digest('hex'),
    files: distributionFiles(dist),
  };
  writeFileSync(join(dist, 'deployment-state.json'), `${JSON.stringify(state, null, 2)}\n`);
  console.log(
    `[postbuild] Recorded source ${source.sourceSha} and ${state.files.length} public files`
  );
}
