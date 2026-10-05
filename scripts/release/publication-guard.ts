import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { downloadAsset, proveLegacyDeployment } from './legacy-state.ts';

type Identity = { version: string; commit: string };
type Decision = { publishBranch: boolean; createRelease: boolean };
type Request = (path: string, accept?: string, maxBytes?: number) => Promise<unknown | null>;

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^[0-9a-f]{40}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

function identity(value: unknown, label: string): Identity {
  const data = record(value, label);
  if (
    typeof data.version !== 'string' ||
    !versionPattern.test(data.version) ||
    typeof data.commit !== 'string' ||
    !shaPattern.test(data.commit)
  ) {
    throw new Error(`${label} has no valid version and tagged commit`);
  }
  return { version: data.version, commit: data.commit };
}

function compareVersions(left: string, right: string): number {
  const a = versionPattern.exec(left);
  const b = versionPattern.exec(right);
  if (!a || !b) throw new Error('Cannot compare malformed release versions');
  for (let i = 1; i <= 3; i++) {
    const first = BigInt(a[i]!);
    const second = BigInt(b[i]!);
    if (first < second) return -1;
    if (first > second) return 1;
  }
  return 0;
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.version === right.version && left.commit === right.commit;
}

async function tagCommit(request: Request, tag: string): Promise<string> {
  const ref = record(await request(`/git/ref/tags/${tag}`), 'release tag ref');
  let object = record(ref.object, 'release tag object');
  for (let depth = 0; depth < 5; depth++) {
    if (typeof object.sha !== 'string' || !shaPattern.test(object.sha)) {
      throw new Error('Release tag has no valid object SHA');
    }
    if (object.type === 'commit') return object.sha;
    if (object.type !== 'tag') throw new Error('Release tag does not target a commit');
    const tagObject = record(await request(`/git/tags/${object.sha}`), 'annotated tag');
    object = record(tagObject.object, 'annotated tag object');
  }
  throw new Error('Release tag chain is too deep');
}

