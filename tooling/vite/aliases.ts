import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const src = path.resolve(root, 'src');

export const appAliases = {
  '@': src,
  '@components': path.resolve(src, 'components'),
  '@services': path.resolve(src, 'services'),
  '@utils': path.resolve(src, 'utils'),
  '@stores': path.resolve(src, 'stores'),
  '@hooks': path.resolve(src, 'hooks'),
  '@t': path.resolve(src, 'types'),
  '@i18n': path.resolve(src, 'i18n'),
};
