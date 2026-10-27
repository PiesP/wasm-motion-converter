import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Plugin } from 'vite-plus';

const workerPath = fileURLToPath(new URL('../../../worker/service-worker.ts', import.meta.url));
const publicWorkerPath = fileURLToPath(
  new URL('../../../public/service-worker.js', import.meta.url)
);

export function emitServiceWorkerPlugin(): Plugin {
  return {
    name: 'emit-service-worker',
    apply: 'build',
    buildStart() {
      if (existsSync(publicWorkerPath)) {
        throw new Error('A handwritten public/service-worker.js would override the emitted worker');
      }
      this.emitFile({ type: 'chunk', id: workerPath, fileName: 'service-worker.js' });
    },
    generateBundle(_options, bundle) {
      const workerChunks = Object.values(bundle).filter(
        (item) => item.type === 'chunk' && item.facadeModuleId === workerPath
      );
      if (
        workerChunks.length !== 1 ||
        workerChunks[0]?.type !== 'chunk' ||
        workerChunks[0].fileName !== 'service-worker.js'
      ) {
        throw new Error('Expected exactly one root service-worker.js chunk');
      }
      const worker = workerChunks[0];
      if (worker.imports.length || worker.dynamicImports.length) {
        throw new Error('The service worker must be one self-contained module');
      }
      const sourceHash = createHash('sha256').update(readFileSync(workerPath)).digest('hex');
      worker.code = `/* dropconvert-worker-source-sha256:${sourceHash} */\n${worker.code}`;
    },
  };
}
