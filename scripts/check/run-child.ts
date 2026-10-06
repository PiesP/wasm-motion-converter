import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);

export function packageBinary(packageName: string, binaryName: string): string {
  const packageFile = require.resolve(`${packageName}/package.json`);
  const manifest = JSON.parse(readFileSync(packageFile, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const binary = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binaryName];
  if (!binary) throw new Error(`${packageName} does not provide ${binaryName}`);
  return resolve(dirname(packageFile), binary);
}

export async function runChild(
  script: string,
  args: readonly string[] = [],
  overrides: NodeJS.ProcessEnv = {}
): Promise<number> {
  const nodeArgs = script.endsWith('.ts') ? ['--experimental-strip-types'] : [];
  const child = spawn(process.execPath, [...nodeArgs, script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...overrides },
    stdio: 'inherit',
  });
  let interrupted: NodeJS.Signals | undefined;
  const forward = (signal: NodeJS.Signals): void => {
    interrupted = signal;
    child.kill(signal);
  };
  const onInterrupt = (): void => forward('SIGINT');
  const onTerminate = (): void => forward('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        const finalSignal = interrupted ?? signal;
        resolve(finalSignal === 'SIGINT' ? 130 : finalSignal === 'SIGTERM' ? 143 : (code ?? 1));
      });
    });
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}
