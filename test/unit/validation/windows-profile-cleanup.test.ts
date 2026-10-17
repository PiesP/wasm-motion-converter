import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  assertMediaNetworkDiagnostics,
  finishMediaProfile,
  run,
} from '../../../validation/windows/profile.ts';

let outputRoot: string;
let server: Server;
const diagnostics = (): Parameters<typeof finishMediaProfile>[0]['diagnostics'] => ({
  pageErrors: [],
  consoleErrors: [],
  failedRequests: [],
  failedResponses: [],
});

beforeEach(async () => {
  outputRoot = await mkdtemp(join(tmpdir(), 'wmc media cleanup '));
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(outputRoot, { recursive: true, force: true });
});

async function readDiagnostics() {
  return JSON.parse(await readFile(join(outputRoot, 'network-diagnostics.json'), 'utf8'));
}

describe('Windows media profile cleanup', () => {
  it('closes both owned resources and persists the unchanged network fields on success', async () => {
    const context = { close: vi.fn(async () => {}) };
    await finishMediaProfile({
      context,
      server,
      outputRoot,
      diagnostics: diagnostics(),
      failure: undefined,
    });
    expect(context.close).toHaveBeenCalledOnce();
    expect(server.listening).toBe(false);
    expect(await readDiagnostics()).toEqual({
      ...diagnostics(),
      primaryError: null,
      cleanupErrors: [],
    });
  });

  it('persists diagnostic data before rejecting ordinary network assertions', async () => {
    const observed = { ...diagnostics(), consoleErrors: ['fixture console failure'] };
    await expect(assertMediaNetworkDiagnostics(outputRoot, observed)).rejects.toThrow(
      'Console errors'
    );
    expect(await readDiagnostics()).toEqual({ ...observed, primaryError: null, cleanupErrors: [] });
  });

  it('records an early real profile validation failure before any context is created', async () => {
    const browser = { newContext: vi.fn() };
    // The runtime boundary intentionally receives only the capability reached by this failure case.
    await expect(
      Reflect.apply(run, undefined, [{ browser, root: outputRoot, output: outputRoot }])
    ).rejects.toThrow();
    expect(browser.newContext).not.toHaveBeenCalled();
    expect((await readDiagnostics()).primaryError).toMatch(/ENOENT/);
  });

  it.each([undefined, null, false, 0, ''])(
    'preserves a thrown %j while still closing the server',
    async (primary) => {
      const context = {
        close: vi.fn(async () => {
          throw new Error('context failed');
        }),
      };
      const outcome = await finishMediaProfile({
        context,
        server,
        outputRoot,
        diagnostics: diagnostics(),
        failure: { error: primary },
      }).then(
        () => ({ caught: false }),
        (error: unknown) => ({ caught: true, error })
      );
      expect(outcome).toEqual({ caught: true, error: primary });
      expect(server.listening).toBe(false);
      expect((await readDiagnostics()).cleanupErrors).toEqual([
        'context close: Error: context failed',
      ]);
    }
  );

  it('preserves the original error when server closure rejects and records bounded details', async () => {
    const primary = new Error('validation failed');
    vi.spyOn(server, 'close').mockImplementationOnce((callback) => {
      callback?.(new Error('s'.repeat(2000)));
      return server;
    });
    await expect(
      finishMediaProfile({
        context: undefined,
        server,
        outputRoot,
        diagnostics: diagnostics(),
        failure: { error: primary },
      })
    ).rejects.toBe(primary);
    const written = await readDiagnostics();
    expect(written.primaryError).toBe('Error: validation failed');
    expect(written.cleanupErrors[0]).toHaveLength('server close: '.length + 1000);
  });

  it('attempts context, server and diagnostics even when each action fails', async () => {
    const primary = new Error('validation failed first');
    const context = {
      close: vi.fn(async () => {
        throw new Error('context failed');
      }),
    };
    const close = vi.spyOn(server, 'close').mockImplementationOnce((callback) => {
      callback?.(new Error('server failed'));
      return server;
    });
    const blocked = join(outputRoot, 'blocked');
    await writeFile(blocked, 'not a directory');
    await expect(
      finishMediaProfile({
        context,
        server,
        outputRoot: blocked,
        diagnostics: diagnostics(),
        failure: { error: primary },
      })
    ).rejects.toBe(primary);
    expect(context.close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects failed cleanup after successful checks and leaves its diagnostics', async () => {
    const context = {
      close: vi.fn(async () => {
        throw new Error('context failed');
      }),
    };
    await expect(
      finishMediaProfile({
        context,
        server,
        outputRoot,
        diagnostics: diagnostics(),
        failure: undefined,
      })
    ).rejects.toThrow('context close: Error: context failed');
    expect(server.listening).toBe(false);
    expect((await readDiagnostics()).cleanupErrors).toEqual([
      'context close: Error: context failed',
    ]);
  });

  it('fails successful checks on a diagnostic-write error after closing both resources', async () => {
    const context = { close: vi.fn(async () => {}) };
    const blocked = join(outputRoot, 'blocked');
    await writeFile(blocked, 'not a directory');
    await expect(
      finishMediaProfile({
        context,
        server,
        outputRoot: blocked,
        diagnostics: diagnostics(),
        failure: undefined,
      })
    ).rejects.toThrow('diagnostics write:');
    expect(context.close).toHaveBeenCalledOnce();
    expect(server.listening).toBe(false);
  });
});
