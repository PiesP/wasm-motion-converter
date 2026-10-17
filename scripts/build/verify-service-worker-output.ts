import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
  return createHash('sha256').update(bytes).digest('hex');
}
