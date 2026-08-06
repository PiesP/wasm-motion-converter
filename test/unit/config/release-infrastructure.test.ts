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

  it('requires complete security scans after changes land on master', () => {
    const workflow = readFileSync(
      resolve(root, '.github/workflows/security.yaml'),
      'utf8'
    );

    expect(workflow).toContain(
      "github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'"
    );
    expect(workflow).toContain(
      "github.event_name == 'push' || github.event_name == 'workflow_dispatch' || github.event_name == 'merge_group' || github.event_name == 'schedule'"
    );
    expect(workflow).toContain(
      "github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || github.event_name == 'pull_request' || github.event_name == 'merge_group'"
    );
    expect(workflow).toContain('security-summary:');
    expect(workflow).toContain('expect_success "CodeQL" "$CODEQL_RESULT"');
    expect(workflow).toContain('expect_success "Semgrep" "$SEMGREP_RESULT"');
    expect(workflow).toContain('expect_success "OSV full" "$OSV_FULL_RESULT"');
  });
});
