import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const workerMarker = /^\/\* dropconvert-worker-source-sha256:([a-f0-9]{64}) \*\/\n/;

export function verifyServiceWorkerOutput(root: string, dist: string): string {
  if (existsSync(join(root, 'public/service-worker.js'))) {
    throw new Error('[postbuild] Handwritten public/service-worker.js must not shadow the build');
  }
  const workerPath = join(dist, 'service-worker.js');
  if (!existsSync(workerPath) || !statSync(workerPath).isFile()) {
    throw new Error('[postbuild] Missing root service-worker.js');
  }
  const extraWorkers = readdirSync(join(dist, 'assets')).filter((name) =>
    /^service-worker(?:[.-].*)?\.js$/.test(name)
  );
  if (extraWorkers.length) {
    throw new Error(`[postbuild] Unexpected additional worker chunk: ${extraWorkers.join(', ')}`);
  }
  const bytes = readFileSync(workerPath);
  const marker = workerMarker.exec(bytes.toString('utf8'))?.[1];
  const sourceHash = createHash('sha256')
    .update(readFileSync(join(root, 'worker/service-worker.ts')))
    .digest('hex');
  if (marker !== sourceHash) {
    throw new Error('[postbuild] Service worker output does not match the current source');
  }
  return createHash('sha256').update(bytes).digest('hex');
}
