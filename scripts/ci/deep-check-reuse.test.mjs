import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fingerprint, shouldReuse, validMarker, writeMarker } from './deep-check-reuse.mjs';

const fixture = mkdtempSync(join(tmpdir(), 'deep-check-reuse-'));
after(() => rmSync(fixture, { recursive: true, force: true }));

function write(path, content) {
  const fullPath = join(fixture, path);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
}

function git(...args) {
  execFileSync('git', args, { cwd: fixture });
}

git('init', '-q');
write(
  'package.json',
  JSON.stringify({
    packageManager: 'pnpm@11.26.0',
    volta: { node: '26.9.0', pnpm: '11.26.0' },
  })
);
for (const path of [
  'src/app.ts',
  'test/app.test.ts',
  'stryker.conf.fast.json',
  'pnpm-lock.yaml',
  'scripts/ci/install-nose.sh',
  '.github/workflows/deep-checks.yaml',
]) {
  write(path, 'original\n');
}
git('add', '-A');
git(
  'update-index',
  '--add',
  '--cacheinfo',
  '160000,1111111111111111111111111111111111111111,packages/core'
);

const runner = {
  RUNNER_OS: 'Linux',
  RUNNER_ARCH: 'X64',
  ImageOS: 'ubuntu24',
  ImageVersion: '20261001.1',
};
const baseline = fingerprint('duplication', fixture, runner);

test('each tracked source, test, configuration, lock, and tool input invalidates success', () => {
  assert.match(baseline, /^[0-9a-f]{64}$/);
  for (const path of [
    'src/app.ts',
    'test/app.test.ts',
    'stryker.conf.fast.json',
    'pnpm-lock.yaml',
    'scripts/ci/install-nose.sh',
    '.github/workflows/deep-checks.yaml',
    'package.json',
  ]) {
    write(
      path,
      path === 'package.json'
        ? JSON.stringify({
            packageManager: 'pnpm@11.26.0',
            volta: { node: '26.9.1', pnpm: '11.26.0' },
          })
        : 'changed\n'
    );
    assert.notEqual(fingerprint('duplication', fixture, runner), baseline, path);
    if (path === 'package.json') {
      write(
        path,
        JSON.stringify({
          packageManager: 'pnpm@11.26.0',
          volta: { node: '26.9.0', pnpm: '11.26.0' },
        })
      );
    } else {
      write(path, 'original\n');
    }
  }
  assert.equal(fingerprint('duplication', fixture, runner), baseline);
});

test('gitlink, runner image, and gate identity invalidate success', () => {
  git(
    'update-index',
    '--add',
    '--cacheinfo',
    '160000,2222222222222222222222222222222222222222,packages/core'
  );
  assert.notEqual(fingerprint('duplication', fixture, runner), baseline);
  git(
    'update-index',
    '--add',
    '--cacheinfo',
    '160000,1111111111111111111111111111111111111111,packages/core'
  );
  assert.notEqual(
    fingerprint('duplication', fixture, { ...runner, ImageVersion: '20261001.2' }),
    baseline
  );
  assert.notEqual(fingerprint('mutation', fixture, runner), baseline);
  assert.equal(fingerprint('duplication', fixture, { ...runner, ImageVersion: '' }), null);
});

test('only a valid successful marker can be reused', () => {
  const marker = join(fixture, 'marker.json');
  assert.equal(validMarker(marker, 'duplication', baseline), false);
  writeMarker(marker, 'duplication', baseline);
  assert.equal(validMarker(marker, 'duplication', baseline), true);
  assert.equal(validMarker(marker, 'mutation', baseline), false);
  assert.equal(validMarker(marker, 'duplication', '0'.repeat(64)), false);
  writeFileSync(
    marker,
    JSON.stringify({
      schema: 1,
      gate: 'duplication',
      fingerprint: baseline,
      result: 'failure',
    })
  );
  assert.equal(validMarker(marker, 'duplication', baseline), false);
  writeFileSync(marker, 'corrupt');
  assert.equal(validMarker(marker, 'duplication', baseline), false);
});

test('schedule reuses success; manual defaults to fresh and can opt in', () => {
  const decide = (valid, event, choice, hit = 'true', outcome = 'success') =>
    shouldReuse(valid, hit, outcome, event, choice);
  assert.equal(decide(true, 'schedule', ''), true);
  assert.equal(decide(false, 'schedule', ''), false);
  assert.equal(decide(true, 'schedule', '', '', 'success'), false);
  assert.equal(decide(true, 'schedule', '', 'true', 'failure'), false);
  assert.equal(decide(true, 'workflow_dispatch', ''), false);
  assert.equal(decide(true, 'workflow_dispatch', 'false'), false);
  assert.equal(decide(true, 'workflow_dispatch', 'true'), true);
  assert.equal(decide(true, 'push', 'true'), false);
});

test('CLI emits a reusable result only after a successful marker is present', () => {
  const script = fileURLToPath(new URL('./deep-check-reuse.mjs', import.meta.url));
  const output = join(fixture, 'output.txt');
  const marker = join(fixture, 'cli-marker.json');
  const run = (args, extraEnv = {}) => {
    writeFileSync(output, '');
    execFileSync(process.execPath, [script, ...args], {
      cwd: fixture,
      env: { ...process.env, ...runner, GITHUB_OUTPUT: output, ...extraEnv },
    });
    return readFileSync(output, 'utf8');
  };
  assert.match(run(['fingerprint', 'duplication']), new RegExp(`fingerprint=${baseline}`));
  const verifyEnv = {
    CACHE_HIT: 'true',
    RESTORE_OUTCOME: 'success',
    GITHUB_EVENT_NAME: 'schedule',
  };
  assert.match(run(['verify', 'duplication', baseline, marker], verifyEnv), /reuse=false/);
  run(['mark', 'duplication', baseline, marker]);
  assert.match(run(['verify', 'duplication', baseline, marker], verifyEnv), /reuse=true/);
  assert.match(
    run(['verify', 'duplication', baseline, marker], {
      ...verifyEnv,
      RESTORE_OUTCOME: 'failure',
    }),
    /reuse=false/
  );
});
