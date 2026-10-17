import { fileURLToPath } from 'node:url';

import { packageBinary, runChild } from '../check/run-child.ts';

export type ViteMode = 'dev' | 'build' | 'ci' | 'preview';

export async function runVite(
  mode: ViteMode,
  args: string[],
  run: typeof runChild = runChild
): Promise<number> {
  if (mode === 'ci') {
    const licenses = await run(fileURLToPath(new URL('./generate-licenses.ts', import.meta.url)));
    if (licenses !== 0) return licenses;
  }

  const viteArgs = [mode === 'ci' ? 'build' : mode, ...args];
  const result = await run(packageBinary('vite-plus', 'vp'), viteArgs, {
    NODE_OPTIONS: '--no-deprecation',
  });
  if (result !== 0) return result;

  if (mode === 'ci') {
    return run(fileURLToPath(new URL('./postbuild.ts', import.meta.url)));
  }
  return 0;
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (!['dev', 'build', 'ci', 'preview'].includes(mode ?? '')) {
    console.error('Expected dev, build, ci, or preview');
    process.exitCode = 1;
  } else {
    runVite(mode as ViteMode, process.argv.slice(3)).then(
      (code) => {
        process.exitCode = code;
      },
      (error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      }
    );
  }
}
