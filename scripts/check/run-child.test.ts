import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runVite } from '../build/run-vite.ts';
import { prepareResourceFixtures } from '../test/prepare-resource-fixtures.ts';
import { runE2eOnFreePort } from '../test/run-e2e-on-free-port.ts';
import { runPlaywright } from '../test/run-playwright.ts';
import { runChild } from './run-child.ts';

function closeWithin(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const onClose = (code: number | null): void => {
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      child.off('close', onClose);
      reject(new Error('Owned child did not close before the deadline.'));
    }, 5_000);
    child.once('close', onClose);
  });
}

test('portable adapters remain inert when imported with a missing argv entry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wmc-command-import-'));
  try {
    const modules = [
      new URL('../build/run-vite.ts', import.meta.url).href,
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

test('free-port wrapper keeps package lifecycle and releases the port before child startup', async () => {
  const previous = process.env.npm_execpath;
  const listeners = ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal));
  process.env.npm_execpath = '/package manager with spaces/pnpm.cjs';
  try {
    for (const status of [0, 19]) {
      const fixture = recordingRunner([status]);
      assert.equal(await runE2eOnFreePort(fixture.run), status);
      assert.equal(fixture.calls.length, 1);
      assert.equal(fixture.calls[0]?.script, process.env.npm_execpath);
      assert.deepEqual(fixture.calls[0]?.options, {
        signalScope: 'process-group',
        executable: false,
      });
      assert.deepEqual(fixture.calls[0]?.args, ['test:e2e:ci']);
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
    process.env.npm_execpath = '/package manager with spaces/pnpm';
    const native = recordingRunner();
    assert.equal(await runE2eOnFreePort(native.run), 0);
    assert.equal(native.calls[0]?.script, process.env.npm_execpath);
    assert.deepEqual(native.calls[0]?.options, {
      signalScope: 'process-group',
      executable: true,
    });
    assert.equal(
      native.calls[0]?.env.PATH,
      `${dirname(process.env.npm_execpath)}${delimiter}${process.env.PATH ?? ''}`
    );
    delete process.env.npm_execpath;
    const missing = recordingRunner();
    await assert.rejects(runE2eOnFreePort(missing.run), /npm_execpath is required/);
    assert.equal(missing.calls.length, 0);
    assert.deepEqual(
      ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal)),
      listeners
    );
  } finally {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
  }
});

test('free-port CLI preserves status, inherited environment, cwd and startup diagnostics', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wmc free port '));
  const wrapper = new URL('../test/run-e2e-on-free-port.ts', import.meta.url);
  const script = join(directory, 'package manager.mjs');
  const output = join(directory, 'observed.json');
  try {
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.OUTPUT, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), path: process.env.PATH, value: process.env.INHERITED_VALUE, port: process.env.PLAYWRIGHT_DEV_PORT}));
process.exitCode = Number(process.env.STATUS);
`
    );
    for (const status of [0, 23]) {
      const result = spawnSync(
        process.execPath,
        ['--experimental-strip-types', fileURLToPath(wrapper)],
        {
          cwd: directory,
          env: {
            ...process.env,
            npm_execpath: script,
            OUTPUT: output,
            INHERITED_VALUE: 'kept',
            STATUS: String(status),
          },
          encoding: 'utf8',
          timeout: 10_000,
        }
      );
      assert.equal(result.status, status, result.stderr);
      const observed = JSON.parse(readFileSync(output, 'utf8')) as {
        args: string[];
        cwd: string;
        path: string;
        value: string;
        port: string;
      };
      assert.deepEqual(observed.args, ['test:e2e:ci']);
      assert.equal(observed.cwd, directory);
      assert.equal(observed.path, process.env.PATH);
      assert.equal(observed.value, 'kept');
      assert.ok(Number(observed.port) > 0 && Number(observed.port) <= 65535);
    }
    for (const execpath of ['', join(directory, 'missing.mjs')]) {
      const result = spawnSync(
        process.execPath,
        ['--experimental-strip-types', fileURLToPath(wrapper)],
        {
          cwd: directory,
          env: { ...process.env, npm_execpath: execpath },
          encoding: 'utf8',
          timeout: 10_000,
        }
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, execpath ? /MODULE_NOT_FOUND/ : /npm_execpath is required/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
      { env: { ...process.env, npm_execpath: 'unused' }, encoding: 'utf8', timeout: 10_000 }
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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(
    `free-port CLI forwards parent-only ${signal} and observes owned child disappearance`,
    {
      skip: process.platform === 'win32',
      timeout: 15_000,
    },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'wmc-free-port-signal-'));
      const script = join(directory, 'package manager.mjs');
      const marker = join(directory, 'marker.json');
      const stopped = join(directory, 'stopped');
      const wrapper = new URL('../test/run-e2e-on-free-port.ts', import.meta.url);
      writeFileSync(
        script,
        `import { writeFileSync, renameSync } from 'node:fs';
