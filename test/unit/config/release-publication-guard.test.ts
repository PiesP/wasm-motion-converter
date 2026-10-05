import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { decidePublication } from '../../../scripts/release/publication-guard';

const source = 'a'.repeat(40);
const otherSource = 'b'.repeat(40);
const branchSha = 'c'.repeat(40);
const candidate = { version: '0.2.10', commit: source };
const assetUrl = 'https://api.github.com/repos/PiesP/wasm-motion-converter/releases/assets/123';
const guardScript = resolve(import.meta.dirname, '../../../scripts/release/publication-guard.ts');
const execFileAsync = promisify(execFile);

function fixture(options: {
  deployed?: { version: string; commit: string } | 'missing-marker';
  releases?: Array<Record<string, unknown>>;
  latest?: string | null;
  tagCommit?: string;
  failure?: string;
  existingMetadata?: unknown;
} = {}) {
  const releases = options.releases ?? [];
  const calls: string[] = [];
  const request = async (path: string, accept?: string): Promise<unknown | null> => {
    calls.push(`${path}${accept ? ` ${accept}` : ''}`);
    if (options.failure === path) throw new Error('network failure');
    if (/^\/git\/ref\/tags\/v\d+\.\d+\.\d+$/.test(path)) {
      return { object: { type: 'commit', sha: options.tagCommit ?? source } };
    }
    if (path === '/git/ref/heads/release') {
      return options.deployed ? { object: { sha: branchSha } } : null;
    }
    if (path === `/contents/release-state.json?ref=${branchSha}`) {
      if (options.deployed === 'missing-marker') throw new Error('missing marker');
      return { encoding: 'base64', content: Buffer.from(JSON.stringify(options.deployed)).toString('base64') };
    }
    if (path.startsWith('/releases?')) return path.endsWith('page=1') ? releases : [];
    if (path === '/releases/latest') {
      const latest = options.latest === undefined ? releases[0]?.tag_name : options.latest;
      return latest ? { tag_name: latest } : null;
    }
    if (path === '/releases/assets/123') return options.existingMetadata ?? candidate;
    throw new Error(`Unexpected GitHub Git/Release API request: ${path}`);
  };
  return { request, calls };
}

function published(version: string, metadata = false): Record<string, unknown> {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: metadata ? [{ name: 'metadata.json', url: assetUrl }] : [],
  };
}

