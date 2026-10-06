import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runVite } from '../build/run-vite.ts';
import { prepareResourceFixtures } from '../test/prepare-resource-fixtures.ts';
import { runPlaywright } from '../test/run-playwright.ts';
import { runChild } from './run-child.ts';

type Call = { script: string; args: readonly string[]; env: NodeJS.ProcessEnv };

function recordingRunner(results: number[] = []) {
  const calls: Call[] = [];
  const run: typeof runChild = async (script, args = [], env = {}) => {
    calls.push({ script, args, env });
    return results.shift() ?? 0;
  };
  return { calls, run };
}

test('build:ci preserves license, Vite, and postbuild order and stops on failure', async () => {
  const success = recordingRunner();
  assert.equal(await runVite('ci', ['--emptyOutDir'], success.run), 0);
  assert.deepEqual(
    success.calls.map(({ script }) => script.split('/').at(-1)),
    ['generate-licenses.ts', 'vite.js', 'postbuild.ts']
  );
  assert.deepEqual(success.calls[1]?.args, ['build', '--emptyOutDir']);
  assert.equal(success.calls[1]?.env.NODE_OPTIONS, '--no-deprecation');
  assert.equal(success.calls[1]?.env.VITE_ANALYZE_BUNDLE, undefined);

  const licenseFailure = recordingRunner([7]);
  assert.equal(await runVite('ci', [], licenseFailure.run), 7);
  assert.equal(licenseFailure.calls.length, 1);
  const viteFailure = recordingRunner([0, 9]);
  assert.equal(await runVite('ci', [], viteFailure.run), 9);
  assert.equal(viteFailure.calls.length, 2);
});

test('Vite commands keep their arguments and command-specific environment', async () => {
  for (const [mode, expectedArgs] of [
    ['dev', ['--host', '127.0.0.1']],
    ['build', ['build', '--host', '127.0.0.1']],
    ['preview', ['preview', '--host', '127.0.0.1']],
    ['analyze', ['build', '--host', '127.0.0.1']],
  ] as const) {
    const fixture = recordingRunner();
    assert.equal(await runVite(mode, ['--host', '127.0.0.1'], fixture.run), 0);
    assert.deepEqual(fixture.calls[0]?.args, expectedArgs);
    assert.equal(fixture.calls[0]?.env.NODE_OPTIONS, '--no-deprecation');
    assert.equal(
      fixture.calls[0]?.env.VITE_ANALYZE_BUNDLE,
      mode === 'analyze' ? 'true' : undefined
    );
  }
});

test('Playwright profiles override only their own profile; resource fixture flag stays scoped', async () => {
  for (const profile of ['ci', 'resource', 'deploy'] as const) {
    const fixture = recordingRunner([5]);
    assert.equal(await runPlaywright(profile, ['--list', 'some test'], fixture.run), 5);
    assert.deepEqual(fixture.calls[0]?.args, ['test', '--list', 'some test']);
    assert.equal(fixture.calls[0]?.env.PLAYWRIGHT_TEST_PROFILE, profile);
    assert.equal(fixture.calls[0]?.env.PREPARE_RESOURCE_FIXTURES, undefined);
  }
  const fixture = recordingRunner();
  assert.equal(await prepareResourceFixtures(fixture.run), 0);
  assert.equal(fixture.calls[0]?.script.split('/').at(-1), 'generate-e2e-video.ts');
  assert.deepEqual(fixture.calls[0]?.args, []);
  assert.deepEqual(fixture.calls[0]?.env, { PREPARE_RESOURCE_FIXTURES: 'true' });
});

test('child runner forwards argv, cwd, inherited env and overrides, then returns exit status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wmc-command-'));
  try {
    const script = join(dir, 'child.mjs');
    const output = join(dir, 'output.json');
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({ args: process.argv.slice(3), cwd: process.cwd(), value: process.env.PORTABLE_VALUE, path: process.env.PATH }));
process.exitCode = 17;
`
    );
    assert.equal(
      await runChild(script, [output, 'one', 'two words'], { PORTABLE_VALUE: 'override' }),
      17
    );
    const observed = JSON.parse(readFileSync(output, 'utf8')) as {
      args: string[];
      cwd: string;
      value: string;
      path: string;
    };
    assert.deepEqual(observed.args, ['one', 'two words']);
    assert.equal(observed.cwd, process.cwd());
    assert.equal(observed.value, 'override');
    assert.equal(observed.path, process.env.PATH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('child runner forwards SIGTERM and preserves the interrupted exit status', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wmc-command-signal-'));
  const childScript = join(dir, 'child.mjs');
  const marker = join(dir, 'marker');
  writeFileSync(
    childScript,
    `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], 'ready');
process.on('SIGTERM', () => { writeFileSync(process.argv[2], 'stopped'); process.exit(0); });
setInterval(() => {}, 1000);
`
  );
  const runnerUrl = new URL('./run-child.ts', import.meta.url).href;
  const supervisor = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `import { runChild } from ${JSON.stringify(runnerUrl)}; process.exitCode = await runChild(${JSON.stringify(childScript)}, [${JSON.stringify(marker)}]);`,
    ],
    { stdio: 'ignore' }
  );
  try {
    for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(readFileSync(marker, 'utf8'), 'ready');
    const closed = new Promise<number | null>((resolve) => supervisor.once('close', resolve));
    supervisor.kill('SIGTERM');
    const code = await closed;
    assert.equal(code, 143);
    assert.equal(readFileSync(marker, 'utf8'), 'stopped');
  } finally {
    supervisor.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
