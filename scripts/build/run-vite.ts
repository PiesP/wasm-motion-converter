import { fileURLToPath } from 'node:url';
import { isCliEntry, packageBinary, runChild } from '../check/run-child.ts';

export type ViteMode = 'dev' | 'build' | 'ci' | 'analyze' | 'preview';

export async function runVite(
  mode: ViteMode,
  args: string[],
  run: typeof runChild = runChild
): Promise<number> {
  if (mode === 'ci') {
    const licenses = await run(fileURLToPath(new URL('./generate-licenses.ts', import.meta.url)));
    if (licenses !== 0) return licenses;
  }

  const viteArgs =
    mode === 'dev' ? args : mode === 'preview' ? ['preview', ...args] : ['build', ...args];
  const result = await run(packageBinary('vite', 'vite'), viteArgs, {
    NODE_OPTIONS: '--no-deprecation',
    ...(mode === 'analyze' ? { VITE_ANALYZE_BUNDLE: 'true' } : {}),
  });
  if (result !== 0) return result;

  if (mode === 'ci') {
    return run(fileURLToPath(new URL('./postbuild.ts', import.meta.url)));
  }
  if (mode === 'analyze') console.log('\nBundle analysis generated at dist/stats.html');
  return 0;
}

if (isCliEntry(import.meta.url)) {
  const mode = process.argv[2];
  if (!['dev', 'build', 'ci', 'analyze', 'preview'].includes(mode ?? '')) {
    console.error('Expected dev, build, ci, analyze, or preview');
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
