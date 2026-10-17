import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import { verifyServiceWorkerOutput } from '../../../scripts/build/verify-service-worker-output';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wmc-service-worker-output-'));
  roots.push(root);
  const dist = join(root, 'dist');
  mkdirSync(join(root, 'worker'));
  mkdirSync(join(root, 'public'));
  mkdirSync(join(dist, 'assets'), { recursive: true });
  const source = 'self.addEventListener("fetch", () => {});\n';
  writeFileSync(join(root, 'worker/service-worker.ts'), source);
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const output = `/* dropconvert-worker-source-sha256:${sourceHash} */\nself.addEventListener("fetch",()=>{});`;
  writeFileSync(join(dist, 'service-worker.js'), output);
  return { root, dist, output };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('emitted service worker output', () => {
  it('accepts the root worker only when it belongs to the current source', () => {
    const { root, dist, output } = fixture();
    expect(verifyServiceWorkerOutput(root, dist)).toBe(
      createHash('sha256').update(output).digest('hex')
    );
  });

  it('rejects a missing or misnamed worker', () => {
    const { root, dist, output } = fixture();
    rmSync(join(dist, 'service-worker.js'));
    expect(() => verifyServiceWorkerOutput(root, dist)).toThrow('Missing root service-worker.js');
    writeFileSync(join(dist, 'assets/service-worker.abcdefgh.js'), output);
    expect(() => verifyServiceWorkerOutput(root, dist)).toThrow('Missing root service-worker.js');
  });

  it('rejects stale output, an additional worker chunk, and a public copy', () => {
    const { root, dist } = fixture();
    writeFileSync(join(root, 'worker/service-worker.ts'), 'updated source');
    expect(() => verifyServiceWorkerOutput(root, dist)).toThrow(
      'does not match the current source'
    );
    const { root: duplicateRoot, dist: duplicateDist } = fixture();
    writeFileSync(join(duplicateDist, 'assets/service-worker.abcdefgh.js'), 'extra');
    expect(() => verifyServiceWorkerOutput(duplicateRoot, duplicateDist)).toThrow(
      'Unexpected additional worker chunk'
    );
    const { root: publicRoot, dist: publicDist } = fixture();
    writeFileSync(join(publicRoot, 'public/service-worker.js'), 'stale public copy');
    expect(() => verifyServiceWorkerOutput(publicRoot, publicDist)).toThrow('Handwritten public');
  });
});
