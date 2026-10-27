import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vite-plus/test';

import { decidePublication } from '../../../scripts/release/publication-guard';

const source = 'a'.repeat(40);
const otherSource = 'b'.repeat(40);
const branchSha = 'c'.repeat(40);
const candidate = { version: '0.2.10', commit: source };
const archiveName = `wasm-motion-converter-${candidate.version}.tar.gz`;
const guardScript = resolve(import.meta.dirname, '../../../scripts/release/publication-guard.ts');
const execFileAsync = promisify(execFile);
const publishedArchive = Buffer.from('synthetic archive');

function fixture(
  options: {
    deployed?: { version: string; commit: string } | 'missing-marker';
    releases?: Array<Record<string, unknown>>;
    latest?: string | null;
    tagCommit?: string;
    failure?: string;
    existingMetadata?: unknown;
    assetBytes?: Map<string, Buffer>;
  } = {}
) {
  const releases = options.releases ?? [];
  const calls: string[] = [];
  const limits = new Map<string, number | undefined>();
  const request = async (
    path: string,
    accept?: string,
    maxBytes?: number
  ): Promise<unknown | null> => {
    calls.push(`${path}${accept ? ` ${accept}` : ''}`);
    limits.set(path, maxBytes);
    if (options.failure === path) throw new Error('network failure');
    if (/^\/git\/ref\/tags\/v\d+\.\d+\.\d+$/.test(path)) {
      return { object: { type: 'commit', sha: options.tagCommit ?? source } };
    }
    if (path === '/git/ref/heads/release') {
      return options.deployed ? { object: { sha: branchSha } } : null;
    }
    if (path === `/contents/release-state.json?ref=${branchSha}`) {
      if (options.deployed === 'missing-marker') return null;
      return {
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(options.deployed)).toString('base64'),
      };
    }
    if (path.startsWith('/releases?')) return path.endsWith('page=1') ? releases : [];
    if (path === '/releases/latest') {
      const latest = options.latest === undefined ? releases[0]?.tag_name : options.latest;
      return latest ? { tag_name: latest } : null;
    }
    const bytes = (options.assetBytes ?? releaseBytes(options.existingMetadata)).get(path);
    if (bytes) return bytes;
    throw new Error(`Unexpected GitHub Git/Release API request: ${path}`);
  };
  return { request, calls, limits };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function releaseBytes(
  existingMetadata: unknown = candidate,
  checksums?: Buffer
): Map<string, Buffer> {
  const metadata = Buffer.from(JSON.stringify(existingMetadata));
  const archive = publishedArchive;
  return new Map([
    ['/releases/assets/123', metadata],
    ['/releases/assets/124', archive],
    [
      '/releases/assets/125',
      checksums ??
        Buffer.from(`${sha256(archive)}  ./${archiveName}\n${sha256(metadata)}  ./metadata.json\n`),
    ],
  ]);
}

function releaseAssets(bytes = releaseBytes()) {
  return ['metadata.json', archiveName, 'checksums.txt'].map((name, index) => {
    const id = 123 + index;
    const content = bytes.get(`/releases/assets/${id}`)!;
    return {
      id,
      name,
      state: 'uploaded',
      size: content.byteLength,
      digest: `sha256:${sha256(content)}`,
      url: `https://api.github.com/repos/PiesP/wasm-motion-converter/releases/assets/${id}`,
    };
  });
}

function invalidMetadataBytes(metadata: Buffer): Map<string, Buffer> {
  const bytes = releaseBytes();
  bytes.set('/releases/assets/123', metadata);
  bytes.set(
    '/releases/assets/125',
    Buffer.from(
      `${sha256(publishedArchive)}  ./${archiveName}\n${sha256(metadata)}  ./metadata.json\n`
    )
  );
  return bytes;
}