describe('release publication guard', () => {
  it('allows a genuine first publication after live tag, branch, and release checks', async () => {
    const { request, calls } = fixture();
    expect(await decidePublication(candidate, candidate, candidate, request)).toEqual({
      publishBranch: true,
      createRelease: true,
    });
    expect(calls).toEqual([
      '/git/ref/tags/v0.2.10', '/git/ref/heads/release',
      '/releases?per_page=100&page=1', '/releases/latest',
    ]);
  });

  it('compares numeric versions, rejecting 0.2.9 after 0.2.10', async () => {
    const older = { version: '0.2.9', commit: source };
    const { request } = fixture({ deployed: candidate, releases: [published('0.2.10')] });
    await expect(decidePublication(older, older, older, request)).rejects.toThrow('historical release');
  });

  it('rejects an older manual tag when the public release is newer even if the branch lags', async () => {
    const { request } = fixture({
      deployed: { version: '0.2.9', commit: otherSource },
      releases: [published('0.2.11')],
    });
    await expect(decidePublication(candidate, candidate, candidate, request)).rejects.toThrow('historical release');
  });

  it('retries release creation after the branch advanced, without rewriting the branch', async () => {
    const { request } = fixture({ deployed: candidate, releases: [published('0.2.9')] });
    expect(await decidePublication(candidate, candidate, candidate, request)).toEqual({
      publishBranch: false,
      createRelease: true,
    });
  });

  it('treats an already published same-source version as a read-only retry', async () => {
    const { request } = fixture({
      deployed: candidate,
      releases: [published('0.2.10', true)],
    });
    expect(await decidePublication(candidate, candidate, candidate, request)).toEqual({
      publishBranch: false,
      createRelease: false,
    });
  });

  it('rejects a same-version branch or release from another source', async () => {
    const branch = fixture({ deployed: { ...candidate, commit: otherSource } });
    await expect(decidePublication(candidate, candidate, candidate, branch.request)).rejects.toThrow('another source');
    const release = fixture({
      deployed: candidate,
      releases: [published('0.2.10', true)],
      existingMetadata: { ...candidate, commit: otherSource },
    });
    await expect(decidePublication(candidate, candidate, candidate, release.request)).rejects.toThrow('another source');
  });

  it('rejects missing legacy markers and releases without deployment branches', async () => {
    const legacy = fixture({ deployed: 'missing-marker', releases: [published('0.2.9')] });
    await expect(decidePublication(candidate, candidate, candidate, legacy.request)).rejects.toThrow('missing marker');
    const missingBranch = fixture({ releases: [published('0.2.9')] });
    await expect(decidePublication(candidate, candidate, candidate, missingBranch.request)).rejects.toThrow('branch is absent');
  });

  it('does not turn a partial draft of the requested tag into a published retry', async () => {
    const { request } = fixture({
      deployed: candidate,
      releases: [{ ...published('0.2.10', true), draft: true }],
      latest: null,
    });
    await expect(decidePublication(candidate, candidate, candidate, request)).rejects.toThrow('draft or prerelease');
  });

  it('rejects malformed, conflicting, unavailable, or moved live state', async () => {
    const badMarker = fixture({ deployed: { version: 'bad', commit: source } });
    await expect(decidePublication(candidate, candidate, candidate, badMarker.request)).rejects.toThrow('valid version');
    const conflictingLatest = fixture({ deployed: candidate, releases: [published('0.2.11')], latest: 'v0.2.9' });
    await expect(decidePublication(candidate, candidate, candidate, conflictingLatest.request)).rejects.toThrow('Latest');
    const unavailable = fixture({ failure: '/releases?per_page=100&page=1' });
    await expect(decidePublication(candidate, candidate, candidate, unavailable.request)).rejects.toThrow('network failure');
    const movedTag = fixture({ tagCommit: otherSource });
    await expect(decidePublication(candidate, candidate, candidate, movedTag.request)).rejects.toThrow('tag moved');
    const wrongBundle = fixture();
    await expect(decidePublication(candidate, { ...candidate, commit: otherSource }, candidate, wrongBundle.request)).rejects.toThrow('bundle');
    expect(wrongBundle.calls).toEqual([]);
  });

  it('executes the workflow command against mocked GitHub Git and Release APIs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'publication-guard-'));
    const bundle = join(directory, 'release-bundle');
    mkdirSync(join(bundle, 'dist'), { recursive: true });
    mkdirSync(join(bundle, 'release'), { recursive: true });
    writeFileSync(join(bundle, 'dist/release-state.json'), JSON.stringify(candidate));
    writeFileSync(join(bundle, 'release/metadata.json'), JSON.stringify(candidate));
    const output = join(directory, 'output');
    const calls: string[] = [];
    let failListing = false;
    const server = createServer((request, response) => {
      const path = request.url?.replace('/repos/PiesP/wasm-motion-converter', '') ?? '';
      calls.push(`${request.method} ${path}`);
      response.setHeader('Content-Type', 'application/json');
      if (failListing && path.startsWith('/releases?')) {
        response.writeHead(503).end('{}');
      } else if (path === '/git/ref/tags/v0.2.10') {
        response.end(JSON.stringify({ object: { type: 'commit', sha: source } }));
      } else if (path === '/git/ref/heads/release') {
        response.end(JSON.stringify({ object: { sha: branchSha } }));
      } else if (path === `/contents/release-state.json?ref=${branchSha}`) {
        response.end(JSON.stringify({
          encoding: 'base64',
          content: Buffer.from(JSON.stringify(candidate)).toString('base64'),
        }));
      } else if (path === '/releases?per_page=100&page=1') {
        response.end(JSON.stringify([published('0.2.9')]));
      } else if (path === '/releases/latest') {
        response.end(JSON.stringify({ tag_name: 'v0.2.9' }));
      } else {
        response.writeHead(404).end('{}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const run = () => execFileAsync(process.execPath, ['--experimental-strip-types', guardScript], {
        cwd: directory,
        env: {
          ...process.env,
          GITHUB_API_URL: `http://127.0.0.1:${port}`,
          GITHUB_REPOSITORY: 'PiesP/wasm-motion-converter',
          GITHUB_TOKEN: 'fixture-token',
          GITHUB_OUTPUT: output,
          RELEASE_VERSION: candidate.version,
          RELEASE_SHA: candidate.commit,
        },
      });
      await run();
      expect(readFileSync(output, 'utf8')).toBe('publish-branch=false\ncreate-release=true\n');
      expect(calls.every((call) => call.startsWith('GET '))).toBe(true);
      failListing = true;
      await expect(run()).rejects.toThrow();
      expect(readFileSync(output, 'utf8')).toBe('publish-branch=false\ncreate-release=true\n');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
