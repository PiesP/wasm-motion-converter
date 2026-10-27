import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { test } from 'vite-plus/test';

import { prepareResourceFixtures } from '../test/prepare-resource-fixtures.ts';
import { runE2eOnFreePort } from '../test/run-e2e-on-free-port.ts';
import { runPlaywright } from '../test/run-playwright.ts';
import { packageBinary, runChild } from './run-child.ts';

test('portable adapters remain inert when imported with a missing argv entry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wmc-command-import-'));
  try {
    const modules = [
      new URL('../test/run-playwright.ts', import.meta.url).href,
      new URL('../test/prepare-resource-fixtures.ts', import.meta.url).href,
      new URL('../test/run-e2e-on-free-port.ts', import.meta.url).href,
    ];
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `process.argv[1] = ${JSON.stringify(join(directory, 'absent.ts'))};
       process.argv[2] = 'invalid-mode';
       for (const url of ${JSON.stringify(modules)}) await import(url);`,
      ],
      { cwd: directory, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('free-port runner uses the local Vite+ task, releases the probe, and returns child status', async () => {
  const listeners = ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal));
  for (const status of [0, 19]) {
    const fixture = recordingRunner([status]);
    assert.equal(await runE2eOnFreePort(fixture.run), status);
    assert.equal(fixture.calls.length, 1);
    assert.equal(basename(fixture.calls[0]?.script ?? ''), 'vp');
    assert.deepEqual(fixture.calls[0]?.options, { signalScope: 'process-group' });
    assert.deepEqual(fixture.calls[0]?.args, ['run', 'test:e2e:ci']);
    assert.deepEqual(Object.keys(fixture.calls[0]?.env ?? {}), ['PLAYWRIGHT_DEV_PORT']);
    const port = Number(fixture.calls[0]?.env.PLAYWRIGHT_DEV_PORT);
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port }, resolve);
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
  assert.deepEqual(
    ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal)),
    listeners
  );
});

test('free-port allocation failures close the probe and preserve the original diagnostic', () => {
  const wrapper = new URL('../test/run-e2e-on-free-port.ts', import.meta.url).href;
  for (const injected of ['listen', 'address', 'cleanup']) {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `import { Server } from 'node:net';
const close = Server.prototype.close;
let closed = false;
Server.prototype.close = function(callback) {
  closed = true;
  return close.call(this, ${JSON.stringify(injected)} === 'cleanup' ? () => callback(new Error('cleanup control')) : callback);
};
if (${JSON.stringify(injected)} === 'listen') Server.prototype.listen = function() { throw new Error('listen control'); };
else Server.prototype.address = () => null;
const { runE2eOnFreePort } = await import(${JSON.stringify(wrapper)});
try { await runE2eOnFreePort(); process.exitCode = 99; }
catch(error) { console.log(JSON.stringify({error: error.message, closed})); }
`,
      ],
      { env: process.env, encoding: 'utf8', timeout: 10_000 }
    );
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout) as { error: string; closed: boolean };
    assert.equal(
      observed.error,
      injected === 'listen'
        ? 'listen control'
        : 'Could not allocate a local TCP port for Playwright.'
    );
    assert.equal(observed.closed, injected !== 'listen');
    if (injected === 'cleanup') assert.match(result.stderr, /cleanup control/);
  }
});

test('child runner removes listeners after missing child and child-initiated signals', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wmc-run-child-terminal-'));
  const before = ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal));
  try {
    assert.equal(await runChild(join(directory, 'missing.mjs')), 1);
    if (process.platform !== 'win32') {
      for (const signal of ['SIGINT', 'SIGTERM']) {
        const script = join(directory, 'signal.mjs');
        writeFileSync(script, `process.kill(process.pid, ${JSON.stringify(signal)});`);
        assert.equal(await runChild(script), signal === 'SIGINT' ? 130 : 143);
      }
    }
    assert.deepEqual(
      ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal)),
      before
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('child startup failure removes listeners without hiding the original error', () => {
  const runner = new URL('./run-child.ts', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `import { runChild } from ${JSON.stringify(runner)};
const before = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
Object.defineProperty(process, 'execPath', {value: 'missing-node-startup-control'});
try { await runChild('unused'); process.exitCode = 99; }
catch(error) { console.log(JSON.stringify({code: error.code, before, after: ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))})); }
`,
    ],
    { encoding: 'utf8', timeout: 10_000 }
  );
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout) as { code: string; before: number[]; after: number[] };
  assert.equal(observed.code, 'ENOENT');
  assert.deepEqual(observed.after, observed.before);
});

