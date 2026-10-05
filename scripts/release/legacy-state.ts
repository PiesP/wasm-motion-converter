import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

type Request = (path: string, accept?: string, maxBytes?: number) => Promise<unknown | null>;
type Identity = { version: string; commit: string };

const maxArchiveBytes = 20 * 1024 * 1024;
const maxExpandedBytes = 100 * 1024 * 1024;
const maxMetadataBytes = 16 * 1024;
const maxEntries = 500;
const shaPattern = /^[0-9a-f]{40}$/;
const emptyBlobSha = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

function asset(release: Record<string, unknown>, name: string): Record<string, unknown> {
  if (!Array.isArray(release.assets)) throw new Error('Legacy release assets are malformed');
  const matches = release.assets.filter((entry) => record(entry, 'legacy asset').name === name);
  if (matches.length !== 1) throw new Error(`Legacy release has no unique ${name} asset`);
  return record(matches[0], 'legacy asset');
}

export async function downloadAsset(
  release: Record<string, unknown>,
  name: string,
  limit: number,
  request: Request
): Promise<Uint8Array> {
  const entry = asset(release, name);
  if (
    typeof entry.size !== 'number' ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 1 ||
    entry.size > limit ||
    typeof entry.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(entry.digest) ||
    typeof entry.url !== 'string' ||
    !/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/.test(entry.url)
  ) {
    throw new Error(`Legacy ${name} asset has invalid size, digest, or URL`);
  }
  const path = new URL(entry.url).pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
  const bytes = await request(path, 'application/octet-stream', limit);
  if (
    (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) ||
    bytes.byteLength !== entry.size ||
    `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== entry.digest
  ) {
    throw new Error(`Legacy ${name} asset failed digest or size verification`);
  }
  return bytes;
}

function tarString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder('utf-8', { fatal: true }).decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function tarNumber(bytes: Uint8Array): number {
  const text = tarString(bytes).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('Legacy archive has malformed tar size');
  const number = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(number)) throw new Error('Legacy archive has oversized tar entry');
  return number;
}

function safePath(raw: string): string {
  const path = raw.startsWith('./') ? raw.slice(2) : raw;
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Legacy archive has unsafe path: ${raw}`);
  }
  return path;
}

function archiveFiles(compressed: Uint8Array): Map<string, Uint8Array> {
  let bytes: Buffer;
  try {
    bytes = gunzipSync(compressed, { maxOutputLength: maxExpandedBytes });
  } catch {
    throw new Error('Legacy archive cannot be expanded within size limit');
  }
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let count = 0;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (bytes.subarray(offset).some((byte) => byte !== 0)) {
        throw new Error('Legacy archive has trailing data');
      }
      return files;
    }
    if (++count > maxEntries) throw new Error('Legacy archive has too many entries');
    const expectedChecksum = tarNumber(header.subarray(148, 156));
    let checksum = 0;
    for (let index = 0; index < 512; index++) {
      checksum += index >= 148 && index < 156 ? 32 : header[index]!;
    }
    if (checksum !== expectedChecksum) throw new Error('Legacy archive has a corrupt tar header');
    const size = tarNumber(header.subarray(124, 136));
    const type = header[156];
    const prefix = tarString(header.subarray(345, 500));
    const raw = `${prefix ? `${prefix}/` : ''}${tarString(header.subarray(0, 100))}`;
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > bytes.byteLength) throw new Error('Legacy archive has a truncated entry');
    if (type === 53) {
      if (size !== 0 || (raw !== './' && !raw.endsWith('/'))) {
        throw new Error('Legacy archive has malformed directory');
      }
      if (raw !== './') safePath(raw.slice(0, -1));
    } else if (type === 0 || type === 48) {
      const path = safePath(raw);
      if (files.has(path)) throw new Error('Legacy archive has duplicate paths');
      const content = bytes.subarray(offset + 512, offset + 512 + size);
      files.set(path, content);
    } else {
      throw new Error('Legacy archive contains unsupported entry type');
    }
    offset = next;
  }
  throw new Error('Legacy archive has no tar terminator');
}