function published(
  version: string,
  complete = false,
  existingMetadata: unknown = candidate
): Record<string, unknown> {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: complete ? releaseAssets(releaseBytes(existingMetadata)) : [],
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
      '/git/ref/tags/v0.2.10',
      '/git/ref/heads/release',
      '/releases?per_page=100&page=1',
      '/releases/latest',
    ]);
  });

  it('compares numeric versions, rejecting 0.2.9 after 0.2.10', async () => {
    const older = { version: '0.2.9', commit: source };
    const { request } = fixture({ deployed: candidate, releases: [published('0.2.10')] });
    await expect(decidePublication(older, older, older, request)).rejects.toThrow(
      'historical release'
    );
  });

  it('rejects an older manual tag when the public release is newer even if the branch lags', async () => {
    const { request } = fixture({
      deployed: { version: '0.2.9', commit: otherSource },
      releases: [published('0.2.11')],
    });
    await expect(decidePublication(candidate, candidate, candidate, request)).rejects.toThrow(
      'historical release'
    );
  });

  it('retries release creation after the branch advanced, without rewriting the branch', async () => {
    const { request } = fixture({ deployed: candidate, releases: [published('0.2.9')] });
    expect(await decidePublication(candidate, candidate, candidate, request)).toEqual({
      publishBranch: false,
      createRelease: true,
    });
  });

  it('treats an already published same-source version as a read-only retry', async () => {
    const historicalMetadata = { ...candidate, build_date: '2020-01-01T00:00:00.000Z' };
    const { request, limits } = fixture({
      deployed: candidate,
      releases: [published('0.2.10', true, historicalMetadata)],
      existingMetadata: historicalMetadata,
    });
    expect(
      await decidePublication(
        candidate,
        candidate,
        { ...candidate, build_date: '2026-10-05T00:00:00.000Z' },
        request
      )
    ).toEqual({
      publishBranch: false,
      createRelease: false,
    });
    expect(limits.get('/releases/assets/123')).toBe(16 * 1024);
    expect(limits.get('/releases/assets/124')).toBe(20 * 1024 * 1024);
    expect(limits.get('/releases/assets/125')).toBe(16 * 1024);
  });

  it('allows an additional asset with a different name and identity', async () => {
    const assets = [
      ...releaseAssets(),
      {
        ...releaseAssets()[0]!,
        id: 126,
        name: 'notes.txt',
        url: 'https://api.github.com/repos/PiesP/wasm-motion-converter/releases/assets/126',
      },
    ];
    const { request, calls } = fixture({
      deployed: candidate,
      releases: [{ ...published(candidate.version), assets }],
    });
    expect(await decidePublication(candidate, candidate, candidate, request)).toEqual({
      publishBranch: false,
      createRelease: false,
    });
    expect(calls.some((call) => call.startsWith('/releases/assets/126'))).toBe(false);
  });

  it('rejects a metadata-only published release as incomplete', async () => {
    const { request } = fixture({
      deployed: candidate,
      releases: [{ ...published(candidate.version), assets: releaseAssets().slice(0, 1) }],
    });
    await expect(decidePublication(candidate, candidate, candidate, request)).rejects.toThrow(
      'incomplete'
    );
  });

  for (const name of ['metadata.json', archiveName, 'checksums.txt']) {
    const invalidFields = [
      ['pending', { state: 'starter' }],
      ['zero size', { size: 0 }],
      ['negative size', { size: -1 }],
      ['fractional size', { size: 1.5 }],
      ['unsafe size', { size: Number.MAX_SAFE_INTEGER + 1 }],
      ['oversized', { size: 20 * 1024 * 1024 + 1 }],
      ['invalid digest', { digest: 'sha256:bad' }],
      ['wrong digest', { digest: `sha256:${'0'.repeat(64)}` }],
      ['invalid ID', { id: 0 }],
      ['unsafe ID', { id: Number.MAX_SAFE_INTEGER + 1 }],
      ['ID/URL disagreement', { id: 999 }],
      ['invalid URL', { url: 'https://example.com/asset' }],
    ] as const;
    it(`rejects missing or duplicate ${name}`, async () => {
      const assets = releaseAssets();
      for (const incomplete of [
        assets.filter((entry) => entry.name !== name),
        [...assets, assets.find((entry) => entry.name === name)!],
      ]) {
        const { request } = fixture({
          deployed: candidate,
          releases: [{ ...published(candidate.version), assets: incomplete }],
        });
        await expect(decidePublication(candidate, candidate, candidate, request)).rejects.toThrow(
          'incomplete or unverifiable'
        );
      }
    });
    it.each(invalidFields)(`rejects ${name} with %s evidence`, async (_label, fields) => {
      const assets = releaseAssets().map((entry) =>
        entry.name === name ? { ...entry, ...fields } : entry
      );
      const { request } = fixture({
        deployed: candidate,
        releases: [{ ...published(candidate.version), assets }],
      });
      await expect(decidePublication(candidate, candidate, candidate, request)).rejects.toThrow(
        'incomplete or unverifiable'
      );
    });
    it(`rejects unreadable or size-mismatched ${name}`, async () => {
      const assets = releaseAssets();
      const path = `/releases/assets/${assets.find((entry) => entry.name === name)!.id}`;
      const unreadable = fixture({
        deployed: candidate,
        releases: [{ ...published(candidate.version), assets }],
        failure: path,
      });
      await expect(
        decidePublication(candidate, candidate, candidate, unreadable.request)
      ).rejects.toThrow('incomplete or unverifiable');
      const bytes = releaseBytes();
      bytes.set(path, Buffer.from('truncated'));
      const mismatched = fixture({
        deployed: candidate,
        releases: [{ ...published(candidate.version), assets }],
        assetBytes: bytes,
      });
      await expect(
        decidePublication(candidate, candidate, candidate, mismatched.request)
      ).rejects.toThrow('incomplete or unverifiable');
    });
  }

  it('rejects required assets sharing a numeric identity or download URL', async () => {
    const assets = releaseAssets();
    assets[1] = { ...assets[1]!, id: assets[0]!.id, url: assets[0]!.url };
    const { request } = fixture({
      deployed: candidate,
      releases: [{ ...published(candidate.version), assets }],
    });
    await expect(decidePublication(candidate, candidate, candidate, request)).rejects.toThrow(
      'incomplete or unverifiable'
    );
  });

  it.each([
    [
      'missing entry',
      Buffer.from(`${sha256(releaseBytes().get('/releases/assets/124')!)}  ./${archiveName}\n`),
    ],
    [
      'duplicate entry',
      Buffer.from(`${'0'.repeat(64)}  ./metadata.json\n${'0'.repeat(64)}  ./metadata.json\n`),
    ],
    [
      'mismatched hash',
      Buffer.from(`${'0'.repeat(64)}  ./${archiveName}\n${'0'.repeat(64)}  ./metadata.json\n`),
    ],
    [
      'unsupported entry',
      Buffer.from(`${'0'.repeat(64)}  ./checksums.txt\n${'0'.repeat(64)}  ./metadata.json\n`),
    ],
    [
      'malformed format',
      Buffer.from(`${'0'.repeat(64)} ${archiveName}\n${'0'.repeat(64)} metadata.json\n`),
    ],
    [
      'extra entry',
      Buffer.concat([
        releaseBytes().get('/releases/assets/125')!,
        Buffer.from(`${'0'.repeat(64)}  ./extra.txt\n`),
      ]),
    ],
    ['invalid UTF-8', Buffer.from([0xff])],
  ])('rejects checksums with %s', async (_label, checksums) => {
    const bytes = releaseBytes(candidate, checksums);
    const { request } = fixture({
      deployed: candidate,
      releases: [{ ...published(candidate.version), assets: releaseAssets(bytes) }],
      assetBytes: bytes,
    });
    await expect(decidePublication(candidate, candidate, candidate, request)).rejects.toThrow(
      'incomplete or unverifiable'
    );
  });

  it.each([
    ['malformed JSON', Buffer.from('{')],
    ['invalid UTF-8', Buffer.from([0xff])],
  ])('rejects historical metadata with %s despite consistent digests', async (_label, metadata) => {
    const bytes = invalidMetadataBytes(metadata);
    const { request } = fixture({
      deployed: candidate,
      releases: [{ ...published(candidate.version), assets: releaseAssets(bytes) }],
      assetBytes: bytes,
    });
    await expect(decidePublication(candidate, candidate, candidate, request)).rejects.toThrow(
      'incomplete or unverifiable'
    );
  });

  it('rejects a same-version branch or release from another source', async () => {
    const branch = fixture({ deployed: { ...candidate, commit: otherSource } });
    await expect(
      decidePublication(candidate, candidate, candidate, branch.request)
    ).rejects.toThrow('another source');
    const release = fixture({
      deployed: candidate,
      releases: [published('0.2.10', true, { ...candidate, commit: otherSource })],
      existingMetadata: { ...candidate, commit: otherSource },
    });
    await expect(
      decidePublication(candidate, candidate, candidate, release.request)
    ).rejects.toThrow('another source');
  });

  it('rejects published releases without deployment branches', async () => {
    const missingBranch = fixture({ releases: [published('0.2.9')] });
    await expect(
      decidePublication(candidate, candidate, candidate, missingBranch.request)
    ).rejects.toThrow('branch is absent');
  });

  it('does not turn a partial draft of the requested tag into a published retry', async () => {
    const { request } = fixture({
      deployed: candidate,
      releases: [{ ...published('0.2.10', true), draft: true }],
      latest: null,
    });
    await expect(decidePublication(candidate, candidate, candidate, request)).rejects.toThrow(
      'draft or prerelease'
    );
  });

  it('rejects an existing branch without a deployment marker before considering a write', async () => {
    const { request, calls } = fixture({ deployed: 'missing-marker' });
    await expect(decidePublication(candidate, candidate, candidate, request)).rejects.toThrow(
      'release-state.json'
    );
    expect(calls).toEqual([
      '/git/ref/tags/v0.2.10',
      '/git/ref/heads/release',
      `/contents/release-state.json?ref=${branchSha}`,
    ]);
  });

  it('rejects malformed, conflicting, unavailable, or moved live state', async () => {
    const badMarker = fixture({ deployed: { version: 'bad', commit: source } });
    await expect(
      decidePublication(candidate, candidate, candidate, badMarker.request)
    ).rejects.toThrow('valid version');
    const conflictingLatest = fixture({
      deployed: candidate,
      releases: [published('0.2.11')],
      latest: 'v0.2.9',
    });
    await expect(
      decidePublication(candidate, candidate, candidate, conflictingLatest.request)
    ).rejects.toThrow('Latest');
    const unavailable = fixture({ failure: '/releases?per_page=100&page=1' });
    await expect(
      decidePublication(candidate, candidate, candidate, unavailable.request)
    ).rejects.toThrow('network failure');
    const movedTag = fixture({ tagCommit: otherSource });
    await expect(
      decidePublication(candidate, candidate, candidate, movedTag.request)
    ).rejects.toThrow('tag moved');
    const wrongBundle = fixture();
    await expect(
      decidePublication(
        candidate,
        { ...candidate, commit: otherSource },
        candidate,
        wrongBundle.request
      )
    ).rejects.toThrow('bundle');
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
    let publicRelease = published('0.2.9');
    let assetBytes = releaseBytes();
    let failurePath = '';
    let failureStatus = 503;
    let markerStatus: 'present' | 'missing' | 'malformed' = 'present';
    const server = createServer((request, response) => {
      const path = request.url?.replace('/repos/PiesP/wasm-motion-converter', '') ?? '';
      calls.push(`${request.method} ${path}`);
      response.setHeader('Content-Type', 'application/json');
      if (path === failurePath) {
        response.writeHead(failureStatus).end('{}');
      } else if (failListing && path.startsWith('/releases?')) {
        response.writeHead(503).end('{}');
      } else if (path === '/git/ref/tags/v0.2.10') {
        response.end(JSON.stringify({ object: { type: 'commit', sha: source } }));
      } else if (path === '/git/ref/heads/release') {
        response.end(JSON.stringify({ object: { sha: branchSha } }));
      } else if (path === `/contents/release-state.json?ref=${branchSha}`) {
        if (markerStatus === 'missing') {
          response.writeHead(404).end('{}');
        } else {
          response.end(
            JSON.stringify({
              encoding: 'base64',
              content: Buffer.from(
                JSON.stringify(markerStatus === 'malformed' ? { version: 'bad' } : candidate)
              ).toString('base64'),
            })
          );
        }
      } else if (path === '/releases?per_page=100&page=1') {
        response.end(JSON.stringify([publicRelease]));
      } else if (path === '/releases/latest') {
        response.end(JSON.stringify({ tag_name: publicRelease.tag_name }));
      } else if (assetBytes.has(path)) {
        response.setHeader('Content-Type', 'application/octet-stream');
        response.end(assetBytes.get(path));
      } else {
        response.writeHead(404).end('{}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const run = (outputPath = output) =>
        execFileAsync(process.execPath, ['--experimental-strip-types', guardScript], {
          cwd: directory,
          env: {
            ...process.env,
            GITHUB_API_URL: `http://127.0.0.1:${port}`,
            GITHUB_REPOSITORY: 'PiesP/wasm-motion-converter',
            GITHUB_TOKEN: 'fixture-token',
            GITHUB_OUTPUT: outputPath,
            RELEASE_VERSION: candidate.version,
            RELEASE_SHA: candidate.commit,
          },
        });
      for (const invalidMarker of ['missing', 'malformed'] as const) {
        markerStatus = invalidMarker;
        const rejectedOutput = join(directory, `marker-${invalidMarker}`);
        writeFileSync(rejectedOutput, 'sentinel\n');
        const before = calls.length;
        await expect(run(rejectedOutput)).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining(
            invalidMarker === 'missing' ? 'release-state.json' : 'valid version'
          ),
          stdout: '',
        });
        expect(readFileSync(rejectedOutput, 'utf8')).toBe('sentinel\n');
        expect(calls.slice(before)).toEqual([
          'GET /git/ref/tags/v0.2.10',
          'GET /git/ref/heads/release',
          `GET /contents/release-state.json?ref=${branchSha}`,
        ]);
      }
      markerStatus = 'present';
      await run();
      expect(readFileSync(output, 'utf8')).toBe('publish-branch=false\ncreate-release=true\n');
      expect(calls.every((call) => call.startsWith('GET '))).toBe(true);
      failListing = true;
      await expect(run()).rejects.toThrow();
      expect(readFileSync(output, 'utf8')).toBe('publish-branch=false\ncreate-release=true\n');
      failListing = false;
      publicRelease = published(candidate.version, true);
      const completedOutput = join(directory, 'completed-output');
      await run(completedOutput);
      expect(readFileSync(completedOutput, 'utf8')).toBe(
        'publish-branch=false\ncreate-release=false\n'
      );

      const malformedChecksumBytes = releaseBytes(candidate, Buffer.from('invalid checksums'));
      const invalidUtf8Bytes = releaseBytes(candidate, Buffer.from([0xff]));
      const malformedMetadataBytes = invalidMetadataBytes(Buffer.from('{'));
      const negatives = [
        { name: 'metadata-only', assets: releaseAssets().slice(0, 1) },
        { name: 'missing-metadata', assets: releaseAssets().slice(1) },
        { name: 'missing-checksums', assets: releaseAssets().slice(0, 2) },
        { name: 'duplicate', assets: [...releaseAssets(), releaseAssets()[1]!] },
        {
          name: 'pending',
          assets: releaseAssets().map((asset) => ({ ...asset, state: 'starter' })),
        },
        { name: 'zero-size', assets: releaseAssets().map((asset) => ({ ...asset, size: 0 })) },
        {
          name: 'malformed-checksum',
          assets: releaseAssets(malformedChecksumBytes),
          bytes: malformedChecksumBytes,
        },
        { name: 'invalid-utf8', assets: releaseAssets(invalidUtf8Bytes), bytes: invalidUtf8Bytes },
        {
          name: 'malformed-metadata',
          assets: releaseAssets(malformedMetadataBytes),
          bytes: malformedMetadataBytes,
        },
        {
          name: 'digest-mismatch',
          assets: releaseAssets().map((asset) => ({
            ...asset,
            digest: `sha256:${'0'.repeat(64)}`,
          })),
        },
        ...[123, 124, 125].map((id) => ({
          name: `unreadable-${id}`,
          assets: releaseAssets(),
          failure: `/releases/assets/${id}`,
        })),
        {
          name: 'missing-remote-asset',
          assets: releaseAssets(),
          failure: '/releases/assets/124',
          status: 404,
        },
      ];
      for (const negative of negatives) {
        publicRelease = { ...published(candidate.version), assets: negative.assets };
        assetBytes = 'bytes' in negative && negative.bytes ? negative.bytes : releaseBytes();
        failurePath = 'failure' in negative && negative.failure ? negative.failure : '';
        failureStatus = 'status' in negative && negative.status ? negative.status : 503;
        const rejectedOutput = join(directory, negative.name);
        writeFileSync(rejectedOutput, 'sentinel\n');
        await expect(run(rejectedOutput)).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining('incomplete or unverifiable'),
          stdout: '',
        });
        expect(readFileSync(rejectedOutput, 'utf8')).toBe('sentinel\n');
      }
      expect(calls.every((call) => call.startsWith('GET '))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
