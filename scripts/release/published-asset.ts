import { createHash } from 'node:crypto';

type Request = (path: string, accept?: string, maxBytes?: number) => Promise<unknown | null>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

function asset(release: Record<string, unknown>, name: string): Record<string, unknown> {
  if (!Array.isArray(release.assets)) throw new Error('Published release assets are malformed');
  const matches = release.assets.filter((entry) => record(entry, 'published asset').name === name);
  if (matches.length !== 1) throw new Error(`Published release has no unique ${name} asset`);
  return record(matches[0], 'published asset');
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
    throw new Error(`Published ${name} asset has invalid size, digest, or URL`);
  }
  const path = new URL(entry.url).pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
  const bytes = await request(path, 'application/octet-stream', limit);
  if (
    (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) ||
    bytes.byteLength !== entry.size ||
    `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== entry.digest
  ) {
    throw new Error(`Published ${name} asset failed digest or size verification`);
  }
  return bytes;
}
