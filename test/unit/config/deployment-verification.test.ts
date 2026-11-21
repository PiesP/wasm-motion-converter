// GitHub Actions expressions are literal workflow assertions.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('requires the original metadata bytes in the final mode', async () => {
    const original = `${JSON.stringify(state, null, 2)}\n`;
    const expectedManifestSha256 = createHash('sha256').update(original).digest('hex');
    let metadata = original;
    const fetcher: typeof fetch = async (input) =>
      new URL(String(input)).pathname === '/deployment-state.json'
        ? new Response(metadata, { headers: { 'content-type': 'application/json' } })
        : new Response(body);
    await expect(
      verifyDeploymentBytes(target, state, fetcher, expectedManifestSha256)
    ).resolves.toMatchObject({ manifestSha256: expectedManifestSha256 });
    metadata = JSON.stringify(state);
    await expect(
      verifyDeploymentBytes(target, state, fetcher, expectedManifestSha256)
    ).rejects.toThrow('metadata bytes differ');
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

  it('checks top-level and nested documents at canonical Pages URLs and rejects redirects', async () => {
    const nestedAndOtherFiles = [
      { path: '404.html', route: '/404', body: '<main>Not found</main>' },
      { path: 'notices/index.html', route: '/notices/', body: '<main>Notices</main>' },
      {
        path: 'notices/rust-1.100.0.html',
        route: '/notices/rust-1.100.0',
        body: '<main>Rust notices</main>',
      },
      { path: 'notices/gif-source.json', route: '/notices/gif-source.json', body: '{"source":1}' },
    ];
    const expected: DeploymentState = {
      ...state,
      files: [
        ...state.files,
        ...nestedAndOtherFiles.map((file) => ({
          path: file.path,
          size: Buffer.byteLength(file.body),
          sha256: createHash('sha256').update(file.body).digest('hex'),
        })),
      ],
    };
    const paths: string[] = [];
    let redirect = false;
    const fetcher: typeof fetch = async (input, init) => {
      expect(init?.redirect).toBe('error');
      const url = new URL(String(input));
      expect(url.origin).toBe(target.origin);
      const path = url.pathname;
      paths.push(path);
      if (path === '/deployment-state.json')
        return new Response(JSON.stringify(expected), {
          headers: { 'content-type': 'application/json' },
        });
      if (path === '/') return new Response(body);
      if (redirect && path === '/notices/rust-1.100.0')
        return new Response(null, { status: 308, headers: { location: '/elsewhere' } });
      const served = nestedAndOtherFiles.find((file) => file.route === path);
      if (served) return new Response(served.body);
      throw new Error(`Unexpected document path: ${path}`);
    };
    await expect(verifyDeploymentBytes(target, expected, fetcher)).resolves.toMatchObject({
      files: expected.files.map((file) => expect.objectContaining(file)),
    });
    expect(paths).toEqual([
      '/deployment-state.json',
      '/',
      ...nestedAndOtherFiles.map((file) => file.route),
    ]);
    redirect = true;
    await expect(verifyDeploymentBytes(target, expected, fetcher)).rejects.toThrow(
      'notices/rust-1.100.0.html returned 308'
    );
  });

  it.each([
    '_worker.js',
    '_routes.json',
    '_redirects',
    'assets/post-stamp.js',
    'assets/post-stamp.wasm',
    'index.html',
  ])(
    'rejects local final artifact contamination at %s before contacting the origin',
    async (path) => {
      const directory = mkdtempSync(join(tmpdir(), 'wmc-owned-dist-'));
      const fetcher = vi.spyOn(globalThis, 'fetch');
      try {
        const headers = '/\n  X-Content-Type-Options: nosniff\n';
        const manifest = {
          ...state,
          headersSha256: createHash('sha256').update(headers).digest('hex'),
        };
        writeFileSync(join(directory, '_headers'), headers);
        writeFileSync(join(directory, 'deployment-state.json'), JSON.stringify(manifest));
        writeFileSync(join(directory, 'index.html'), body);
        mkdirSync(join(directory, 'assets'));
        writeFileSync(
          join(directory, path),
          path === 'index.html' ? 'x'.repeat(body.length) : 'extra'
        );
        vi.stubEnv('DEPLOY_DIST', directory);
        vi.stubEnv('DEPLOY_URL', 'http://127.0.0.1:4123/');
        vi.stubEnv('DEPLOY_REQUIRE_OWNED_VP8_ONLY', '1');
        vi.stubEnv('EXPECTED_SOURCE_SHA', state.sourceSha);
        await expect(verifyPublication()).rejects.toThrow(
          path === 'index.html'
            ? 'Local deployment artifact bytes differ: index.html'
            : `Unaccounted deployment artifact file: ${path}`
        );
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        fetcher.mockRestore();
        vi.unstubAllEnvs();
        rmSync(directory, { recursive: true });
      }
    }
  );

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
    const prepare = workflow.indexOf('      - name: Prepare bounded owned media and Chromium');
    const verify = workflow.indexOf('      - name: Match and verify actual production');
    const evidence = workflow.indexOf('      - name: Preserve public verification evidence');
    expect(prepare).toBeGreaterThan(0);
    expect(verify).toBeGreaterThan(prepare);
    expect(evidence).toBeGreaterThan(verify);
    expect(workflow.slice(0, prepare)).toContain('timeout-minutes: 90');
    expect(workflow.slice(verify, evidence)).toContain('timeout-minutes: 30');
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
