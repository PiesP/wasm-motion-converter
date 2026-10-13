import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const metadata = JSON.parse(readFileSync(resolve(root, 'scripts/ci/pinned-tools.json'), 'utf8')) as {
  osv: { version: string; image: string };
  semgrep: { version: string; image: string };
};
const security = readFileSync(resolve(root, '.github/workflows/security.yaml'), 'utf8');
const publishedSha = 'e474c313673dbdb717156b8df3b0febf1b89f19a';

describe('scanner pin workflow contracts', () => {
  it('keeps both scanner image versions and digests validated before use', () => {
    expect(metadata.osv.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(metadata.osv.image).toMatch(/^ghcr\.io\/google\/osv-scanner-action@sha256:[0-9a-f]{64}$/u);
    expect(metadata.semgrep.image).toMatch(
      new RegExp(`^semgrep/semgrep:${metadata.semgrep.version.replaceAll('.', '\\.')}@sha256:[0-9a-f]{64}$`, 'u')
    );
    const checker = readFileSync(resolve(root, 'scripts/ci/check-pinned-tools.ts'), 'utf8');
    expect(checker).toContain('checkOsvDigest(pins.osv.version, pins.osv.image)');
    expect(checker).toContain("checkRelease('semgrep', pins.semgrep.version");
  });

  it('loads security metadata from the reviewed immutable revision', () => {
    for (const [job, helper] of [
      ['pin-metadata', 'pinned-tools.ts'],
      ['pinned-tools', 'check-pinned-tools.ts'],
    ] as const) {
      const match = security.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z][a-z-]*:\n/u)[0] ?? '';
      expect(match).toContain(`ref: ${publishedSha}`);
      expect(match).toContain("install-dependencies: 'false'");
      expect(match).toContain('pinned_dir="$(mktemp -d "$RUNNER_TEMP/pinned-tools.XXXXXXXX")"');
      expect(match).toContain('for name in pinned-tools.json pinned-tools.ts check-pinned-tools.ts; do');
      expect(match).not.toContain('install-nose.ts');
      expect(match).toContain('install -m 0600 "scripts/ci/$name" "$pinned_dir/$name"');
      expect(match).toContain(`"$pinned_dir/${helper}"`);
    }
    expect(security).toContain("needs['pin-metadata'].outputs.OSV_SCANNER_IMAGE");
    expect(security).toContain("needs['pin-metadata'].outputs.SEMGREP_IMAGE");
  });

  it('exports validated image refs without external commands', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'scanner pins '));
    try {
      const result = spawnSync(process.execPath, ['--experimental-strip-types', resolve(root, 'scripts/ci/pinned-tools.ts'), 'env'], {
        cwd: root,
        env: { ...process.env, GITHUB_ENV: join(outputDir, 'output') },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(outputDir, 'output'), 'utf8')).toBe(
        `OSV_SCANNER_IMAGE=${metadata.osv.image}\nSEMGREP_IMAGE=${metadata.semgrep.image}\n`
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
