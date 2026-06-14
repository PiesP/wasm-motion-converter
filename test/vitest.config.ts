import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const testDir = resolve(__dirname, '.');
const srcDir = resolve(__dirname, '../src');

export default defineConfig({
  root: testDir,
  define: { __DEV__: true },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./setup.ts'],
    include: ['unit/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    passWithNoTests: true,
    slowTestThreshold: 2000,
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '@': srcDir,
      '@components': resolve(srcDir, 'components'),
      '@services': resolve(srcDir, 'services'),
      '@utils': resolve(srcDir, 'utils'),
      '@stores': resolve(srcDir, 'stores'),
      '@hooks': resolve(srcDir, 'hooks'),
      '@t': resolve(srcDir, 'types'),
    },
  },
});
