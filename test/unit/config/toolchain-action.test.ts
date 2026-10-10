import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const ciWorkflow = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
const deepChecksWorkflow = readFileSync(resolve(root, '.github/workflows/deep-checks.yaml'), 'utf8');
const releaseWorkflow = readFileSync(resolve(root, '.github/workflows/release.yaml'), 'utf8');
const centralSetupAction =
  'uses: PiesP/browser-core/automation/actions/setup-project@279124fa998847bd0184d2de12bdaadcd6d2f969';
const releaseSetupActionPath = resolve(root, '.github/actions/setup-release/action.yaml');
const releaseSetupAction = existsSync(releaseSetupActionPath)
  ? readFileSync(releaseSetupActionPath, 'utf8')
  : '';
const localReleaseSetupAction = 'uses: ./.github/actions/setup-release';

function jobBlock(workflow: string, jobId: string): string {
  const marker = `  ${jobId}:\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`Workflow job not found: ${jobId}`);

  const afterMarker = start + marker.length;
  const nextJob = workflow.slice(afterMarker).search(/\n  [a-z][a-z0-9-]*:\n/);
  return workflow.slice(start, nextJob === -1 ? undefined : afterMarker + nextJob);
}

function topLevelBlock(workflow: string, key: string): string {
  const marker = `${key}:\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`Workflow key not found: ${key}`);

  const afterMarker = start + marker.length;
  const nextKey = workflow.slice(afterMarker).search(/\n[A-Za-z][A-Za-z0-9_-]*:\n/);
  return workflow.slice(start, nextKey === -1 ? undefined : afterMarker + nextKey).trimEnd();
}

describe('central project setup action', () => {
  it('pins the shared action independently from the runtime gitlink', () => {
    expect(centralSetupAction).toMatch(/@[0-9a-f]{40}$/);
    expect(existsSync(resolve(root, '.github/actions/setup-project/action.yaml'))).toBe(false);
    expect(existsSync(resolve(root, '.github/actions/setup-toolchain/action.yaml'))).toBe(false);
  });

  it('configures CI and deep jobs through the central action', () => {
    const expectedJobs = [
      ['CI quality', ciWorkflow, 'quality'],
      ['CI unit', ciWorkflow, 'unit'],
      ['CI E2E', ciWorkflow, 'e2e'],
      ['CI build', ciWorkflow, 'build'],
      ['Deep mutation', deepChecksWorkflow, 'mutation'],
    ] as const;

    for (const [label, workflow, jobId] of expectedJobs) {
      const job = jobBlock(workflow, jobId);
      expect(job, label).toContain(centralSetupAction);
      expect(job, label).not.toContain('node-version:');
    }

    for (const workflow of [ciWorkflow, deepChecksWorkflow]) {
      expect(workflow).not.toContain(localReleaseSetupAction);
    }
  });

  it('uses a locally reviewable setup action for every dependency-backed release job', () => {
    const expectedJobs = [
      ['Release quality', 'quality'],
      ['Release unit', 'unit'],
      ['Release E2E', 'e2e'],
      ['Release mutation', 'mutation'],
      ['Release build', 'build'],
    ] as const;

    expect(existsSync(releaseSetupActionPath)).toBe(true);
    expect(releaseSetupAction).toContain(
      'uses: pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b # v2.1.0'
    );
    expect(releaseSetupAction).toContain('package-json-file: package.json');
    expect(releaseSetupAction).toContain('runtime: "node@${{ steps.runtime.outputs.version }}"');
    expect(releaseSetupAction).toContain('cache: true');
    expect(releaseSetupAction).toContain('install: false');
    expect(releaseSetupAction).toContain('run: pnpm install --frozen-lockfile --no-runtime');

    for (const [label, jobId] of expectedJobs) {
      const job = jobBlock(releaseWorkflow, jobId);
      expect(job, label).toContain(localReleaseSetupAction);
      expect(job, label).not.toContain(centralSetupAction);
      expect(job, label).toContain('node-version: ${{ needs.provenance.outputs.node-version }}');
    }

    expect(releaseWorkflow.split(localReleaseSetupAction)).toHaveLength(expectedJobs.length + 1);
    const duplication = jobBlock(releaseWorkflow, 'duplication');
    expect(duplication).toContain(centralSetupAction);
    expect(duplication).toContain("install-dependencies: 'false'");
    const provenance = jobBlock(releaseWorkflow, 'provenance');
    expect(provenance).toContain(centralSetupAction);
    expect(provenance).toContain("install-dependencies: 'false'");
    expect(releaseWorkflow.replace(duplication, '').replace(provenance, '')).not.toContain(centralSetupAction);
  });

  it('keeps direct toolchain setup and frozen installs out of project workflows', () => {
    for (const workflow of [ciWorkflow, deepChecksWorkflow, releaseWorkflow]) {
      expect(workflow).not.toContain('uses: ./.github/actions/setup-toolchain');
      expect(workflow).not.toContain('uses: ./.github/actions/setup-project');
      expect(workflow).not.toContain('run: pnpm install --frozen-lockfile');
      expect(workflow).not.toContain('uses: pnpm/action-setup@');
      expect(workflow).not.toContain('uses: actions/setup-node@');
    }
  });

  it('selects the protected checkout for the direct publication runtime setup', () => {
    const publish = jobBlock(releaseWorkflow, 'publish');
    const checkoutMarker = '      - name: 📥 Checkout protected publication guard\n';
    const checkout = publish.split(checkoutMarker)[1]?.split('\n      - name:')[0];
    const setupMarker = '      - name: 📦 Setup verified Node.js runtime\n';
    const setup = publish.split(setupMarker)[1]?.split('\n      - name:')[0];

    expect(setup).toBeDefined();
    expect(setup).toContain(
      'uses: pnpm/setup@fbda4c85fc2e1e08721cd8763afea8f48d60f024 # v3.0.0'
    );
    expect(checkout).toContain('ref: ${{ github.sha }}');
    expect(checkout).toContain('persist-credentials: false');
    expect(checkout).not.toContain('release-sha');
    expect(publish.indexOf(checkoutMarker)).toBeLessThan(publish.indexOf(setupMarker));
    expect(setup).toContain('working-directory: .');
    expect(setup).not.toContain('package-json-file:');
    expect(setup).toContain('runtime: "node@${{ needs.provenance.outputs.node-version }}"');
    expect(setup).toContain('install: false');
    expect(publish.indexOf(setupMarker)).toBeLessThan(
      publish.indexOf('      - name: 🔐 Check live publication order')
    );
  });

  it('runs releases only by protected-master manual dispatch', () => {
    expect(topLevelBlock(releaseWorkflow, 'on')).toBe(
      'on:\n' +
        '  workflow_dispatch:\n' +
        '    inputs:\n' +
        '      tag:\n' +
        '        description: Existing release tag (vX.Y.Z) contained in protected master\n' +
        '        required: true\n' +
        '        type: string'
    );
    expect(jobBlock(releaseWorkflow, 'provenance')).toContain(
      "if: ${{ github.ref == 'refs/heads/master' }}"
    );
  });
});
