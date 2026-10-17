// GitHub Actions expressions are literal workflow assertions.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vite-plus/test';

import type { DeploymentState } from '../../../scripts/build/deployment-state';
import {
  deploymentUrl,
  parseDeploymentState,
  readDeploymentState,
  verifyDeploymentBytes,
  verifyPublication,
} from '../../../scripts/test/verify-deployment';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFileSync: vi.fn(),
}));

const body = '<!doctype html><main>source fixture</main>';
const state: DeploymentState = {
  schemaVersion: 1,
  sourceSha: 'a'.repeat(40),
  treeSha: 'b'.repeat(40),
  coreSha: 'c'.repeat(40),
  version: '0.2.3',
  branch: 'master',
  sourceDirty: false,
  headersSha256: 'd'.repeat(64),
  files: [
    {
      path: 'index.html',
      size: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    },
  ],
};
const target = deploymentUrl('https://wasm-motion-converter.pages.dev/');

describe('source-bound public verification', () => {
  it.each([
    null,
    { ...state, schemaVersion: 2 },
    { ...state, sourceDirty: true },
    { ...state, sourceSha: 'v0.2.3' },
    { ...state, files: [] },
    { ...state, files: [{ ...state.files[0], path: '../private' }] },
    { ...state, files: [{ ...state.files[0], size: 1e12 }] },
    { ...state, files: [state.files[0], state.files[0]] },
  ])('rejects incomplete, unsafe or unbound metadata %j', (value) => {
    expect(() => parseDeploymentState(value)).toThrow();
  });

  it('never parses a successful SPA HTML fallback as metadata, including a duplicated JSON MIME', async () => {
    for (const contentType of ['text/html', 'application/json, text/html']) {
      const fetcher = vi.fn(
        async () =>
          new Response(JSON.stringify(state), { headers: { 'content-type': contentType } })
      );
      await expect(readDeploymentState(target, fetcher)).rejects.toThrow('successful JSON');
    }
    const mislabeled = vi.fn(
      async () => new Response(body, { headers: { 'content-type': 'application/json' } })
    );
    await expect(readDeploymentState(target, mislabeled)).rejects.toThrow();
  });

  it('checks the complete exact build inventory and propagates served-byte/source failures', async () => {
    let servedBody = body;
    let metadata = state;
    const fetcher: typeof fetch = async (input) =>
      new URL(String(input)).pathname === '/deployment-state.json'
        ? new Response(JSON.stringify(metadata), {
            headers: { 'content-type': 'application/json; charset=utf-8' },
          })
        : new Response(servedBody, { headers: { 'content-type': 'text/html' } });
    await expect(verifyDeploymentBytes(target, state, fetcher)).resolves.toMatchObject({
      sourceSha: state.sourceSha,
    });
    servedBody = 'changed';
    await expect(verifyDeploymentBytes(target, state, fetcher)).rejects.toThrow(
      'Served bytes differ'
    );
    metadata = { ...state, sourceSha: 'e'.repeat(40) };
    await expect(verifyDeploymentBytes(target, state, fetcher)).rejects.toThrow('sourceSha');
  });

  it('restricts targets to the owned Pages surface and maintained loopback serving', () => {
    expect(deploymentUrl('https://1234abcd.wasm-motion-converter.pages.dev/').protocol).toBe(
      'https:'
    );
    expect(deploymentUrl('http://127.0.0.1:44289/').hostname).toBe('127.0.0.1');
    for (const value of [
      'https://example.test/',
      'https://user:password@wasm-motion-converter.pages.dev/',
      'http://wasm-motion-converter.pages.dev/',
      'https://wasm-motion-converter.pages.dev/?token=secret',
    ]) {
      expect(() => deploymentUrl(value)).toThrow();
    }
  });

  it('checks both HTML documents at canonical Pages paths without following redirects', async () => {
    const missing = '<!doctype html><main>not found fixture</main>';
    const expected: DeploymentState = {
      ...state,
      files: [
        ...state.files,
        {
          path: '404.html',
          size: missing.length,
          sha256: createHash('sha256').update(missing).digest('hex'),
        },
      ],
    };
    const paths: string[] = [];
    let redirect = false;
    const fetcher: typeof fetch = async (input, init) => {
      expect(init?.redirect).toBe('error');
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === '/deployment-state.json')
        return new Response(JSON.stringify(expected), {
          headers: { 'content-type': 'application/json' },
        });
      if (path === '/') return new Response(body);
      if (path === '/404')
        return redirect
          ? new Response(null, { status: 308, headers: { location: '/elsewhere' } })
          : new Response(missing);
      throw new Error(`Unexpected document path: ${path}`);
    };
    await expect(verifyDeploymentBytes(target, expected, fetcher)).resolves.toMatchObject({
      files: expected.files.map((file) => expect.objectContaining(file)),
    });
    expect(paths).toEqual(['/deployment-state.json', '/', '/404']);
    redirect = true;
    await expect(verifyDeploymentBytes(target, expected, fetcher)).rejects.toThrow(
      '404.html returned 308'
    );
  });

  it('fails a superseded source before any public acceptance work', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wmc-superseded-'));
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      writeFileSync(join(directory, 'deployment-state.json'), JSON.stringify(state));
      vi.stubEnv('DEPLOY_DIST', directory);
      vi.stubEnv('EXPECTED_SOURCE_SHA', state.sourceSha);
      vi.stubEnv('VERIFY_CURRENT_MASTER', '1');
      vi.stubEnv('GITHUB_STEP_SUMMARY', '');
      vi.mocked(execFileSync).mockReturnValue(`${'e'.repeat(40)}\trefs/heads/master\n`);
      await expect(verifyPublication()).rejects.toThrow('was superseded on master');
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true });
    }
  });

  it('runs after exact successful protected-source CI using its bound artifact and no production secrets', () => {
    const workflow = readFileSync('.github/workflows/deployment-verification.yaml', 'utf8');
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain("github.event.workflow_run.head_branch == 'master'");
    expect(workflow).toContain('head_repository.full_name == github.repository');
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain('run-id: ${{ github.event.workflow_run.id }}');
    expect(workflow).toContain('name: build-${{ github.event.workflow_run.head_sha }}');
    expect(workflow).not.toContain('secrets.');
    expect(workflow).not.toContain('SKIP_WEB_SERVER');
  });
});