async function matchesBranch(
  treeValue: unknown,
  files: Map<string, Uint8Array>,
  request: Request
): Promise<void> {
  const tree = record(treeValue, 'legacy branch tree');
  if (tree.truncated !== false || !Array.isArray(tree.tree)) {
    throw new Error('Legacy branch tree is incomplete');
  }
  if (tree.tree.length > maxEntries * 2) throw new Error('Legacy branch has too many entries');
  const branchFiles = new Map<string, Record<string, unknown>>();
  for (const value of tree.tree) {
    const entry = record(value, 'legacy branch entry');
    if (entry.type === 'tree') {
      if (
        entry.mode !== '040000' ||
        typeof entry.path !== 'string' ||
        typeof entry.sha !== 'string' ||
        !shaPattern.test(entry.sha)
      ) {
        throw new Error('Legacy branch has malformed directory');
      }
      safePath(entry.path);
      continue;
    }
    if (
      entry.type !== 'blob' ||
      entry.mode !== '100644' ||
      typeof entry.path !== 'string' ||
      typeof entry.sha !== 'string' ||
      !shaPattern.test(entry.sha) ||
      typeof entry.size !== 'number' ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    ) {
      throw new Error('Legacy branch contains unsupported or malformed entry');
    }
    const path = safePath(entry.path);
    if (branchFiles.has(path)) throw new Error('Legacy branch has duplicate paths');
    branchFiles.set(path, entry);
    if (
      path === '.nojekyll' &&
      !files.has(path) &&
      entry.size === 0 &&
      entry.sha === emptyBlobSha
    ) {
      continue;
    }
    const content = files.get(path);
    if (
      !content ||
      content.byteLength !== entry.size ||
      createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex') !==
        entry.sha
    )
      throw new Error(`Legacy branch differs from archive: ${path}`);
  }
  for (const path of files.keys()) {
    if (!branchFiles.has(path))
      throw new Error(`Legacy archive file is absent from branch: ${path}`);
  }
  for (const [path, content] of files) {
    const entry = branchFiles.get(path)!;
    const jsonLimit = Math.min(maxExpandedBytes, Math.ceil(content.byteLength * 1.5) + 4096);
    const blob = record(
      await request(`/git/blobs/${entry.sha}`, undefined, jsonLimit),
      'legacy branch blob'
    );
    if (
      blob.encoding !== 'base64' ||
      blob.sha !== entry.sha ||
      blob.size !== content.byteLength ||
      typeof blob.content !== 'string'
    ) {
      throw new Error(`Legacy branch blob is incomplete: ${path}`);
    }
    const downloaded = Buffer.from(blob.content, 'base64');
    if (downloaded.byteLength !== content.byteLength || !downloaded.equals(content)) {
      throw new Error(`Legacy branch blob differs from archive: ${path}`);
    }
  }
}

export async function proveLegacyDeployment(
  branchSha: string,
  latestRelease: unknown,
  version: string,
  request: Request
): Promise<Identity> {
  const release = record(latestRelease, 'latest legacy release');
  if (release.tag_name !== `v${version}`) throw new Error('Latest legacy release is inconsistent');
  const metadataBytes = await downloadAsset(release, 'metadata.json', maxMetadataBytes, request);
  const metadata = record(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes)),
    'legacy metadata'
  );
  if (
    metadata.version !== version ||
    typeof metadata.commit !== 'string' ||
    !shaPattern.test(metadata.commit)
  ) {
    throw new Error('Legacy metadata has no valid version and source');
  }
  const tagRef = record(await request(`/git/ref/tags/v${version}`), 'legacy tag ref');
  let tagObject = record(tagRef.object, 'legacy tag object');
  for (let depth = 0; depth < 5 && tagObject.type === 'tag'; depth++) {
    if (typeof tagObject.sha !== 'string' || !shaPattern.test(tagObject.sha)) {
      throw new Error('Legacy tag object is malformed');
    }
    tagObject = record(
      record(await request(`/git/tags/${tagObject.sha}`), 'legacy annotated tag').object,
      'legacy tag target'
    );
  }
  if (tagObject.type !== 'commit' || tagObject.sha !== metadata.commit) {
    throw new Error('Legacy release tag and metadata source disagree');
  }
  const archive = await downloadAsset(
    release,
    `wasm-motion-converter-${version}.tar.gz`,
    maxArchiveBytes,
    request
  );
  await matchesBranch(
    await request(`/git/trees/${branchSha}?recursive=1`, undefined, 2 * 1024 * 1024),
    archiveFiles(archive),
    request
  );
  return { version, commit: metadata.commit };
}
