import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

function jobBlock(workflow: string, jobId: string): string {
  const marker = `  ${jobId}:\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`Workflow job not found: ${jobId}`);

  const afterMarker = start + marker.length;
  const nextJob = workflow.slice(afterMarker).search(/\n  [a-z][a-z0-9-]*:\n/);
  return workflow.slice(start, nextJob === -1 ? undefined : afterMarker + nextJob);
}

function runSecuritySummary(event: string, results: Record<string, string> = {}) {
  const workflow = readFileSync(resolve(root, '.github/workflows/security.yaml'), 'utf8');
  const script = jobBlock(workflow, 'security-summary').split('        run: |\n')[1];
  if (!script) throw new Error('Security summary script not found');

  return spawnSync('bash', ['-c', script.replace(/^ {10}/gm, '')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_STEP_SUMMARY: '/dev/null',
      EVENT_NAME: event,
      PINNED_TOOLS_RESULT: ['push', 'schedule', 'workflow_dispatch'].includes(event)
        ? 'success'
        : 'skipped',
      OSV_PR_RESULT: event === 'pull_request' ? 'success' : 'skipped',
      OSV_FULL_RESULT: event === 'pull_request' ? 'skipped' : 'success',
      CODEQL_RESULT: 'success',
      SEMGREP_RESULT: 'success',
      CODEQL_REQUIRED: 'true',
      PINNED_TOOLS_REQUIRED: 'true',
      ...results,
    },
  });
}

describe('Release infrastructure', () => {
  it('keeps the Cloudflare Pages build runtime aligned with Volta', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8')
    ) as { volta?: { node?: string } };
    const nodeVersion = readFileSync(resolve(root, '.node-version'), 'utf8').trim();
    const wrangler = readFileSync(resolve(root, 'wrangler.toml'), 'utf8');

    expect(nodeVersion).toBe(packageJson.volta?.node);
    expect(wrangler).not.toMatch(/^NODE_VERSION\s*=/m);
  });

  it('preserves security gates while routing expensive scans by changed path', () => {
    const workflow = readFileSync(
      resolve(root, '.github/workflows/security.yaml'),
      'utf8'
    );

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
    expect(workflow).toContain(
      'expect_when_required "$CODEQL_REQUIRED" "CodeQL" "$CODEQL_RESULT"'
    );
    expect(workflow).toContain('expect_success "Semgrep" "$SEMGREP_RESULT"');
    expect(workflow).toContain('expect_success "OSV full" "$OSV_FULL_RESULT"');
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
    expect(runSecuritySummary('push', {
      CODEQL_REQUIRED: 'false',
      CODEQL_RESULT: 'skipped',
      PINNED_TOOLS_REQUIRED: 'false',
      PINNED_TOOLS_RESULT: 'skipped',
    }).status).toBe(0);
    expect(runSecuritySummary('push', {
      CODEQL_REQUIRED: 'false',
      CODEQL_RESULT: 'failure',
    }).status).toBe(1);
    expect(runSecuritySummary('push', {
      PINNED_TOOLS_REQUIRED: 'false',
      PINNED_TOOLS_RESULT: 'failure',
    }).status).toBe(1);
    expect(runSecuritySummary('unknown').status).toBe(1);
  });

  it('publishes a checksum-verifiable archive without flattening the app tree', () => {
    const workflow = readFileSync(
      resolve(root, '.github/workflows/release.yaml'),
      'utf8'
    );
    const prepareScript = readFileSync(
      resolve(root, 'scripts/release/prepare.ts'),
      'utf8'
    );

    expect(workflow).toContain('release-bundle/release/*');
    expect(workflow).not.toContain('release-bundle/release/**');
    expect(prepareScript).toContain(
      'const archiveName = `wasm-motion-converter-${version}.tar.gz`;'
    );
    expect(prepareScript).toContain(
      'const releaseAssets = [archivePath, metadataPath];'
    );
    expect(prepareScript).not.toContain('cpSync(distDir, releaseDir');
  });

  it('puts the verified version and source in both the deployed tree and archive', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'release-bundle-'));
    const source = 'a'.repeat(40);
    try {
      mkdirSync(join(fixture, 'scripts/release'), { recursive: true });
      mkdirSync(join(fixture, 'dist'), { recursive: true });
      cpSync(resolve(root, 'scripts/release/prepare.ts'), join(fixture, 'scripts/release/prepare.ts'));
      writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module', version: '0.2.10' }));
      writeFileSync(join(fixture, 'CHANGELOG.md'), '## [0.2.10]\n\nRelease ordering.\n');
      writeFileSync(join(fixture, 'dist/index.html'), '<html></html>');
      execFileSync(process.execPath, ['--experimental-strip-types', join(fixture, 'scripts/release/prepare.ts')], {
        cwd: fixture,
        env: { ...process.env, RELEASE_VERSION: '0.2.10', RELEASE_SHA: source },
      });
      const marker = { version: '0.2.10', commit: source };
      expect(JSON.parse(readFileSync(join(fixture, 'release-bundle/dist/release-state.json'), 'utf8'))).toEqual(marker);
      expect(JSON.parse(readFileSync(join(fixture, 'release-bundle/release/metadata.json'), 'utf8'))).toMatchObject(marker);
      const archived = execFileSync('tar', ['-xOzf', join(fixture, 'release-bundle/release/wasm-motion-converter-0.2.10.tar.gz'), './release-state.json'], { encoding: 'utf8' });
      expect(JSON.parse(archived)).toEqual(marker);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('binds every release gate and publication step to a protected-master tag SHA', () => {
    const workflow = readFileSync(
      resolve(root, '.github/workflows/release.yaml'),
      'utf8'
    );
    const prepareScript = readFileSync(
      resolve(root, 'scripts/release/prepare.ts'),
      'utf8'
    );
    const provenance = jobBlock(workflow, 'provenance');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/\n  push:\n\s+tags:/);
    expect(provenance).toContain("if: ${{ github.ref == 'refs/heads/master' }}");
    expect(provenance).toContain('ref: ${{ github.sha }}');
    expect(provenance).toContain('fetch-depth: 0');
    expect(provenance).toContain('fetch-tags: true');
    expect(provenance).toContain('persist-credentials: false');
    expect(provenance).toContain('RELEASE_TAG: ${{ inputs.tag }}');
    expect(provenance).toContain('git fetch --force origin');
    expect(provenance).toContain('git rev-parse --verify "${RELEASE_TAG}^{commit}"');
    expect(provenance).toContain('git merge-base --is-ancestor "$release_sha" "$GITHUB_SHA"');

    const localExecutionMarker = {
      quality: 'uses: ./.github/actions/setup-release',
      unit: 'uses: ./.github/actions/setup-release',
      e2e: 'uses: ./.github/actions/setup-release',
      duplication: 'run: bash scripts/ci/install-nose.sh',
      mutation: 'uses: ./.github/actions/setup-release',
      build: 'uses: ./.github/actions/setup-release',
    } as const;
    for (const [jobId, marker] of Object.entries(localExecutionMarker)) {
      const job = jobBlock(workflow, jobId);
      expect(job, jobId).toMatch(/needs: (?:provenance|\[provenance, quality\])/);
      expect(job, jobId).toContain('ref: ${{ github.sha }}');
      expect(job, jobId).toContain('fetch-depth: 0');
      expect(job, jobId).toContain('fetch-tags: true');
      expect(job, jobId).toContain('persist-credentials: false');
      expect(job, jobId).toContain('RELEASE_SHA: ${{ needs.provenance.outputs.release-sha }}');
      expect(job, jobId).toContain('git -c advice.detachedHead=false checkout --detach "$RELEASE_SHA"');
      expect(job.indexOf('Checkout verified release commit'), jobId).toBeLessThan(
        job.indexOf(marker)
      );
    }

    const build = jobBlock(workflow, 'build');
    const publish = jobBlock(workflow, 'publish');
    expect(build).toContain('RELEASE_VERSION: ${{ needs.provenance.outputs.version }}');
    expect(build).toContain('RELEASE_SHA: ${{ needs.provenance.outputs.release-sha }}');
    expect(build).toContain('name: release-bundle-${{ needs.provenance.outputs.release-sha }}');
    expect(publish).toContain('needs: [provenance, quality, unit, e2e, duplication, mutation, build]');
    expect(publish).toContain('name: release-bundle-${{ needs.provenance.outputs.release-sha }}');
    expect(publish).toContain('tag_name: ${{ inputs.tag }}');
    expect(prepareScript).toContain(
      'const commit = process.env.RELEASE_SHA;'
    );
  });

  it('serializes only publication and checks live state before either writer', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/release.yaml'), 'utf8');
    const publish = jobBlock(workflow, 'publish');
    expect(workflow.slice(0, workflow.indexOf('jobs:'))).not.toContain('concurrency:');
    expect(publish).toContain('group: release-publication-${{ github.repository }}');
    expect(publish).toContain('cancel-in-progress: false');
    expect(publish.indexOf('Check live publication order')).toBeLessThan(
      publish.indexOf('Publish to release branch')
    );
    expect(publish.indexOf('Check live publication order')).toBeLessThan(
      publish.indexOf('Create GitHub Release')
    );
    expect(publish).toContain("if: ${{ steps.publication.outputs.publish-branch == 'true' }}");
    expect(publish).toContain("if: ${{ steps.publication.outputs.create-release == 'true' }}");
    expect(publish).toContain('make_latest: true');
    expect(publish).toContain('overwrite_files: false');
  });

  it('runs release E2E against its development server without a redundant build', () => {
    const workflow = readFileSync(
      resolve(root, '.github/workflows/release.yaml'),
      'utf8'
    );
    const e2eJob = workflow.match(/\n  e2e:[\s\S]*?\n  duplication:/)?.[0] ?? '';

    expect(e2eJob).toContain('pnpm test:e2e:ci');
    expect(e2eJob).not.toContain('pnpm build:ci');
  });
});
