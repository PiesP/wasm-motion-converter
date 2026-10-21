// GitHub Actions expressions are literal workflow assertions.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');
const ciWorkflow = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
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
  const nextJob = workflow.slice(afterMarker).search(/\n {2}[a-z][a-z0-9-]*:\n/);
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
    ] as const;

    for (const [label, workflow, jobId] of expectedJobs) {
      const job = jobBlock(workflow, jobId);
      expect(job, label).toContain(centralSetupAction);
      expect(job, label).not.toContain('node-version:');
    }

    const unit = jobBlock(ciWorkflow, 'unit');
    expect(ciWorkflow.split(localReleaseSetupAction)).toHaveLength(2);
    expect(unit).toContain(localReleaseSetupAction);
    expect(unit.indexOf(centralSetupAction)).toBeLessThan(unit.indexOf(localReleaseSetupAction));
    expect(unit.indexOf('Record release setup inputs')).toBeLessThan(
      unit.indexOf(localReleaseSetupAction)
    );
    expect(unit.indexOf(localReleaseSetupAction)).toBeLessThan(
      unit.indexOf('Verify release setup')
    );
    expect(unit).toContain('sha256sum --check "$RUNNER_TEMP/release-setup-inputs.sha256"');
    expect(unit).toContain('test "$(node --version)" = "v$expected_node"');
    expect(unit).toContain('test "$(pnpm --version)" = "$expected_pnpm"');
  });

  it('uses a locally reviewable setup action for every dependency-backed release job', () => {
    const expectedJobs = [
      ['Release quality', 'quality'],
      ['Release unit', 'unit'],
      ['Release E2E', 'e2e'],
      ['Release build', 'build'],
    ] as const;

    expect(existsSync(releaseSetupActionPath)).toBe(true);
    const resolveStep = releaseSetupAction.indexOf(
      'run: node "$GITHUB_ACTION_PATH/resolve-runtime.mjs"'
    );
    const node = releaseSetupAction.indexOf(
      'uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0'
    );
    const pnpm = releaseSetupAction.indexOf(
      'uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0'
    );
    const install = releaseSetupAction.indexOf('run: pnpm install --frozen-lockfile --no-runtime');
    expect(resolveStep).toBeGreaterThan(-1);
    expect(node).toBeGreaterThan(resolveStep);
    expect(pnpm).toBeGreaterThan(node);
    expect(install).toBeGreaterThan(pnpm);
    expect(releaseSetupAction).toContain('node-version: ${{ steps.runtime.outputs.version }}');
    expect(releaseSetupAction).toContain('package-manager-cache: false');
    expect(releaseSetupAction).toContain('package_json_file: package.json');
    expect(releaseSetupAction).toContain('\n        cache: false\n');
    expect(releaseSetupAction).toContain('run_install: false');
    expect(releaseSetupAction).toContain('standalone: false');
    expect(releaseSetupAction).not.toContain('uses: pnpm/setup@');

    for (const [label, jobId] of expectedJobs) {
      const job = jobBlock(releaseWorkflow, jobId);
      expect(job, label).toContain(localReleaseSetupAction);
      expect(job, label).not.toContain(centralSetupAction);
      expect(job, label).toContain('node-version: ${{ needs.provenance.outputs.node-version }}');
    }

    expect(releaseWorkflow.split(localReleaseSetupAction)).toHaveLength(expectedJobs.length + 1);
    const provenance = jobBlock(releaseWorkflow, 'provenance');
    expect(provenance).toContain(centralSetupAction);
    expect(provenance).toContain("install-dependencies: 'false'");
    expect(releaseWorkflow.replace(provenance, '')).not.toContain(centralSetupAction);
  });

  it('keeps direct toolchain setup and frozen installs out of project workflows', () => {
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      expect(workflow).not.toContain('uses: ./.github/actions/setup-toolchain');
      expect(workflow).not.toContain('uses: ./.github/actions/setup-project');
      expect(workflow).not.toContain('run: pnpm install --frozen-lockfile');
    }
    const releaseValidation = releaseWorkflow.replace(jobBlock(releaseWorkflow, 'publish'), '');
    for (const workflow of [ciWorkflow, releaseValidation]) {
      expect(workflow).not.toContain('uses: pnpm/action-setup@');
      expect(workflow).not.toContain('uses: actions/setup-node@');
    }
    expect(releaseWorkflow).not.toContain('uses: pnpm/setup@');
  });

  it('selects the protected checkout for the direct publication runtime setup', () => {
    const publish = jobBlock(releaseWorkflow, 'publish');
    const checkoutMarker = '      - name: 📥 Checkout protected publication guard\n';
    const checkout = publish.split(checkoutMarker)[1]?.split('\n      - name:')[0];
    const setupMarker = '      - name: 📦 Setup verified Node.js runtime\n';
    const setup = publish.split(setupMarker)[1]?.split('\n      - name:')[0];
    const pnpmMarker = '      - name: 📦 Install protected-source pnpm\n';
    const pnpmSetup = publish.split(pnpmMarker)[1]?.split('\n      - name:')[0];

    expect(setup).toBeDefined();
    expect(pnpmSetup).toBeDefined();
    expect(setup).toContain(
      'uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0'
    );
    expect(checkout).toContain('ref: ${{ github.sha }}');
    expect(checkout).toContain('persist-credentials: false');
    expect(checkout).not.toContain('release-sha');
    expect(publish.indexOf(checkoutMarker)).toBeLessThan(publish.indexOf(setupMarker));
    expect(setup).toContain('node-version: "${{ needs.provenance.outputs.node-version }}"');
    expect(setup).toContain('package-manager-cache: false');
    expect(setup).not.toContain('node-version-file:');
    expect(pnpmSetup).toContain(
      'uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0'
    );
    expect(pnpmSetup).toContain('package_json_file: package.json');
    expect(pnpmSetup).toContain('\n          cache: false\n');
    expect(pnpmSetup).toContain('run_install: false');
    expect(pnpmSetup).toContain('standalone: false');
    expect(pnpmSetup).not.toMatch(/^\s+version:/mu);
    expect(publish.indexOf(setupMarker)).toBeLessThan(publish.indexOf(pnpmMarker));
    expect(publish.indexOf(pnpmMarker)).toBeLessThan(
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