const signal = process.env.PROBE_SIGNAL;
if (!['SIGINT', 'SIGTERM'].includes(signal)) throw new Error('Expected a probe signal.');
process.on(signal, () => { writeFileSync(process.env.STOPPED, signal); process.exit(0); });
writeFileSync(process.env.MARKER + '.tmp', JSON.stringify({pid: process.pid}));
renameSync(process.env.MARKER + '.tmp', process.env.MARKER);
setInterval(() => {}, 1000);
`
      );
      const supervisor = spawn(
        process.execPath,
        ['--experimental-strip-types', fileURLToPath(wrapper)],
        {
          env: {
            ...process.env,
            npm_execpath: script,
            MARKER: marker,
            STOPPED: stopped,
            PROBE_SIGNAL: signal,
          },
          stdio: 'ignore',
        }
      );
      let childPid: number | undefined;
      try {
        for (let attempt = 0; attempt < 250 && !existsSync(marker); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        childPid = (JSON.parse(readFileSync(marker, 'utf8')) as { pid: number }).pid;
        const closed = closeWithin(supervisor);
        supervisor.kill(signal);
        assert.equal(await closed, signal === 'SIGINT' ? 130 : 143);
        assert.equal(readFileSync(stopped, 'utf8'), signal);
        const observedPid = childPid;
        assert.throws(() => process.kill(observedPid, 0), { code: 'ESRCH' });
      } finally {
        supervisor.kill('SIGKILL');
        if (childPid) {
          try {
            process.kill(childPid, 'SIGKILL');
          } catch {
            /* Already reaped. */
          }
        }
        await closeWithin(supervisor);
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
}

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

test('build:ci preserves license, Vite, and postbuild order and stops on failure', async () => {
  const success = recordingRunner();
  assert.equal(await runVite('ci', ['--emptyOutDir'], success.run), 0);
  assert.deepEqual(
    success.calls.map(({ script }) => basename(script)),
    ['generate-licenses.ts', 'vp', 'postbuild.ts']
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
  const postbuildFailure = recordingRunner([0, 0, 11]);
  assert.equal(await runVite('ci', [], postbuildFailure.run), 11);
  assert.equal(postbuildFailure.calls.length, 3);
});

test('Vite commands keep their arguments and command-specific environment', async () => {
  for (const [mode, expectedArgs] of [
    ['dev', ['dev', '--host', '127.0.0.1']],
    ['build', ['build', '--host', '127.0.0.1']],
    ['preview', ['preview', '--host', '127.0.0.1']],
  ] as const) {
    const fixture = recordingRunner();
    assert.equal(await runVite(mode, ['--host', '127.0.0.1'], fixture.run), 0);
    assert.deepEqual(fixture.calls[0]?.args, expectedArgs);
    assert.equal(fixture.calls[0]?.env.NODE_OPTIONS, '--no-deprecation');
    assert.equal(fixture.calls[0]?.env.VITE_ANALYZE_BUNDLE, undefined);
    assert.equal(fixture.calls.length, 1);
    const failure = recordingRunner([13]);
    assert.equal(await runVite(mode, ['--host', '127.0.0.1'], failure.run), 13);
    assert.deepEqual(failure.calls[0]?.args, expectedArgs);
    assert.equal(failure.calls.length, 1);
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
  'child runner executes a native package manager without a Node launcher',
  {
    skip: process.platform === 'win32',
  },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wmc-native-manager-'));
    try {
      const manager = join(directory, 'pnpm');
      const output = join(directory, 'args');
      writeFileSync(manager, '#!/bin/sh\nprintf "%s" "$1" > "$2"\nexit 23\n');
      chmodSync(manager, 0o755);
      assert.equal(await runChild(manager, ['test:e2e:ci', output], {}, { executable: true }), 23);
      assert.equal(readFileSync(output, 'utf8'), 'test:e2e:ci');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);

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
