import { beforeAll, describe, expect, it } from 'vite-plus/test';

import browserAppPreset, { browserAppManualChunk } from '../../../tooling/vite/presets/browser-app';

describe('browser app chunk boundary', () => {
  beforeAll(async () => {
    // Importing the preset starts plugin resolution in Vitest's module runner.
    await Promise.all(browserAppPreset.plugins ?? []);
  });

  it('leaves development-only codec oracles outside production chunk assignments', () => {
    for (const id of [
      '/repo/node_modules/wasm-webp/dist/esm/webp-wasm.js',
      '/repo/node_modules/gifenc/dist/gifenc.js',
      '/repo/node_modules/mediabunny/dist/modules/src/index.js',
      '/repo/src/services/webp-encoder-service.ts',
    ]) {
      expect(browserAppManualChunk(id)).toBeUndefined();
    }
  });

  it('emits the shared Vite preload helper as a separate chunk', () => {
    expect(browserAppManualChunk('\0vite/preload-helper.js')).toBe('preload-helper');
  });
});