test('child completion and interruption settle once according to observed event order', () => {
  const runner = new URL('./run-child.ts', import.meta.url).href;
  for (const order of ['interrupt-first', 'exit-first']) {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
const child = new EventEmitter();
const forwarded = [];
child.kill = signal => { forwarded.push(signal); return true; };
childProcess.spawn = () => child;
syncBuiltinESMExports();
const { runChild } = await import(${JSON.stringify(runner)});
const before = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
const completion = runChild('owned-fixture');
if (${JSON.stringify(order)} === 'interrupt-first') process.emit('SIGTERM');
child.emit('exit', 7, null);
const code = await completion;
process.emit('SIGTERM');
child.emit('exit', 99, null);
console.log(JSON.stringify({code, forwarded, before, after: ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))}));
`,
      ],
      { encoding: 'utf8', timeout: 10_000 }
    );
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout) as {
      code: number;
      forwarded: string[];
      before: number[];
      after: number[];
    };
    assert.equal(observed.code, order === 'interrupt-first' ? 143 : 7);
    assert.deepEqual(observed.forwarded, order === 'interrupt-first' ? ['SIGTERM'] : []);
    assert.deepEqual(observed.after, observed.before);
  }
});

test('process-group signals use only the dedicated supervised POSIX group', () => {
  const runner = new URL('./run-child.ts', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
const child = new EventEmitter();
child.pid = 424242;
const delivered = [];
let spawnOptions;
child.kill = signal => { delivered.push(['child', signal]); return true; };
childProcess.spawn = (executable, args, options) => { spawnOptions = options; return child; };
process.kill = (pid, signal) => { delivered.push([pid, signal]); return true; };
syncBuiltinESMExports();
const { runChild } = await import(${JSON.stringify(runner)});
const done = runChild('owned-playwright', [], {}, {signalScope: 'process-group', gracefulTerminationSignal:'SIGINT'});
process.emit('SIGTERM');
child.emit('exit', 0, null);
console.log(JSON.stringify({code: await done, delivered, detached: spawnOptions.detached, stdio: spawnOptions.stdio}));
`,
    ],
    { encoding: 'utf8', timeout: 10_000 }
  );
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout) as {
    code: number;
    delivered: unknown[];
    detached: boolean;
    stdio: string;
  };
  assert.equal(observed.code, 143);
  assert.equal(observed.detached, process.platform !== 'win32');
  assert.equal(observed.stdio, 'inherit');
  assert.deepEqual(observed.delivered, [
    [
      process.platform === 'win32' ? 'child' : -424242,
      process.platform === 'win32' ? 'SIGTERM' : 'SIGINT',
    ],
  ]);
});

type Call = {
  script: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  options: Parameters<typeof runChild>[3];
};

function recordingRunner(results: number[] = []) {
  const calls: Call[] = [];
  const run: typeof runChild = async (script, args = [], env = {}, options) => {
    calls.push({ script, args, env, options });
    return results.shift() ?? 0;
  };
  return { calls, run };
}

test('Vite+ build lifecycle stops at the failing license, build, or postbuild phase', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wmc-vp-lifecycle-'));
  const vp = packageBinary('vite-plus', 'vp');
  try {
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        scripts: {
          prebuild: 'node step.mjs license',
          build: 'node step.mjs build',
          postbuild: 'node step.mjs postbuild',
        },
      })
    );
    writeFileSync(
      join(directory, 'step.mjs'),
      `import { appendFileSync } from 'node:fs';
const step = process.argv[2];
appendFileSync(process.env.STEP_LOG, step + '\\n');
if (process.env.FAIL_STEP === step) process.exitCode = 17;
`
    );
    for (const [failed, expected] of [
      ['license', ['license']],
      ['build', ['license', 'build']],
      ['postbuild', ['license', 'build', 'postbuild']],
      ['', ['license', 'build', 'postbuild']],
    ] as const) {
      const log = join(directory, 'steps');
      writeFileSync(log, '');
      const result = spawnSync(process.execPath, [vp, 'run', 'build'], {
        cwd: directory,
        env: { ...process.env, STEP_LOG: log, FAIL_STEP: failed },
        encoding: 'utf8',
        timeout: 20_000,
      });
      assert.equal(result.status, failed ? 17 : 0, result.stderr);
      assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), expected);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Playwright profiles override only their own profile; resource fixture flag stays scoped', async () => {
  for (const profile of ['ci', 'resource', 'deploy'] as const) {
    const fixture = recordingRunner([5]);
    assert.equal(await runPlaywright(profile, ['--list', 'some test'], fixture.run), 5);
    assert.deepEqual(fixture.calls[0]?.args, ['test', '--list', 'some test']);
    assert.equal(fixture.calls[0]?.env.PLAYWRIGHT_TEST_PROFILE, profile);
    assert.equal(fixture.calls[0]?.env.PREPARE_RESOURCE_FIXTURES, undefined);
    assert.deepEqual(fixture.calls[0]?.options, {
      signalScope: 'process-group',
      gracefulTerminationSignal: 'SIGINT',
    });
  }
  const fixture = recordingRunner();
  assert.equal(await prepareResourceFixtures(fixture.run), 0);
  assert.equal(basename(fixture.calls[0]?.script ?? ''), 'generate-e2e-video.ts');
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

test(
  'child runner forwards SIGTERM and preserves the interrupted exit status',
  {
    skip: process.platform === 'win32',
  },
  async () => {
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
  }
);
