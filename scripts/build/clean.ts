import { rmSync } from 'node:fs';

export function clean(): void {
  for (const path of ['dist', 'node_modules/.vite']) {
    rmSync(path, { force: true, recursive: true });
  }
}

if (import.meta.main) clean();
