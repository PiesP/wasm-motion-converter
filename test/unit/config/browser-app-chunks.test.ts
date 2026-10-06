import { describe, expect, it } from 'vitest';
import { browserAppManualChunk } from '../../../tooling/vite/presets/browser-app';

describe('browser app chunk boundary', () => {
  it('assigns only the external wasm-webp package to the codec chunk', () => {
    expect(
      browserAppManualChunk(
        '/repo/node_modules/.pnpm/wasm-webp@1.0.0/node_modules/wasm-webp/dist/esm/webp-wasm.js'
      )
    ).toBe('wasm-webp');
    expect(browserAppManualChunk('C:\\repo\\node_modules\\wasm-webp\\dist\\esm\\webp-wasm.js')).toBe(
      'wasm-webp'
    );
    expect(browserAppManualChunk('/repo/src/services/wasm-webp-singleton.ts')).toBeUndefined();
    expect(browserAppManualChunk('/repo/src/services/webp-encoder-service.ts')).toBeUndefined();
  });

  it('keeps the existing gifenc assignment', () => {
    expect(browserAppManualChunk('/repo/node_modules/gifenc/dist/gifenc.js')).toBe('gifenc');
  });

  it('keeps Vite preload support outside the lazy codec chunk', () => {
    expect(browserAppManualChunk('\0vite/preload-helper.js')).toBe('preload-helper');
  });
});
