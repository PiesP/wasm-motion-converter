/** Pages source builds use the same quality/build lifecycle as local pnpm build. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Execute = (command: string, args: string[], environment?: NodeJS.ProcessEnv) => string;

function execute(command: string, args: string[], environment?: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
  return result.stdout.trim();
}

export function pagesBuild(root: string, run: Execute = execute): void {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    packageManager: string;
    volta: { node: string };
  };
  const pnpmPin = /^pnpm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager)?.[1];
  if (
    !pnpmPin ||
    manifest.volta.node !== readFileSync(join(root, '.node-version'), 'utf8').trim()
  ) {
    throw new Error('Pages toolchain pins are inconsistent');
  }
  if (process.versions.node !== manifest.volta.node)
    throw new Error('Pages Node version does not match volta.node');
  if (run('pnpm', ['--version']) !== pnpmPin)
    throw new Error('Pages pnpm version does not match packageManager');
  console.log(`[pages] Node ${process.versions.node}; pnpm ${pnpmPin}`);
  run('git', ['submodule', 'sync', '--recursive']);
  run('git', ['submodule', 'update', '--init', '--recursive']);
  const expectedCore = run('git', ['rev-parse', 'HEAD:packages/core']);
  if (run('git', ['-C', 'packages/core', 'rev-parse', 'HEAD']) !== expectedCore)
    throw new Error('Pages core gitlink mismatch');
  console.log(`[pages] Core ${expectedCore}`);
  run('pnpm', ['install', '--frozen-lockfile', '--prod=false'], { NODE_ENV: 'development' });
  // Separate GitHub CI is not an exact-source deployment prerequisite. Preserve
  // prebuild quality/licenses and postbuild inventory/reference validation here.
  run('pnpm', ['build'], { NODE_ENV: 'production' });
}

if (import.meta.main) {
  try {
    pagesBuild(process.cwd());
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
