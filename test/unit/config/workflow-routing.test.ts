import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const classifier = resolve(root, 'scripts/ci/classify-workflow-changes.sh');

function classify(files: string[]): Record<string, string> {
  const result = spawnSync('bash', [classifier, '--files-from-stdin'], {
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
  const result = spawnSync('bash', [classifier], {
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

  it('preserves required check names and broad required-workflow triggers', () => {
    const ci = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
    const security = readFileSync(resolve(root, '.github/workflows/security.yaml'), 'utf8');
    const requiredNames = [
      'pr-gate/quality',
      'pr-gate/unit',
      'pr-gate/e2e',
      'pr-gate/build',
      'pr-gate/duplication',
      'pr-gate/osv / osv-scan',
      'pr-gate/semgrep',
    ];

    for (const name of requiredNames) {
      expect(`${ci}\n${security}`).toContain(`name: ${name}`);
    }
    for (const workflow of [ci, security]) {
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
      expect(changes.match(/continue-on-error: true/g)).toHaveLength(3);
      expect(changes).toContain("if: ${{ steps.routing_checkout.outcome == 'success' }}");
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
        'git show "$TRUSTED_BASE_SHA:scripts/ci/classify-workflow-changes.sh"'
      );
      expect(changes).toContain('bash "$classifier"');
    }
  });
});
