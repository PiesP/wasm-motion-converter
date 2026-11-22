// GitHub Actions expressions are literal workflow assertions.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');

function jobBlock(workflow: string, jobId: string): string {
  const marker = `  ${jobId}:\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`Workflow job not found: ${jobId}`);

  const afterMarker = start + marker.length;
  const nextJob = workflow.slice(afterMarker).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return workflow.slice(start, nextJob === -1 ? undefined : afterMarker + nextJob);
}

function runWorkflowDecision(file: string, job: string, env: Record<string, string>) {
  const workflow = readFileSync(resolve(root, `.github/workflows/${file}`), 'utf8');
  const script = jobBlock(workflow, job).split('        run: |\n')[1];
  if (!script) throw new Error(`${job} decision script not found`);
  return spawnSync('bash', ['-c', script.replace(/^ {10}/gm, '')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_STEP_SUMMARY: '/dev/null',
      ...env,
    },
  });
}

function runCiSummary(event: string, results: Record<string, string> = {}) {
  return runWorkflowDecision('ci.yaml', 'ci-summary', {
    EVENT_NAME: event,
    CHANGES_RESULT: 'success',
    QUALITY_SELECTED: 'true',
    UNIT_SELECTED: 'true',
    E2E_SELECTED: 'true',
    BUILD_SELECTED: 'true',
    QUALITY_RESULT: 'success',
    UNIT_RESULT: 'success',
    E2E_RESULT: 'success',
    BUILD_RESULT: 'success',
    ...results,
  });
}

function runSecuritySummary(event: string, results: Record<string, string> = {}) {
  const pins = JSON.parse(readFileSync(resolve(root, 'scripts/ci/pinned-tools.json'), 'utf8')) as {
    osv: { image: string };
    semgrep: { image: string };
  };
  return runWorkflowDecision('security.yaml', 'security-summary', {
    EVENT_NAME: event,
    CHANGES_RESULT: 'success',
    PIN_METADATA_RESULT: 'success',
    OSV_SCANNER_IMAGE: pins.osv.image,
    SEMGREP_IMAGE: pins.semgrep.image,
    PINNED_TOOLS_RESULT: ['push', 'schedule', 'workflow_dispatch'].includes(event)
      ? 'success'
      : 'skipped',
    OSV_PR_RESULT: event === 'pull_request' ? 'success' : 'skipped',
    OSV_FULL_RESULT: event === 'pull_request' ? 'skipped' : 'success',
    CODEQL_RESULT: 'success',
    SEMGREP_RESULT: 'success',
    CODEQL_REQUIRED: 'true',
    PINNED_TOOLS_REQUIRED: 'true',
    DEPENDENCY_REQUIRED: 'true',
    SEMGREP_REQUIRED: 'true',
    SEMGREP_FULL_REQUIRED: 'true',
    ...results,
  });
}

describe('CI and Pages infrastructure', () => {
  it('keeps the Cloudflare Pages toolchain aligned with repository pins', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      packageManager: string;
    };
    const nodeVersion = readFileSync(resolve(root, '.node-version'), 'utf8').trim();
    const wrangler = readFileSync(resolve(root, 'wrangler.toml'), 'utf8');

    expect(nodeVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(wrangler.match(/^PNPM_VERSION\s*=\s*"([^"]+)"/m)?.[1]).toBe(
      packageJson.packageManager.replace(/^pnpm@/, '')
    );
    expect(wrangler).not.toMatch(/^NODE_VERSION\s*=/m);
  });

  it('preserves security gates while routing expensive scans by changed path', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/security.yaml'), 'utf8');

    expect(workflow).toContain('name: Classify security changes');
    expect(workflow).toContain('node --experimental-strip-types "$classifier"');
    expect(workflow).toContain("needs.changes.outputs.security_tools == 'true'");
    expect(workflow).toContain("needs.changes.outputs.dependency == 'true'");
    expect(workflow).toContain("needs.changes.outputs.codeql == 'true'");
    expect(workflow).toContain("needs.changes.outputs.semgrep_full == 'true'");
    expect(workflow).toContain('Run Semgrep secrets scan on routine events');
    expect(workflow).toContain(
      "github.event_name == 'push' || github.event_name == 'workflow_dispatch' || github.event_name == 'merge_group' || github.event_name == 'schedule'"
    );
    expect(workflow).toContain(
      "github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || github.event_name == 'pull_request' || github.event_name == 'merge_group'"
    );
    expect(workflow).toContain('security-summary:');
    expect(workflow).toContain('expect_when_required "$CODEQL_REQUIRED" "CodeQL" "$CODEQL_RESULT"');
    expect(workflow).toContain('expect_success "Semgrep" "$SEMGREP_RESULT"');
    expect(workflow).toContain('expect_success "OSV full" "$OSV_FULL_RESULT"');
  });

  it('rejects incomplete CI routing and skipped or failed dependent jobs', () => {
    expect(runCiSummary('pull_request').status).toBe(0);
    for (const changes of ['failure', 'cancelled', 'skipped', '']) {
      expect(runCiSummary('pull_request', { CHANGES_RESULT: changes }).status, changes).toBe(1);
    }
    for (const selected of [
      'QUALITY_SELECTED',
      'UNIT_SELECTED',
      'E2E_SELECTED',
      'BUILD_SELECTED',
    ]) {
      for (const invalid of ['', 'unknown', 'TRUE']) {
        expect(runCiSummary('pull_request', { [selected]: invalid }).status, selected).toBe(1);
      }
    }
    for (const result of ['QUALITY_RESULT', 'UNIT_RESULT', 'E2E_RESULT', 'BUILD_RESULT']) {
      for (const outcome of ['', 'failure', 'cancelled', 'skipped']) {
        expect(runCiSummary('pull_request', { [result]: outcome }).status, result).toBe(1);
      }
    }
    expect(runCiSummary('unknown').status).toBe(1);
  });

  it('accepts explicit unaffected CI no-ops only after routing and jobs succeed', () => {
    const noOp = runCiSummary('pull_request', {
      QUALITY_SELECTED: 'false',
      UNIT_SELECTED: 'false',
      E2E_SELECTED: 'false',
      BUILD_SELECTED: 'false',
    });
    expect(noOp.status, noOp.stderr).toBe(0);
    expect(noOp.stdout).toContain('validation did not run');
    expect(
      runCiSummary('pull_request', { QUALITY_SELECTED: 'false', QUALITY_RESULT: 'skipped' }).status
    ).toBe(1);
  });

  it.each(['pull_request', 'merge_group', 'push', 'schedule', 'workflow_dispatch'])(
    'validates the actual scanner results for %s without manual status publishing',
    (event) => {
      const result = runSecuritySummary(event);
      expect(result.status, result.stderr).toBe(0);
      const required = [
        'CODEQL_RESULT',
        'SEMGREP_RESULT',
        event === 'pull_request' ? 'OSV_PR_RESULT' : 'OSV_FULL_RESULT',
      ];
      if (['push', 'schedule', 'workflow_dispatch'].includes(event)) {
        required.push('PINNED_TOOLS_RESULT');
      }
      for (const check of required) {
        for (const outcome of ['failure', 'cancelled', 'skipped']) {
          expect(runSecuritySummary(event, { [check]: outcome }).status, check).toBe(1);
        }
      }
    }
  );

  it('accepts only the routed CodeQL and freshness skips and rejects unknown events', () => {
    expect(
      runSecuritySummary('push', {
        CODEQL_REQUIRED: 'false',
        CODEQL_RESULT: 'skipped',
        PINNED_TOOLS_REQUIRED: 'false',
        PINNED_TOOLS_RESULT: 'skipped',
      }).status
    ).toBe(0);
    expect(
      runSecuritySummary('push', {
        CODEQL_REQUIRED: 'false',
        CODEQL_RESULT: 'failure',
      }).status
    ).toBe(1);
    expect(
      runSecuritySummary('push', {
        PINNED_TOOLS_REQUIRED: 'false',
        PINNED_TOOLS_RESULT: 'failure',
      }).status
    ).toBe(1);
    expect(runSecuritySummary('unknown').status).toBe(1);
  });

  it('rejects failed prerequisites, invalid security routing, and an unexpected OSV alternate', () => {
    for (const prerequisite of ['CHANGES_RESULT', 'PIN_METADATA_RESULT']) {
      for (const outcome of ['', 'failure', 'cancelled', 'skipped']) {
        expect(
          runSecuritySummary('pull_request', { [prerequisite]: outcome }).status,
          prerequisite
        ).toBe(1);
      }
    }
    for (const selected of [
      'CODEQL_REQUIRED',
      'PINNED_TOOLS_REQUIRED',
      'DEPENDENCY_REQUIRED',
      'SEMGREP_REQUIRED',
      'SEMGREP_FULL_REQUIRED',
    ]) {
      for (const invalid of ['', 'unknown']) {
        expect(runSecuritySummary('pull_request', { [selected]: invalid }).status, selected).toBe(
          1
        );
      }
    }
    expect(runSecuritySummary('pull_request', { OSV_FULL_RESULT: 'success' }).status).toBe(1);
    expect(runSecuritySummary('merge_group', { OSV_PR_RESULT: 'success' }).status).toBe(1);
    expect(
      runSecuritySummary('pull_request', { CODEQL_REQUIRED: 'false', CODEQL_RESULT: 'skipped' })
        .status
    ).toBe(0);
  });

  it.each(['pull_request', 'push'])(
    'requires digest-shaped scanner outputs even for a %s dependency no-op',
    (event) => {
      const noOp = {
        DEPENDENCY_REQUIRED: 'false',
        SEMGREP_REQUIRED: 'false',
      };
      expect(runSecuritySummary(event, noOp).status).toBe(0);
      for (const output of ['OSV_SCANNER_IMAGE', 'SEMGREP_IMAGE']) {
        for (const invalid of ['', 'unresolved', 'semgrep/semgrep:1.184.0@sha256:short']) {
          const result = runSecuritySummary(event, { ...noOp, [output]: invalid });
          expect(result.status, `${event} ${output}: ${invalid}`).toBe(1);
          expect(result.stderr).toContain('image output');
        }
      }
    }
  );

  it('makes the single public OSV context depend on the completed security decision', () => {
    expect(
      runWorkflowDecision('security.yaml', 'osv-required', { SECURITY_RESULT: 'success' }).status
    ).toBe(0);
    for (const outcome of ['', 'failure', 'cancelled', 'skipped']) {
      expect(
        runWorkflowDecision('security.yaml', 'osv-required', { SECURITY_RESULT: outcome }).status,
        outcome
      ).toBe(1);
    }
  });

  it('keeps tagged release publication out of repository workflows', () => {
    const workflows = resolve(root, '.github/workflows');
    for (const file of readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name))) {
      const workflow = readFileSync(resolve(workflows, file), 'utf8');
      expect(workflow, file).not.toMatch(/^ +uses: softprops\/action-gh-release@/m);
      expect(workflow, file).not.toMatch(/^ +publish_branch: ['"]?release['"]?\s*$/m);
      expect(workflow, file).not.toMatch(/\bgh release (?:create|upload)\b/);
    }
  });
});
