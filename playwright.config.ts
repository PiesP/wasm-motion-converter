import { defineConfig, devices } from '@playwright/test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const DEV_SERVER_PORT = Number(process.env.PLAYWRIGHT_DEV_PORT) || 5173;
const DEV_SERVER_URL = `http://127.0.0.1:${DEV_SERVER_PORT}`;

export default defineConfig({
  testDir: __dirname,
  testMatch: ['e2e/*.spec.ts'],
  testIgnore: ['e2e/fixtures/**', 'e2e/lib/**', 'e2e/__screenshots__/**', 'e2e/debug/**'],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : [['list'], ['html', { open: 'never' }]],
  timeout: 300_000,
  expect: { timeout: 30_000 },
  tsconfig: path.resolve(__dirname, 'tsconfig.playwright.json'),

  use: {
    baseURL: DEV_SERVER_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    headless: true,
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
            '--disable-gpu',
            // Required for FFmpeg WASM multithreading (SharedArrayBuffer)
            '--enable-features=SharedArrayBuffer',
          ],
        },
      },
    },
  ],

  // Auto-start dev server unless SKIP_WEB_SERVER is set (e.g. when running
  // tests against an already-running instance via `pnpm dev`).
  ...(process.env.SKIP_WEB_SERVER
    ? {}
    : {
        webServer: {
          command: `NODE_OPTIONS='--no-deprecation' npx vite --host 127.0.0.1 --port ${DEV_SERVER_PORT}`,
          url: DEV_SERVER_URL,
          reuseExistingServer: true,
          timeout: 120_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      }),
});
