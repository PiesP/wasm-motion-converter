import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { UserConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..', '..');

const basePreset: UserConfig = {
  resolve: {
    alias: {
      '@': path.resolve(root, './src'),
      '@components': path.resolve(root, './src/components'),
      '@services': path.resolve(root, './src/services'),
      '@utils': path.resolve(root, './src/utils'),
      '@stores': path.resolve(root, './src/stores'),
      '@hooks': path.resolve(root, './src/hooks'),
      '@t': path.resolve(root, './src/types'),
      '@i18n': path.resolve(root, './src/i18n'),
    },
  },
  worker: {
    format: 'es',
  },
};

export default basePreset;
