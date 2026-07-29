import { rmSync } from 'node:fs';

for (const path of ['dist', 'node_modules/.vite']) {
  rmSync(path, { force: true, recursive: true });
}
