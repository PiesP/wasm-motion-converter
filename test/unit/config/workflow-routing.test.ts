import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const classifier = resolve(root, 'scripts/ci/classify-workflow-changes.ts');

function classify(files: string[]): Record<string, string> {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', classifier, '--files-from-stdin'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: '' },
    input: `${files.join('\n')}\n`,
  });

  expect(result.status, result.stderr).toBe(0);
  return Object.fromEntries(
    result.stdout
      .trim()
      .split('\n')
      .map((line) => line.split('=', 2)),
  );
}

function classifyEvent(eventName: string, eventPath?: string): Record<string, string> {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', classifier], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: '',
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath ?? '',
    },
  });

  expect(result.status, result.stderr).toBe(0);
  return Object.fromEntries(
    result.stdout
      .trim()
      .split('\n')
      .map((line) => line.split('=', 2)),
  );
}

function gitFixture(): { directory: string; git: (...args: string[]) => string; write: (path: string, data: string) => void } {
  const directory = mkdtempSync(join(tmpdir(), 'wmc routing with spaces '));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  const write = (path: string, data: string) => {
    const fullPath = join(directory, path);
    mkdirSync(resolve(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, data);
  };
  git('init', '-q');
  git('config', 'user.name', 'Routing Fixture');
  git('config', 'user.email', 'routing@example.invalid');
  return { directory, git, write };
}

function classifyGitEvent(
  directory: string,
  eventName: string,
  payload: unknown,
  mergeSha = ''
): Record<string, string> {
  const eventPath = join(directory, 'event.json');
  writeFileSync(eventPath, JSON.stringify(payload));
  const result = spawnSync(process.execPath, ['--experimental-strip-types', classifier], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: '',
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_SHA: mergeSha,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return Object.fromEntries(
    result.stdout.trim().split('\n').map((line) => line.split('=', 2))
  );
}

function jobBlock(workflow: string, jobId: string): string {
  const marker = `  ${jobId}:\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`Workflow job not found: ${jobId}`);

  const afterMarker = start + marker.length;
  const nextJob = workflow.slice(afterMarker).search(/\n  [a-z][a-z0-9-]*:\n/);
  return workflow.slice(start, nextJob === -1 ? undefined : afterMarker + nextJob);
}

describe('Workflow change routing', () => {
  it('keeps documentation on lightweight secret scanning only', () => {
    expect(classify(['README.md'])).toMatchObject({
      all: 'false',
      quality: 'false',
      unit: 'false',
      e2e: 'false',
      build: 'false',
      duplication: 'false',
      mutation: 'false',
      dependency: 'false',
      codeql: 'false',
      semgrep: 'true',
      semgrep_full: 'false',
      security_tools: 'false',
    });
  });

  it('runs application gates for source changes', () => {
    expect(classify(['src/App.tsx'])).toMatchObject({
      all: 'false',
      quality: 'true',
      unit: 'true',
      e2e: 'true',
      build: 'true',
      duplication: 'true',
      mutation: 'true',
      dependency: 'false',
      codeql: 'true',
      semgrep: 'true',
      semgrep_full: 'true',
    });
  });

  it('treats dependency and shared-core changes as consumer-wide', () => {
    for (const path of ['pnpm-lock.yaml', 'packages/core']) {
      expect(classify([path]), path).toMatchObject({
        quality: 'true',
        unit: 'true',
        e2e: 'true',
        build: 'true',
        duplication: 'false',
        mutation: 'true',
        dependency: 'true',
        codeql: 'true',
        semgrep_full: 'true',
      });
    }
  });

  it('routes workflow changes to contract and security analysis', () => {
    expect(classify(['.github/workflows/ci.yaml'])).toMatchObject({
      all: 'true',
      quality: 'true',
      unit: 'true',
      e2e: 'true',
      build: 'true',
      duplication: 'true',
      dependency: 'true',
      codeql: 'true',
      semgrep_full: 'true',
      security_tools: 'true',
    });
    expect(classify(['.github/workflows/security.yaml'])).toMatchObject({
      unit: 'true',
      dependency: 'true',
      codeql: 'true',
      semgrep_full: 'true',
      security_tools: 'true',
    });
    expect(classify(['scripts/security/validate-osv-results.py'])).toMatchObject({
      unit: 'true',
      dependency: 'true',
    });
  });

  it('does not run code scanners for binary visual baselines', () => {
    expect(classify(['test/__screenshots__/e2e/example.png'])).toMatchObject({
      all: 'false',
      quality: 'false',
      unit: 'false',
      e2e: 'false',
      build: 'false',
      duplication: 'false',
      mutation: 'false',
      dependency: 'false',
      codeql: 'false',
      semgrep: 'false',
    });
  });

  it('fails safe for unknown paths, manual runs, and unreadable diffs', () => {
    for (const result of [
      classify(['new-unclassified-input.xyz']),
      classifyEvent('workflow_dispatch'),
      classifyEvent('push', '/definitely/missing/event.json'),
    ]) {
      expect(new Set(Object.values(result))).toEqual(new Set(['true']));
    }
  });

  it('enables every gate for a malformed event payload or unsupported CLI mode', () => {
    const { directory } = gitFixture();
    try {
      const eventPath = join(directory, 'event.json');
      writeFileSync(eventPath, '{"before":');
      expect(new Set(Object.values(classifyEvent('push', eventPath)))).toEqual(new Set(['true']));

      const unsupported = spawnSync(process.execPath, ['--experimental-strip-types', classifier, 'unknown-mode'], {
        cwd: directory,
        env: { ...process.env, GITHUB_OUTPUT: '' },
        encoding: 'utf8',
      });
      expect(unsupported.status).toBe(0);
      expect(unsupported.stderr).toContain('Unsupported classifier mode');
      expect(unsupported.stdout).toContain('security_tools=true\n');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('is import-inert and appends only fixed outputs to GITHUB_OUTPUT', () => {
    const imported = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', `import ${JSON.stringify(pathToFileURL(classifier).href)};`],
      { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch' } }
    );
    expect(imported.status).toBe(0);
    expect(imported.stdout).toBe('');
    expect(imported.stderr).toBe('');

    const { directory } = gitFixture();
    try {
      const output = join(directory, 'github-output');
      writeFileSync(output, 'existing=true\n');
      const result = spawnSync(process.execPath, ['--experimental-strip-types', classifier, '--files-from-stdin'], {
        cwd: directory,
        input: 'docs/path with spaces.md\n',
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: output },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(readFileSync(output, 'utf8')).toContain('existing=true\nall=false\n');
      expect(readFileSync(output, 'utf8')).toContain('semgrep=true\n');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('does not spawn Git or write outputs on import, and runs through a symlink', () => {
    const { directory } = gitFixture();
    try {
      const fakeBin = join(directory, 'fake-bin');
      mkdirSync(fakeBin);
      const gitRecord = join(directory, 'git-record');
      const output = join(directory, 'github-output');
      const eventPath = join(directory, 'event.json');
      writeFileSync(join(fakeBin, 'git'), '#!/bin/sh\nprintf invoked > "$GIT_RECORD"\n', { mode: 0o755 });
      writeFileSync(output, 'existing=true\n');
      writeFileSync(eventPath, JSON.stringify({ before: 'a'.repeat(40), after: 'b'.repeat(40) }));

      const imported = spawnSync(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', `import ${JSON.stringify(pathToFileURL(classifier).href)};`],
        {
          cwd: directory,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: fakeBin,
            GIT_RECORD: gitRecord,
            GITHUB_OUTPUT: output,
            GITHUB_EVENT_NAME: 'push',
            GITHUB_EVENT_PATH: eventPath,
          },
        }
      );
      expect(imported.status).toBe(0);
      expect(imported.stdout).toBe('');
      expect(imported.stderr).toBe('');
      expect(readFileSync(output, 'utf8')).toBe('existing=true\n');
      expect(() => readFileSync(gitRecord)).toThrow();

      const linked = join(directory, 'linked-classifier.ts');
      symlinkSync(classifier, linked);
      const invoked = spawnSync(process.execPath, ['--experimental-strip-types', linked, '--files-from-stdin'], {
        cwd: directory,
        input: 'README.md\n',
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: '' },
      });
      expect(invoked.status).toBe(0);
      expect(invoked.stdout).toContain('all=false\n');
      expect(invoked.stdout).toContain('semgrep=true\n');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the direct PR base/head diff, including paths absent from the PR head', () => {
    const { directory, git, write } = gitFixture();
    try {
      write('README.md', 'start\n');
      git('add', '-A');
      git('commit', '-qm', 'initial');
      const ancestor = git('rev-parse', 'HEAD');

      write('docs/pr.md', 'candidate\n');
      git('add', '-A');
      git('commit', '-qm', 'candidate');
      const head = git('rev-parse', 'HEAD');

      git('reset', '--hard', ancestor);
      write('package.json', '{}\n');
      git('add', '-A');
      git('commit', '-qm', 'base moved');
      const base = git('rev-parse', 'HEAD');

      const result = classifyGitEvent(directory, 'pull_request', { pull_request: { base: { sha: base } } }, head);
      expect(result).toMatchObject({ all: 'false', quality: 'true', dependency: 'true', security_tools: 'true' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('classifies both sides of renames, deleted paths, type changes and NUL-delimited names', () => {
    const { directory, git, write } = gitFixture();
    try {
      write('docs/source with space\nand newline.md', 'old\n');
      write('src/removed.ts', 'old\n');
      write('src/type.ts', 'old\n');
      git('add', '-A');
      git('commit', '-qm', 'initial');
      const before = git('rev-parse', 'HEAD');

      git('mv', 'docs/source with space\nand newline.md', 'src/destination with space\nand newline.ts');
      git('rm', 'src/removed.ts');
      rmSync(join(directory, 'src/type.ts'));
      symlinkSync('target.ts', join(directory, 'src/type.ts'));
      git('add', '-A');
      git('commit', '-qm', 'rename delete and type change');
      const after = git('rev-parse', 'HEAD');

      const diff = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', before, after], { cwd: directory }).toString('utf8');
      expect(diff).toContain('docs/source with space\nand newline.md\0');
      expect(diff).toContain('src/destination with space\nand newline.ts\0');
      expect(diff).toContain('src/removed.ts\0');
      expect(diff).toContain('src/type.ts\0');
      expect(classifyGitEvent(directory, 'push', { before, after })).toMatchObject({
        all: 'false', quality: 'true', build: 'true', duplication: 'true', semgrep: 'true', semgrep_full: 'true',
      });
      expect(classifyGitEvent(directory, 'merge_group', { merge_group: { base_sha: before, head_sha: after } })).toMatchObject({
        all: 'false', quality: 'true', build: 'true', duplication: 'true', semgrep: 'true', semgrep_full: 'true',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('classifies an isolated Git type change and deletion', () => {
    const { directory, git, write } = gitFixture();
    try {
      write('src/type.ts', 'original\n');
      git('add', '-A');
      git('commit', '-qm', 'regular file');
      const fileCommit = git('rev-parse', 'HEAD');

      rmSync(join(directory, 'src/type.ts'));
      symlinkSync('target.ts', join(directory, 'src/type.ts'));
      git('add', '-A');
      git('commit', '-qm', 'symlink type');
      const linkCommit = git('rev-parse', 'HEAD');
      expect(classifyGitEvent(directory, 'push', { before: fileCommit, after: linkCommit })).toMatchObject({
        all: 'false', quality: 'true', build: 'true', duplication: 'true', dependency: 'false',
      });

      git('rm', 'src/type.ts');
      git('commit', '-qm', 'delete symlink');
      const deletionCommit = git('rev-parse', 'HEAD');
      expect(classifyGitEvent(directory, 'push', { before: linkCommit, after: deletionCommit })).toMatchObject({
        all: 'false', quality: 'true', build: 'true', duplication: 'true', dependency: 'false',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('enables every gate for malformed boundaries, missing commits and empty Git diffs', () => {
    const { directory, git, write } = gitFixture();
    try {
      write('README.md', 'start\n');
      git('add', '-A');
      git('commit', '-qm', 'initial');
      const sha = git('rev-parse', 'HEAD');
      for (const result of [
        classifyGitEvent(directory, 'push', { before: '0'.repeat(40), after: sha }),
        classifyGitEvent(directory, 'push', { before: 'invalid', after: sha }),
        classifyGitEvent(directory, 'push', { before: 'a'.repeat(40), after: sha }),
        classifyGitEvent(directory, 'push', { before: sha, after: sha }),
        classifyGitEvent(directory, 'merge_group', { merge_group: { base_sha: sha, head_sha: 'bad' } }),
      ]) {
        expect(new Set(Object.values(result))).toEqual(new Set(['true']));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves required check names and broad required-workflow triggers', () => {
    const ci = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
    const security = readFileSync(resolve(root, '.github/workflows/security.yaml'), 'utf8');
    const requiredNames = [
      'pr-gate/quality',
      'pr-gate/unit',
      'pr-gate/e2e',
      'pr-gate/build',
      'pr-gate/osv / osv-scan',
      'pr-gate/semgrep',
    ];

    for (const name of requiredNames) {
      expect(`${ci}\n${security}`).toContain(`name: ${name}`);
    }
    for (const workflow of [ci, security]) {
      expect(workflow).not.toContain('report-pr-gate-statuses:');
      expect(workflow).not.toContain('statuses: write');
      expect(workflow).toContain('pull_request:\n    branches: [master]');
      expect(workflow).toContain('merge_group:\n    types: [checks_requested]');
    }
    expect(ci).not.toMatch(/pull_request:\n(?: {4}.*\n)* {4}paths:/);
    expect(security).not.toMatch(/pull_request:\n(?: {4}.*\n)* {4}paths:/);
    expect(ci).toContain('No quality-relevant changes');
    expect(security).toContain('No dependency-relevant changes');
    expect(security).toContain('No Semgrep-relevant changes');
  });

  it('turns routing checkout, execution, and output failures into full validation', () => {
    const ci = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
    const security = readFileSync(resolve(root, '.github/workflows/security.yaml'), 'utf8');
    const ciChanges = jobBlock(ci, 'changes');
    const securityChanges = jobBlock(security, 'changes');

    for (const changes of [ciChanges, securityChanges]) {
      expect(changes.match(/continue-on-error: true/g)).toHaveLength(4);
      expect(changes).toContain("if: ${{ steps.routing_checkout.outcome == 'success' }}");
      expect(changes).toContain("steps.routing_runtime.outcome == 'success'");
      expect(changes).toContain("install-dependencies: 'false'");
      expect(changes).toContain('uses: PiesP/browser-core/automation/actions/setup-project@279124fa998847bd0184d2de12bdaadcd6d2f969');
      expect(changes.indexOf('id: routing_runtime')).toBeLessThan(changes.indexOf('id: classify'));
      expect(changes).toContain('if: ${{ always() }}');
      expect(changes).toContain('CLASSIFY_OUTCOME: ${{ steps.classify.outcome }}');
      expect(changes).toContain('if [[ "$CLASSIFY_OUTCOME" != "success"');
      expect(changes).toContain('outputs:\n');
      expect(changes).toContain('steps.route.outputs.');
      expect(changes).toContain("steps.route.outcome == 'success'");
      expect(changes).toContain("|| 'true'");
    }

    for (const output of ['QUALITY', 'UNIT', 'E2E', 'BUILD', 'DUPLICATION']) {
      expect(ciChanges).toContain(`${output}=true`);
    }
    for (const output of [
      'DEPENDENCY',
      'CODEQL',
      'SEMGREP',
      'SEMGREP_FULL',
      'SECURITY_TOOLS',
    ]) {
      expect(securityChanges).toContain(`${output}=true`);
    }
  });

  it('executes the change classifier from the trusted base revision for PR-like events', () => {
    const ci = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
    const security = readFileSync(resolve(root, '.github/workflows/security.yaml'), 'utf8');

    for (const workflow of [ci, security]) {
      const changes = jobBlock(workflow, 'changes');
      expect(changes).toContain('pull_request | merge_group');
      expect(changes).toContain(
        'git show "$TRUSTED_BASE_SHA:scripts/ci/classify-workflow-changes.ts"'
      );
      expect(changes).toContain('node --experimental-strip-types "$classifier"');
    }
  });
});
