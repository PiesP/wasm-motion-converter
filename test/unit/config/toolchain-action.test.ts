import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const ciWorkflow = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
const deepChecksWorkflow = readFileSync(resolve(root, '.github/workflows/deep-checks.yaml'), 'utf8');
const releaseWorkflow = readFileSync(resolve(root, '.github/workflows/release.yaml'), 'utf8');
const centralSetupAction =
  'uses: PiesP/browser-core/automation/actions/setup-project@f630a8f0119dd6b4f1aa011f8510489936c7a7b9';

function jobBlock(workflow: string, jobId: string): string {
  const marker = `  ${jobId}:\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`Workflow job not found: ${jobId}`);

  const afterMarker = start + marker.length;
  const nextJob = workflow.slice(afterMarker).search(/\n  [a-z][a-z0-9-]*:\n/);
  return workflow.slice(start, nextJob === -1 ? undefined : afterMarker + nextJob);
}

describe('central project setup action', () => {
  it('pins the shared action independently from the runtime gitlink', () => {
    expect(centralSetupAction).toMatch(/@[0-9a-f]{40}$/);
    expect(existsSync(resolve(root, '.github/actions/setup-project/action.yaml'))).toBe(false);
    expect(existsSync(resolve(root, '.github/actions/setup-toolchain/action.yaml'))).toBe(false);
  });

  it('configures every expected project job through the central action', () => {
    const expectedJobs = [
      ['CI quality', ciWorkflow, 'quality'],
      ['CI unit', ciWorkflow, 'unit'],
      ['CI E2E', ciWorkflow, 'e2e'],
      ['CI build', ciWorkflow, 'build'],
      ['Deep mutation', deepChecksWorkflow, 'mutation'],
      ['Release quality', releaseWorkflow, 'quality'],
      ['Release unit', releaseWorkflow, 'unit'],
      ['Release E2E', releaseWorkflow, 'e2e'],
      ['Release mutation', releaseWorkflow, 'mutation'],
      ['Release build', releaseWorkflow, 'build'],
    ] as const;

    for (const [label, workflow, jobId] of expectedJobs) {
      const job = jobBlock(workflow, jobId);
      expect(job, label).toContain(centralSetupAction);
      expect(job, label).toContain('node-version: ${{ env.NODE_VERSION }}');
    }
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
});
