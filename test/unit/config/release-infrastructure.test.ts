import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
    expect(workflow).toContain('bash "$classifier"');
    expect(workflow).toContain("needs.changes.outputs.security_tools == 'true'");
    expect(workflow).toContain("needs.changes.outputs.dependency == 'true'");
    expect(workflow).toContain("needs.changes.outputs.codeql == 'true'");
    expect(workflow).toContain("needs.changes.outputs.semgrep_full == 'true'");
    expect(workflow).toContain('Scan documentation for secrets');
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
      "const commit = process.env.RELEASE_SHA ?? process.env.GITHUB_SHA ?? 'unknown';"
    );
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
