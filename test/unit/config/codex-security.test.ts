import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const cliPackagePath = resolve(root, 'scripts/security/codex-security/package.json');
const cliLockPath = resolve(root, 'scripts/security/codex-security/package-lock.json');
const dependabot = readFileSync(resolve(root, '.github/dependabot.yaml'), 'utf8');
const workflow = readFileSync(resolve(root, '.github/workflows/codex-security.yaml'), 'utf8');
const securityWorkflow = readFileSync(resolve(root, '.github/workflows/security.yaml'), 'utf8');
const helper = readFileSync(resolve(root, 'scripts/security/codex-security.sh'), 'utf8');
const patcherPath = resolve(root, 'scripts/security/patch-codex-security.mjs');
const osvConfig = readFileSync(resolve(root, '.github/codex-security/osv-scanner.toml'), 'utf8');
const pinnedToolsCheck = readFileSync(resolve(root, 'scripts/ci/check-pinned-tools.sh'), 'utf8');

type CliPackage = {
  dependencies: Record<string, string>;
  overrides?: Record<string, unknown>;
};

type LockPackage = {
  integrity?: string;
  link?: boolean;
  version?: string;
  dependencies?: Record<string, string>;
};

type CliLock = {
  lockfileVersion: number;
  packages: Record<string, LockPackage>;
};

