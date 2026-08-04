import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import solid from 'vite-plugin-solid';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const testDir = resolve(__dirname, 'test');
const srcDir = resolve(__dirname, 'src');

export default defineConfig({
  define: { __DEV__: true },
  plugins: [solid()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/unit/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    passWithNoTests: false,
    slowTestThreshold: 2000,
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/types/**',
        // Browser and worker bootstrap modules are exercised by Playwright.
        'src/index.tsx',
        'src/services/conversion-worker/worker.ts',
        // Development-only browser automation bridge, also covered by Playwright.
        'src/test-helpers.ts',
      ],
      thresholds: {
        statements: 60,
        branches: 45,
        functions: 55,
        lines: 62,
      },
    },
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
      '@i18n': resolve(srcDir, 'i18n'),
    },
  },
});
