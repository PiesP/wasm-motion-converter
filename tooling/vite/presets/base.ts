import type { UserConfig } from 'vite-plus';

import { appAliases } from '../aliases.ts';

const basePreset: UserConfig = {
  resolve: {
    alias: appAliases,
  },
  worker: {
    format: 'es',
  },
};

export default basePreset;
