import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

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
    expect(workflow).toContain('bash scripts/ci/classify-workflow-changes.sh');
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
