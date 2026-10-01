import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
let fixture: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: fixture, encoding: 'utf8' }).trim();
}
function hook(name: string, input = '') {
  return spawnSync('bash', [join(root, '.githooks', name)], {
    cwd: fixture, encoding: 'utf8', input,
  });
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'maintenance-hooks-'));
  git('init', '--quiet', '--initial-branch=codex/fixture');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('commit', '--quiet', '--allow-empty', '-m', 'fixture');
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

describe('protected PR landing hooks', () => {
  it('allows work-branch commits and pushes', () => {
    expect(hook('pre-commit').status).toBe(0);
    const sha = git('rev-parse', 'HEAD');
    expect(hook('pre-push', `refs/heads/codex/fixture ${sha} refs/heads/codex/fixture ${sha}\n`).status).toBe(0);
  });
  it('rejects default commits even during a merge and rejects detached commits', () => {
    git('switch', '-c', 'master');
    writeFileSync(join(fixture, '.git/MERGE_HEAD'), `${git('rev-parse', 'HEAD')}\n`);
    expect(hook('pre-commit').status).toBe(1);
    rmSync(join(fixture, '.git/MERGE_HEAD'));
    git('checkout', '--detach');
    expect(hook('pre-commit').status).toBe(1);
  });
  it('rejects direct default pushes and deletion regardless of commit ancestry', () => {
    const sha = git('rev-parse', 'HEAD');
    const zero = '0'.repeat(40);
    for (const branch of ['master', 'main']) {
      expect(hook('pre-push', `refs/heads/codex/fixture ${sha} refs/heads/${branch} ${sha}\n`).status).toBe(1);
      expect(hook('pre-push', `(delete) ${zero} refs/heads/${branch} ${sha}\n`).status).toBe(1);
    }
  });
});
