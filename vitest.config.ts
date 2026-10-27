import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import solid from 'vite-plugin-solid';
import { defineConfig } from 'vite-plus';
import { playwright } from 'vite-plus/test/browser-playwright';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const srcDir = resolve(__dirname, 'src');

export default defineConfig({
  define: { __DEV__: true, __APP_SOURCE_SHA__: null },
  plugins: [solid()],
  test: {
    environment: 'node',
    // Vitest v4 compatibility: preserve mock call history.
    // Remove after tests no longer rely on calls from setup or earlier tests.
    // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
    // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
    clearMocks: false,
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          setupFiles: ['./test/setup.ts'],
          include: ['test/unit/**/*.test.{ts,tsx}'],
          exclude: ['test/unit/**/*.browser.test.{ts,tsx}', 'node_modules', 'dist'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          setupFiles: ['./test/setup.ts'],
          include: ['test/unit/**/*.browser.test.{ts,tsx}'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
            commands: {
              setReducedMotion: ({ page }, reduced: boolean) =>
                page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' }),
            },
          },
        },
      },
      {
        test: {
          name: 'node-policy',
          environment: 'node',
          setupFiles: [],
          include: [
            'scripts/ci/repository-authority.test.ts',
            'scripts/release/verify-source.test.ts',
            'scripts/check/run-child.test.ts',
            'test/native/deployment-update.test.ts',
            'test/native/offline-recovery.test.ts',
            'test/native/recovery-server.test.ts',
          ],
          fileParallelism: false,
          passWithNoTests: false,
          testTimeout: 30000,
        },
      },
    ],
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