async function verifyPublishedRelease(
  release: Record<string, unknown>,
  requested: Identity,
  request: Request
): Promise<void> {
  try {
    const archiveName = `wasm-motion-converter-${requested.version}.tar.gz`;
    const limits = new Map([
      [archiveName, 20 * 1024 * 1024],
      ['metadata.json', 16 * 1024],
      ['checksums.txt', 16 * 1024],
    ]);
    if (!Array.isArray(release.assets)) throw new Error('Published assets are malformed');
    const assets = release.assets.map((value) => record(value, 'published asset'));
    const ids = new Set<number>();
    for (const [name, limit] of limits) {
      const matches = assets.filter((entry) => entry.name === name);
      if (matches.length !== 1) throw new Error(`No unique ${name} asset`);
      const entry = matches[0]!;
      if (
        entry.state !== 'uploaded' ||
        typeof entry.id !== 'number' ||
        !Number.isSafeInteger(entry.id) ||
        entry.id < 1 ||
        ids.has(entry.id) ||
        typeof entry.url !== 'string' ||
        !entry.url.endsWith(`/releases/assets/${entry.id}`) ||
        typeof entry.size !== 'number' ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 1 ||
        entry.size > limit ||
        typeof entry.digest !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/.test(entry.digest)
      ) {
        throw new Error(`${name} has invalid upload status, identity, size, or digest`);
      }
      ids.add(entry.id);
    }

    const downloads = new Map<string, Uint8Array>();
    for (const [name, limit] of limits) {
      downloads.set(name, await downloadAsset(release, name, limit, request));
    }
    const lines = new TextDecoder('utf-8', { fatal: true })
      .decode(downloads.get('checksums.txt')!)
      .split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.length !== 2) throw new Error('checksums.txt must contain two expected entries');
    const remaining = new Set([archiveName, 'metadata.json']);
    for (const line of lines) {
      const match = /^([0-9a-f]{64}) {2}\.\/(.+)$/.exec(line);
      if (!match || !remaining.delete(match[2]!)) {
        throw new Error('checksums.txt has a malformed, duplicate, or unexpected entry');
      }
      const digest = createHash('sha256').update(downloads.get(match[2]!)!).digest('hex');
      if (match[1] !== digest) throw new Error(`checksums.txt disagrees with ${match[2]}`);
    }
    const metadata = identity(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(downloads.get('metadata.json')!)),
      'existing release metadata'
    );
    if (!sameIdentity(requested, metadata)) {
      throw new Error('Existing release metadata has another source');
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Existing published release is incomplete or unverifiable: ${detail}`, {
      cause: error,
    });
  }
}

export async function decidePublication(
  candidate: Identity,
  artifactState: unknown,
  artifactMetadata: unknown,
  request: Request
): Promise<Decision> {
  const requested = identity(candidate, 'requested release');
  if (
    !sameIdentity(requested, identity(artifactState, 'bundle deployment marker')) ||
    !sameIdentity(requested, identity(artifactMetadata, 'bundle asset metadata'))
  ) {
    throw new Error('Release bundle does not match the verified tagged source');
  }
  if ((await tagCommit(request, `v${requested.version}`)) !== requested.commit) {
    throw new Error('Release tag moved after source verification');
  }

  const branchRef = await request('/git/ref/heads/release');
  let deployed: Identity | null = null;
  let legacyBranchSha: string | null = null;
  if (branchRef !== null) {
    const branchSha = record(
      record(branchRef, 'release branch ref').object,
      'release branch object'
    ).sha;
    if (typeof branchSha !== 'string' || !shaPattern.test(branchSha)) {
      throw new Error('Release branch has no valid commit SHA');
    }
    const marker = await request(`/contents/release-state.json?ref=${branchSha}`);
    if (marker === null) {
      legacyBranchSha = branchSha;
    } else {
      const file = record(marker, 'release branch marker');
      if (file.encoding !== 'base64' || typeof file.content !== 'string') {
        throw new Error('Release branch marker has no base64 content');
      }
      deployed = identity(
        JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')),
        'release branch marker'
      );
    }
  }

  const published: Array<{ identity: Identity; release: Record<string, unknown> }> = [];
  for (let page = 1; page <= 100; page++) {
    const response = await request(`/releases?per_page=100&page=${page}`);
    if (!Array.isArray(response)) throw new Error('Release listing is malformed');
    for (const item of response) {
      const release = record(item, 'published release');
      if (
        typeof release.draft !== 'boolean' ||
        typeof release.prerelease !== 'boolean' ||
        typeof release.tag_name !== 'string'
      ) {
        throw new Error('Published release has malformed status or tag');
      }
      if (release.tag_name === `v${requested.version}` && (release.draft || release.prerelease)) {
        throw new Error('Requested tag already has a draft or prerelease');
      }
      if (release.draft || release.prerelease) continue;
      const match = /^v(.*)$/.exec(release.tag_name);
      if (!match || !versionPattern.test(match[1]!)) {
        throw new Error(`Published release tag is not a stable version: ${release.tag_name}`);
      }
      published.push({ identity: { version: match[1]!, commit: '' }, release });
    }
    if (response.length < 100) break;
    if (page === 100) throw new Error('Release listing exceeds the supported pagination limit');
  }

  const latest = await request('/releases/latest');
  if ((latest === null) !== (published.length === 0)) {
    throw new Error('Latest release and published release listing disagree');
  }
  let highest: string | null = null;
  for (const entry of published) {
    if (highest === null || compareVersions(entry.identity.version, highest) > 0) {
      highest = entry.identity.version;
    }
  }
  if (latest !== null) {
    const latestTag = record(latest, 'latest release').tag_name;
    if (latestTag !== `v${highest}`) {
      throw new Error('Latest does not identify the highest published stable version');
    }
  }
  if (highest !== null && compareVersions(requested.version, highest) < 0) {
    throw new Error(`Refusing historical release v${requested.version}; latest is v${highest}`);
  }
  if (legacyBranchSha !== null) {
    if (latest === null || highest === null) {
      throw new Error('Unmarked release branch has no public release to verify');
    }
    deployed = await proveLegacyDeployment(legacyBranchSha, latest, highest, request);
  }
  if (deployed === null && published.length > 0) {
    throw new Error('Release branch is absent despite published releases');
  }
  if (deployed !== null) {
    const order = compareVersions(requested.version, deployed.version);
    if (order < 0) throw new Error(`Refusing deployment rollback from v${deployed.version}`);
    if (order === 0 && !sameIdentity(requested, deployed)) {
      throw new Error('Release branch has the requested version from another source');
    }
  }

  const matching = published.filter((entry) => entry.identity.version === requested.version);
  if (matching.length > 1) throw new Error('Duplicate public releases have the requested version');
  if (matching.length === 1) {
    if (deployed === null || !sameIdentity(requested, deployed)) {
      throw new Error('Requested version is public but the deployment branch disagrees');
    }
    await verifyPublishedRelease(matching[0]!.release, requested, request);
    return { publishBranch: false, createRelease: false };
  }
  return {
    publishBranch: deployed === null || !sameIdentity(requested, deployed),
    createRelease: true,
  };
}

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const output = process.env.GITHUB_OUTPUT;
  const version = process.env.RELEASE_VERSION;
  const commit = process.env.RELEASE_SHA;
  if (
    !repository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !token ||
    !output ||
    !version ||
    !commit
  ) {
    throw new Error('Publication guard needs repository, token, output, version, and source SHA');
  }
  const apiBase = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const request: Request = async (path, accept = 'application/vnd.github+json', maxBytes) => {
    const response = await fetch(`${apiBase}/repos/${repository}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (response.status === 404) {
      if (
        path === '/git/ref/heads/release' ||
        path === '/releases/latest' ||
        path.startsWith('/contents/release-state.json?ref=')
      )
        return null;
      throw new Error(`Required publication state is missing: ${path}`);
    }
    if (!response.ok) throw new Error(`GitHub API ${path} returned HTTP ${response.status}`);
    const limit = maxBytes ?? 10 * 1024 * 1024;
    const length = response.headers.get('content-length');
    if (length && Number(length) > limit) throw new Error('GitHub response exceeds size limit');
    if (!response.body) throw new Error('GitHub response has no body');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) throw new Error('GitHub response exceeds size limit');
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return accept === 'application/octet-stream'
      ? bytes
      : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  };
  const bundle = resolve('release-bundle');
  const decision = await decidePublication(
    { version, commit },
    JSON.parse(readFileSync(resolve(bundle, 'dist/release-state.json'), 'utf8')),
    JSON.parse(readFileSync(resolve(bundle, 'release/metadata.json'), 'utf8')),
    request
  );
  appendFileSync(
    output,
    `publish-branch=${decision.publishBranch}\ncreate-release=${decision.createRelease}\n`
  );
  console.log(
    `Publication decision: branch=${decision.publishBranch}, release=${decision.createRelease}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
