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
      '@i18n': resolve(srcDir, 'i18n'),
    },
  },
});
