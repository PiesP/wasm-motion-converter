import { defineConfig, devices } from '@playwright/test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const DEV_SERVER_PORT = Number(process.env.PLAYWRIGHT_DEV_PORT) || 5173;
const DEV_SERVER_URL = `http://127.0.0.1:${DEV_SERVER_PORT}`;
const TEST_PROFILE = process.env.PLAYWRIGHT_TEST_PROFILE ?? 'local';
const IS_DEPLOY_PROFILE = TEST_PROFILE === 'deploy';
const IS_CI_PROFILE = TEST_PROFILE === 'ci';
const IS_RESOURCE_PROFILE = TEST_PROFILE === 'resource';
// Fresh CI checkouts intentionally exclude the large, local-only codec matrix.
// The smoke fixture is generated deterministically before this profile runs.
const CI_TEST_MATCH = [
  'e2e/accessibility.spec.ts',
  'e2e/design-system.spec.ts',
  'e2e/i18n.spec.ts',
  'e2e/ci-conversion-smoke.spec.ts',
  'e2e/adaptive-resource-safety.spec.ts',
];
const LOCAL_TEST_IGNORE = [
  'e2e/fixtures/**',
  'e2e/lib/**',
  'e2e/__screenshots__/**',
  'e2e/debug/**',
  'e2e/deploy-smoke.spec.ts',
  'e2e/dogfood-qa.spec.ts',
  'e2e/resource-profile.spec.ts',
];

export default defineConfig({
  testDir: path.resolve(__dirname, 'test'),
  testMatch: IS_DEPLOY_PROFILE
    ? ['e2e/deploy-smoke.spec.ts', 'e2e/dogfood-qa.spec.ts']
    : IS_CI_PROFILE
      ? CI_TEST_MATCH
      : IS_RESOURCE_PROFILE
        ? ['e2e/resource-profile.spec.ts']
        : ['e2e/*.spec.ts'],
  testIgnore: IS_DEPLOY_PROFILE || IS_RESOURCE_PROFILE ? [] : LOCAL_TEST_IGNORE,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: IS_CI_PROFILE ? 0 : process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  timeout: 300_000,
  expect: { timeout: 30_000 },
  tsconfig: path.resolve(__dirname, 'test/tsconfig.playwright.json'),

  use: {
    baseURL: DEV_SERVER_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: process.env.CI ? 'retain-on-failure' : 'off',
    headless: true,
    colorScheme: 'light',
    viewport: { width: 1280, height: 720 },
  },

  // Snapshot configuration for visual regression tests
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
        launchOptions: {
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            ...(IS_RESOURCE_PROFILE ? ['--enable-precise-memory-info'] : ['--disable-gpu']),
            // Expose SharedArrayBuffer for the cross-origin-isolated app.
            '--enable-features=SharedArrayBuffer',
          ],
        },
      },
    },
  ],

  // Auto-start dev server unless SKIP_WEB_SERVER is set (e.g. when running
  // tests against an already-running instance via `pnpm dev`).
  ...(process.env.SKIP_WEB_SERVER || IS_DEPLOY_PROFILE
    ? {}
    : {
        webServer: {
          command: `NODE_OPTIONS='--no-deprecation' pnpm exec vite --host 127.0.0.1 --port ${DEV_SERVER_PORT} --strictPort`,
          url: DEV_SERVER_URL,
          reuseExistingServer: true,
          timeout: 120_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      }),
});
