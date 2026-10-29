import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');
const metadataBytes = readFileSync(resolve(root, 'scripts/ci/pinned-tools.json'));
const metadata = JSON.parse(metadataBytes.toString('utf8')) as {
  osv: { version: string; image: string };
  semgrep: { version: string; image: string };
};
const security = readFileSync(resolve(root, '.github/workflows/security.yaml'), 'utf8');
const reviewedConsumerSha = 'e985fce5c0bce5ea9fb86b313afc6a6339af37a9';
const reviewedProviderSha = 'a85cc07e89fe0c0517b98aa5c15b9a83dcb82bcd';
const action = `uses: PiesP/browser-core/automation/actions/prepare-scanner-pins@${reviewedProviderSha}`;

function job(name: string): string {
  const start = security.search(new RegExp(`^  ${name}:$`, 'm'));
  if (start < 0) throw new Error(`Missing security job: ${name}`);
  const remaining = security.slice(start + name.length + 4);
  const end = remaining.search(/^ {2}[a-z][a-z-]*:/m);
  return security.slice(start, end < 0 ? undefined : start + name.length + 4 + end);
}

describe('scanner pin workflow contracts', () => {
  it('retains the consumer-owned scanner data byte-for-byte', () => {
    expect(createHash('sha256').update(metadataBytes).digest('hex')).toBe(
      'bedb4bb9a258425a93ad7b87294e9b0a304b1d708e5a46e820d59163aa566af3'
    );
    expect(metadata.osv.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(metadata.osv.image).toMatch(
      /^ghcr\.io\/google\/osv-scanner-action@sha256:[0-9a-f]{64}$/u
    );
    expect(metadata.semgrep.image).toMatch(
      new RegExp(
        `^semgrep/semgrep:${metadata.semgrep.version.replaceAll('.', '\\.')}@sha256:[0-9a-f]{64}$`,
        'u'
      )
    );
  });

  it('pins the reviewed provider and consumer in both execution paths', () => {
    for (const [name, mode] of [
      ['pin-metadata', 'env'],
      ['pinned-tools', 'check'],
    ] as const) {
      const body = job(name);
      const checkout = body.indexOf(`ref: ${reviewedConsumerSha}`);
      const runtime = body.indexOf("install-dependencies: 'false'");
      const helper = body.indexOf(action);
      const commandText =
        mode === 'check' ? ' check --json "$pin_metadata"' : ' env "$pin_metadata"';
      const command = body.indexOf(commandText);
      expect(checkout).toBeGreaterThan(0);
      expect(runtime).toBeGreaterThan(checkout);
      expect(helper).toBeGreaterThan(runtime);
      expect(command).toBeGreaterThan(helper);
      expect(body).toContain('id: scanner_helper');
      expect(body).toContain('pinned_dir="$(mktemp -d "$RUNNER_TEMP/pinned-tools.XXXXXXXX")"');
      expect(body).toContain('pin_metadata="$pinned_dir/pinned-tools.json"');
      expect(body).toContain('install -m 0600 scripts/ci/pinned-tools.json "$pin_metadata"');
      expect(body).toContain('"${{ steps.scanner_helper.outputs.helper-path }}"');
      expect(body).toContain(commandText);
      expect(body).not.toContain('scripts/ci/pinned-tools.ts');
      expect(body).not.toContain('check-pinned-tools.ts');
      expect(body).not.toContain('continue-on-error:');
      expect(body).toContain('contents: read');
    }
    expect(job('pin-metadata')).toContain('GITHUB_ENV="$GITHUB_OUTPUT"');
    expect(job('pin-metadata')).toContain(
      'OSV_SCANNER_IMAGE: ${{ steps.pins.outputs.OSV_SCANNER_IMAGE }}'
    );
    expect(job('pin-metadata')).toContain('SEMGREP_IMAGE: ${{ steps.pins.outputs.SEMGREP_IMAGE }}');
    expect(job('pinned-tools')).toContain('GH_TOKEN: ${{ github.token }}');
    expect(job('pinned-tools')).toContain('needs.changes.outputs.security_tools');
    expect(job('pinned-tools').match(/ check --json "\$pin_metadata"/gu)).toHaveLength(1);
    expect(job('pinned-tools')).not.toContain(' check "$pin_metadata"');
    expect(job('pinned-tools')).toContain(
      'observation="$RUNNER_TEMP/scanner-pin-observation.json"'
    );
    expect(job('pinned-tools')).toContain('> "$observation" || result=$?');
    expect(job('pinned-tools')).toContain('exit "$result"');
    expect(job('pinned-tools')).toContain('::warning title=${check.id} update available');
    expect(job('pinned-tools')).toContain('::notice title=${check.id} cooling window');
    expect(job('pinned-tools')).toContain('if: ${{ always() }}');
    expect(job('pinned-tools')).toContain('path: ${{ runner.temp }}/scanner-pin-observation.json');
    expect(job('pinned-tools')).toContain('if-no-files-found: warn');
    expect(job('pinned-tools')).toContain('retention-days: 7');
    expect(job('pin-metadata')).not.toContain(' check --json ');
    expect(security).toContain("needs['pin-metadata'].outputs.OSV_SCANNER_IMAGE");
    expect(security).toContain("needs['pin-metadata'].outputs.SEMGREP_IMAGE");
  });
});
