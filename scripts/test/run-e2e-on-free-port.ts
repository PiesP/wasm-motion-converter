import { createServer } from 'node:net';

import { runChild } from '../check/run-child.ts';

export async function runE2eOnFreePort(run: typeof runChild = runChild): Promise<number> {
  const packageManagerPath = process.env.npm_execpath;
  if (!packageManagerPath) {
    throw new Error('npm_execpath is required to run the Playwright package script.');
  }
  const server = createServer();
  let failure: { error: unknown } | undefined;
  let port: number | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Could not allocate a local TCP port for Playwright.');
    }
    port = address.port;
  } catch (error) {
    failure = { error };
  }
  if (server.listening) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      if (failure) {
        console.error('Failed to close the Playwright port probe:', error);
      } else failure = { error };
    }
  }
  if (failure) throw failure.error;
  if (port === undefined) throw new Error('Could not allocate a local TCP port for Playwright.');
  // Selection releases the probe; Playwright still owns binding and collision errors.
  return run(
    packageManagerPath,
    ['test:e2e:ci'],
    { PLAYWRIGHT_DEV_PORT: String(port) },
    { signalScope: 'process-group' }
  );
}

if (import.meta.main) {
  runE2eOnFreePort().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    }
  );
}
