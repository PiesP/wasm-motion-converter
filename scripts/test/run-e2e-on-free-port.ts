import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

export async function runE2eOnFreePort(): Promise<void> {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate a local TCP port for Playwright.');
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  const packageManagerPath = process.env.npm_execpath;
  if (!packageManagerPath) {
    throw new Error('npm_execpath is required to run the Playwright package script.');
  }

  const child = spawn(process.execPath, [packageManagerPath, 'test:e2e:ci'], {
    env: {
      ...process.env,
      PLAYWRIGHT_DEV_PORT: String(address.port),
    },
    stdio: 'inherit',
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Playwright exited after receiving ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });

  process.exitCode = exitCode;
}

function isDirectInvocation(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) await runE2eOnFreePort();