describe('Codex Security CLI supply-chain controls', () => {
  it('locks the exact CLI version and every installed registry package', () => {
    const cliPackage = JSON.parse(readFileSync(cliPackagePath, 'utf8')) as CliPackage;
    const cliLock = JSON.parse(readFileSync(cliLockPath, 'utf8')) as CliLock;
    const declaredVersion = cliPackage.dependencies['@openai/codex-security'];

    expect(declaredVersion).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    expect(cliLock.lockfileVersion).toBe(3);
    expect(cliLock.packages['']?.dependencies?.['@openai/codex-security']).toBe(
      declaredVersion
    );
    expect(cliLock.packages['node_modules/@openai/codex-security']?.version).toBe(
      declaredVersion
    );

    for (const [packagePath, metadata] of Object.entries(cliLock.packages)) {
      if (packagePath === '' || metadata.link) continue;
      expect(metadata.integrity, `${packagePath} is missing an integrity digest`).toMatch(
        /^sha512-/
      );
    }
  });

  it('keeps the CLI closure under daily Dependabot monitoring', () => {
    expect(dependabot).toMatch(
      new RegExp(
        'package-ecosystem: "npm"\\n\\s+' +
          'directory: "/scripts/security/codex-security"[\\s\\S]*?' +
          'interval: "daily"'
      )
    );
    expect(dependabot).not.toContain('directory: "/.github/codex-security"');
    expect(dependabot).toContain('prefix: "chore(deps-security)"');
  });

  it('keeps policy inputs under .github while package consumers use the supported path', () => {
    expect(existsSync(resolve(root, '.github/codex-security/scan.md'))).toBe(true);
    expect(existsSync(resolve(root, '.github/codex-security/threat-model.md'))).toBe(true);
    expect(existsSync(resolve(root, '.github/codex-security/osv-scanner.toml'))).toBe(true);
    expect(existsSync(resolve(root, '.github/codex-security/package.json'))).toBe(false);
    expect(existsSync(resolve(root, '.github/codex-security/package-lock.json'))).toBe(false);
    expect(workflow).toContain('.github/codex-security/scan.md');
    expect(workflow).toContain('.github/codex-security/threat-model.md');
    expect(workflow).toContain('- ".github/codex-security/**"');
    expect(workflow).toContain('- "scripts/**"');
    expect(helper).toContain('.github/codex-security/scan.md');

    for (const consumer of [workflow, helper, pinnedToolsCheck]) {
      expect(consumer).toContain('scripts/security/codex-security/package.json');
      expect(consumer).toContain('scripts/security/codex-security/package-lock.json');
      expect(consumer).not.toContain('.github/codex-security/package.json');
      expect(consumer).not.toContain('.github/codex-security/package-lock.json');
    }
  });

  it('uses the upstream PDF parser fix without a local compatibility patch', () => {
    const cliPackage = JSON.parse(readFileSync(cliPackagePath, 'utf8')) as CliPackage;
    const cliLock = JSON.parse(readFileSync(cliLockPath, 'utf8')) as CliLock;

    expect(cliPackage.overrides).not.toHaveProperty('pdfjs-dist');
    expect(cliLock.packages['node_modules/pdfjs-dist']?.version).toBe('6.2.108');
    expect(workflow).not.toContain('patch-codex-security.mjs');
    expect(helper).not.toContain('patch-codex-security.mjs');
    expect(existsSync(patcherPath)).toBe(false);
  });

  it('forces the patched fast-uri closure while the upstream CLI pins a vulnerable release', () => {
    const cliPackage = JSON.parse(readFileSync(cliPackagePath, 'utf8')) as CliPackage;
    const cliLock = JSON.parse(readFileSync(cliLockPath, 'utf8')) as CliLock;
    const fastUriPackages = Object.entries(cliLock.packages).filter(
      ([packagePath]) =>
        packagePath === 'node_modules/fast-uri' ||
        packagePath.endsWith('/node_modules/fast-uri')
    );

    expect(cliPackage.overrides).toMatchObject({ 'fast-uri': '3.1.6' });
    expect(fastUriPackages.length).toBeGreaterThan(0);
    for (const [packagePath, metadata] of fastUriPackages) {
      expect(metadata.version, `${packagePath} must use the patched release`).toBe('3.1.6');
    }
  });

  it('scopes the unpatched extract-zip advisory exception to the CLI lock', () => {
    expect(osvConfig).toContain('id = "GHSA-jmr9-qjv8-65gv"');
    expect(osvConfig).toContain('ignoreUntil = 2026-09-13');
    expect(osvConfig).toContain('rejects all symlink ZIP entries before extraction');

    const recursiveScanCount = securityWorkflow.match(/\s-r \\\n/g)?.length ?? 0;
    const configuredScanCount =
      securityWorkflow.match(/--config=\/results\/osv-scanner\.toml/g)?.length ?? 0;
    expect(recursiveScanCount).toBeGreaterThan(0);
    expect(configuredScanCount).toBe(recursiveScanCount);
    expect(securityWorkflow).not.toContain(
      '--config=/src/.github/codex-security/osv-scanner.toml'
    );
  });

  it('uses one policy materialized from the checked-out PR base for both diff scans', () => {
    const prJob = securityWorkflow.slice(
      securityWorkflow.indexOf('  osv-scan-pr:'),
      securityWorkflow.indexOf('  osv-scan-dispatch:')
    );
    const baseCheckout = prJob.indexOf('name: ⏪ Checkout the PR base');
    const policyMaterialization = prJob.indexOf(
      'name: 📁 Materialize trusted OSV policy from PR base'
    );
    const baseScan = prJob.indexOf('name: 🛡️ Scan dependencies before the PR');
    const headCheckout = prJob.indexOf('name: ⏩ Checkout the PR result');
    const headScan = prJob.indexOf('name: 🛡️ Scan dependencies after the PR');

    expect(prJob).toContain('fetch-depth: 0');
    expect(baseCheckout).toBeGreaterThan(-1);
    expect(policyMaterialization).toBeGreaterThan(baseCheckout);
    expect(baseScan).toBeGreaterThan(policyMaterialization);
    expect(headCheckout).toBeGreaterThan(baseScan);
    expect(headScan).toBeGreaterThan(headCheckout);
    expect(prJob).toContain('[[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(prJob).toContain('[[ "$(git rev-parse HEAD)" == "$BASE_SHA" ]]');
    expect(prJob).toMatch(
      /install -m 0600 \.github\/codex-security\/osv-scanner\.toml \\\n\s+"\$RUNNER_TEMP\/osv-results\/osv-scanner\.toml"/
    );
    expect(prJob.match(/--config=\/results\/osv-scanner\.toml/g)).toHaveLength(2);
  });

  it('materializes merge-group policy from its validated trusted base', () => {
    const dispatchJob = securityWorkflow.slice(
      securityWorkflow.indexOf('  osv-scan-dispatch:'),
      securityWorkflow.indexOf('\n  codeql:\n')
    );
    const checkout = dispatchJob.indexOf('name: 📥 Checkout code');
    const policyMaterialization = dispatchJob.indexOf(
      'name: 📁 Materialize trusted OSV policy'
    );
    const scan = dispatchJob.indexOf('name: 🛡️ Run OSV scan');

    expect(dispatchJob).toContain('fetch-depth: 0');
    expect(checkout).toBeGreaterThan(-1);
    expect(policyMaterialization).toBeGreaterThan(checkout);
    expect(scan).toBeGreaterThan(policyMaterialization);
    expect(dispatchJob).toContain(
      'TRUSTED_BASE_SHA: ${{ github.event.merge_group.base_sha }}'
    );
    expect(dispatchJob).toContain(
      'EXPECTED_HEAD_SHA: ${{ github.event.merge_group.head_sha || github.sha }}'
    );
    expect(dispatchJob).toContain('[[ "$TRUSTED_BASE_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(dispatchJob).toContain('[[ "$(git rev-parse HEAD)" == "$EXPECTED_HEAD_SHA" ]]');
    expect(dispatchJob).toContain(
      'git merge-base --is-ancestor "$TRUSTED_BASE_SHA" "$EXPECTED_HEAD_SHA"'
    );
    expect(dispatchJob).toMatch(
      /git show "\$TRUSTED_BASE_SHA:\.github\/codex-security\/osv-scanner\.toml" > \\\n\s+"\$RUNNER_TEMP\/osv-results\/osv-scanner\.toml"/
    );
    expect(dispatchJob).toMatch(
      /install -m 0600 \.github\/codex-security\/osv-scanner\.toml \\\n\s+"\$RUNNER_TEMP\/osv-results\/osv-scanner\.toml"/
    );
    expect(dispatchJob.match(/--config=\/results\/osv-scanner\.toml/g)).toHaveLength(1);
  });

  it('installs the trusted base lock before checking out pull-request source', () => {
    const trustedCheckout = workflow.indexOf('name: Check out trusted CLI lock');
    const lockedInstall = workflow.indexOf('name: Install locked Codex Security');
    const sourceCheckout = workflow.indexOf('name: Check out exact source revision');

    expect(trustedCheckout).toBeGreaterThan(-1);
    expect(lockedInstall).toBeGreaterThan(trustedCheckout);
    expect(sourceCheckout).toBeGreaterThan(lockedInstall);
    expect(workflow).toContain(
      "ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.sha }}"
    );
    expect(workflow).toContain('npm ci \\\n');
    expect(workflow).toContain('scripts/security/codex-security/package-lock.json');
    expect(workflow).not.toMatch(/\bnpm install\b/);
  });

  it('keys the local cache by the complete install recipe and uses the frozen install', () => {
    expect(helper).toContain('scripts/security/codex-security/package.json');
    expect(helper).toContain('scripts/security/codex-security/package-lock.json');
    expect(helper).toContain('install_digest=');
    expect(helper).toContain('cli-$cli_version-$install_digest');
    expect(helper).toContain('.install-recipe.sha256');
    expect(helper).toContain('npm ci \\\n');
    expect(helper).not.toMatch(/\bnpm install\b/);
    expect(helper).not.toContain('--package-lock=false');
  });

  it('rejects Node.js release lines outside the package engine contract', () => {
    expect(helper).toContain('case "$node_major" in');
    expect(helper).toContain('22)');
    expect(helper).toContain('24 | 26)');
    expect(helper).toContain('if ((node_minor < 13))');
  });

  it('checks release maturity from the locked CLI manifest', () => {
    expect(pinnedToolsCheck).toContain('scripts/security/codex-security/package.json');
    expect(pinnedToolsCheck).toContain('scripts/security/codex-security/package-lock.json');
    expect(pinnedToolsCheck).toContain(
      'check_npm_mature_release codex-security @openai/codex-security'
    );
  });
});
