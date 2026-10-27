#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const stableTag = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
const commitSha = /^[0-9a-f]{40}$/;
const exactNodeVersion = /^[0-9]+\.[0-9]+\.[0-9]+$/;

function matchesExactly(pattern: RegExp, value: string): boolean {
  return pattern.exec(value)?.[0] === value;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function taggedNodeVersion(sha: string, releaseVersion: string): string {
  const manifest = JSON.parse(git(['show', `${sha}:package.json`])) as unknown;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error('Invalid release source manifest');
  const volta = (manifest as { volta?: unknown }).volta;
  const legacyVersion =
    volta && typeof volta === 'object' && !Array.isArray(volta)
      ? (volta as { node?: unknown }).node
      : undefined;
  const nodeEntry = git(['ls-tree', sha, '--', '.node-version']);
  let fileVersion: string | undefined;
  if (nodeEntry) {
    const regularBlob = /^100644 blob ([0-9a-f]{40})\t\.node-version$/u.exec(nodeEntry)?.[1];
    if (!regularBlob) throw new Error('Release source .node-version must be a regular 100644 blob');
    // Read failures are fatal. Only a truly absent tree entry can use the
    // historical Volta pin, which predates the file authority.
    fileVersion = git(['cat-file', 'blob', regularBlob]);
  }
  if (fileVersion !== undefined && !matchesExactly(exactNodeVersion, fileVersion))
    throw new Error('Release source must declare an exact .node-version pin');
  if (
    legacyVersion !== undefined &&
    (typeof legacyVersion !== 'string' || !matchesExactly(exactNodeVersion, legacyVersion))
  )
    throw new Error('Release source has an invalid legacy volta.node pin');
  if (fileVersion !== undefined && legacyVersion !== undefined && fileVersion !== legacyVersion)
    throw new Error('Release source Node pins disagree');
  const version = fileVersion ?? legacyVersion;
  if (typeof version !== 'string')
    throw new Error(
      'Release source must declare an exact .node-version or historical volta.node pin'
    );
  // A historical Volta-only tag can use the numeric runtime override in the
  // qualified provider, but only if its Vite+ catalog is also supported.
  let workspace: string;
  try {
    workspace = git(['show', `${sha}:pnpm-workspace.yaml`]);
  } catch {
    throw new Error('Release source predates supported Vite+ setup');
  }
  if (!/^  vite-plus: \d+\.\d+\.\d+$/mu.test(workspace))
    throw new Error('Release source lacks an exact Vite+ catalog pin');
  const sourceVersion = (manifest as { version?: unknown }).version;
  if (sourceVersion !== releaseVersion)
    throw new Error(
      `Tag version ${releaseVersion} does not match package.json ${String(sourceVersion)}`
    );
  const scripts = (manifest as { scripts?: unknown }).scripts;
  if (
    !scripts ||
    typeof scripts !== 'object' ||
    Array.isArray(scripts) ||
    !Object.values(scripts).every((script) => typeof script === 'string')
  )
    throw new Error('Release source must declare a valid scripts map');
  if (Object.hasOwn(scripts, 'quality:nose'))
    throw new Error('Release source must not declare quality:nose');
  return version;
}

export function verifySource(): void {
  const tag = required('RELEASE_TAG');
  if (!matchesExactly(stableTag, tag))
    throw new Error(`Invalid release tag: ${tag} (expected vX.Y.Z)`);
  const protectedSha = required('GITHUB_SHA');
  if (!matchesExactly(commitSha, protectedSha)) throw new Error('Invalid protected workflow SHA');
  const output = required('GITHUB_OUTPUT');

  git(['fetch', '--force', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]);
  const releaseSha = git(['rev-parse', '--verify', `${tag}^{commit}`]);
  if (!matchesExactly(commitSha, releaseSha)) throw new Error('Invalid resolved release commit');
  try {
    git(['merge-base', '--is-ancestor', releaseSha, protectedSha]);
  } catch {
    throw new Error(`Release tag ${tag} is not contained in protected master ${protectedSha}`);
  }

  const nodeVersion = taggedNodeVersion(releaseSha, tag.slice(1));
  appendFileSync(
    output,
    `node-version=${nodeVersion}\nrelease-sha=${releaseSha}\nversion=${tag.slice(1)}\n`
  );
}

if (import.meta.main) {
  try {
    verifySource();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    const failure = error as { status?: number; signal?: string };
    process.exitCode =
      failure.signal === 'SIGINT'
        ? 130
        : failure.signal === 'SIGTERM'
          ? 143
          : (failure.status ?? 1);
  }
}
