import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

import { parse } from '@babel/parser';

import { replacedApp, shellEntries } from '../../tooling/vite/plugins/emit-service-worker.ts';

const workerMarker = /^\/\* dropconvert-worker-source-sha256:([a-f0-9]{64}) \*\/\n/;

export function verifyServiceWorkerOutput(root: string, dist: string): string {
  if (existsSync(join(root, 'public/service-worker.js'))) {
    throw new Error('[postbuild] Handwritten public/service-worker.js must not shadow the build');
  }
  const workerPath = join(dist, 'service-worker.js');
  let descriptor: number;
  try {
    descriptor = openSync(workerPath, 'r');
  } catch (cause) {
    throw new Error('[postbuild] Missing root service-worker.js', { cause });
  }
  let bytes: Buffer;
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error('[postbuild] Missing root service-worker.js');
    }
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const extraWorkers = readdirSync(join(dist, 'assets')).filter((name) =>
    /^service-worker(?:[.-].*)?\.js$/.test(name)
  );
  if (extraWorkers.length) {
    throw new Error(`[postbuild] Unexpected additional worker chunk: ${extraWorkers.join(', ')}`);
  }
  const marker = workerMarker.exec(bytes.toString('utf8'))?.[1];
  const sourceHash = createHash('sha256')
    .update(readFileSync(join(root, 'worker/service-worker.ts')))
    .digest('hex');
  if (marker !== sourceHash) {
    throw new Error('[postbuild] Service worker output does not match the current source');
  }
  const match = /^const __DROP_CONVERT_SHELL__=(.+);$/m.exec(bytes.toString('utf8'));
  if (!match) throw new Error('[postbuild] Missing service worker shell manifest');
  verifyShell(dist, JSON.parse(match[1]!));
  return createHash('sha256').update(bytes).digest('hex');
}

interface Pin {
  path: string;
  size: number;
  sha256: string;
}

function verifyShell(
  dist: string,
  manifest: {
    document: Pin;
    eager: Pin[];
    predecessorOnly: string[];
    replacement: {
      source: string;
      document: Omit<Pin, 'path'>;
      workers: string[];
      only: Pin[];
      shared: Pin[];
    };
  }
) {
  const document = readPinned(manifest.document, join(dist, 'index.html'));
  if (manifest.document.path !== '/index.html') throw new Error('[postbuild] Invalid shell path');
  const assets = new Map<string, Buffer>();
  for (const pin of manifest.eager) {
    if (!/^\/assets\/[\w.-]+\.(?:js|css)$/.test(pin.path) || assets.has(pin.path.slice(1))) {
      throw new Error('[postbuild] Invalid eager shell asset path');
    }
    assets.set(pin.path.slice(1), readPinned(pin, join(dist, pin.path.slice(1))));
  }
  const seen = new Set<string>();
  const pending = shellEntries(document.toString('utf8'));
  while (pending.length) {
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    const file = assets.get(path);
    if (!file) throw new Error(`[postbuild] Unexpected unpinned shell dependency ${path}`);
    seen.add(path);
    if (!path.endsWith('.js')) continue;
    for (const node of parse(file.toString('utf8'), { sourceType: 'module' }).program.body) {
      if (
        (node.type === 'ImportDeclaration' ||
          node.type === 'ExportNamedDeclaration' ||
          node.type === 'ExportAllDeclaration') &&
        node.source
      ) {
        if (!node.source.value.startsWith('.')) {
          throw new Error(`[postbuild] Non-local static shell dependency ${node.source.value}`);
        }
        pending.push(posix.join(posix.dirname(path), node.source.value));
      }
    }
  }
  if (seen.size !== assets.size) throw new Error('[postbuild] Unexpected eager shell asset');
  for (const path of manifest.predecessorOnly) {
    if (
      !/^\/assets\/[\w.-]+\.(?:js|css|wasm)$/.test(path) ||
      existsSync(join(dist, path.slice(1)))
    ) {
      throw new Error(`[postbuild] Invalid predecessor-only asset ${path}`);
    }
  }
  const transition = manifest.replacement;
  if (
    !transition ||
    transition.source !== replacedApp.source ||
    transition.document?.sha256 !== replacedApp.document.sha256 ||
    transition.document.size !== replacedApp.document.size ||
    JSON.stringify(transition.workers) !== JSON.stringify(replacedApp.workers)
  ) {
    throw new Error('[postbuild] Invalid replacement generation');
  }
  const removed = replacedApp.assets.filter(({ path }) => !existsSync(join(dist, path.slice(1))));
  const shared = replacedApp.assets.filter((asset) => !removed.includes(asset));
  if (JSON.stringify(transition.only) !== JSON.stringify(removed)) {
    throw new Error('[postbuild] Invalid replacement-only asset inventory');
  }
  if (JSON.stringify(transition.shared) !== JSON.stringify(shared)) {
    throw new Error('[postbuild] Invalid shared replacement asset inventory');
  }
  for (const pin of shared) readPinned(pin, join(dist, pin.path.slice(1)));
}

function readPinned(pin: Pin, path: string): Buffer {
  const contents = readFileSync(path);
  if (
    contents.length !== pin.size ||
    createHash('sha256').update(contents).digest('hex') !== pin.sha256
  ) {
    throw new Error(`[postbuild] Incorrect service worker shell bytes for ${pin.path}`);
  }
  return contents;
}
