import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Identity = { version: string; commit: string };
type Decision = { publishBranch: boolean; createRelease: boolean };
type Request = (path: string, accept?: string) => Promise<unknown | null>;

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
  if (branchRef !== null) {
    const branchSha = record(
      record(branchRef, 'release branch ref').object,
      'release branch object'
    ).sha;
    if (typeof branchSha !== 'string' || !shaPattern.test(branchSha)) {
      throw new Error('Release branch has no valid commit SHA');
    }
    const file = record(
      await request(`/contents/release-state.json?ref=${branchSha}`),
      'release branch marker'
    );
    if (file.encoding !== 'base64' || typeof file.content !== 'string') {
      throw new Error('Release branch marker has no base64 content');
    }
    deployed = identity(
      JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')),
      'release branch marker'
    );
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
    const assets = matching[0]!.release.assets;
    if (!Array.isArray(assets)) throw new Error('Existing release assets are malformed');
    const metadataAssets = assets.filter(
      (asset) => record(asset, 'release asset').name === 'metadata.json'
    );
    if (metadataAssets.length !== 1)
      throw new Error('Existing release has no unique metadata asset');
    const assetUrl = record(metadataAssets[0], 'metadata asset').url;
    if (
      typeof assetUrl !== 'string' ||
      !/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/.test(assetUrl)
    ) {
      throw new Error('Existing release metadata asset URL is invalid');
    }
    const metadata = identity(
      await request(
        new URL(assetUrl).pathname.replace(/^\/repos\/[^/]+\/[^/]+/, ''),
        'application/octet-stream'
      ),
      'existing release metadata'
    );
    if (!sameIdentity(requested, metadata)) {
      throw new Error('Existing release metadata has another source');
    }
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
  const request: Request = async (path, accept = 'application/vnd.github+json') => {
    const response = await fetch(`${apiBase}/repos/${repository}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (response.status === 404) {
      if (path === '/git/ref/heads/release' || path === '/releases/latest') return null;
      throw new Error(`Required publication state is missing: ${path}`);
    }
    if (!response.ok) throw new Error(`GitHub API ${path} returned HTTP ${response.status}`);
    return response.json();
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
