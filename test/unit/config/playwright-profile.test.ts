import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

describe('Playwright workflow profiles', () => {
  it('uses only repository-backed and generated fixtures in the CI suite', () => {
    const config = readFileSync(resolve(root, 'playwright.config.ts'), 'utf8');

    expect(config).toContain("PLAYWRIGHT_TEST_PROFILE");
    expect(config).toContain("'e2e/accessibility.spec.ts'");
    expect(config).toContain("'e2e/i18n.spec.ts'");
    expect(config).toContain("'e2e/ci-conversion-smoke.spec.ts'");
    expect(config).toContain('IS_CI_PROFILE ? 0');
    expect(config).toContain('--strictPort');
    expect(config).toContain("e2e/deploy-smoke.spec.ts");
    expect(config).toContain("e2e/dogfood-qa.spec.ts");
  });

  it('runs the explicit CI profile from the Actions workflow', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const workflow = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');

    expect(packageJson.scripts?.['test:e2e:ci']).toContain('PLAYWRIGHT_TEST_PROFILE=ci');
    expect(packageJson.scripts?.['pretest:e2e:ci']).toBe('pnpm prepare:e2e:fixture');
    expect(workflow).toContain('pnpm test:e2e:ci');
    expect(workflow).toContain('sudo apt-get install --yes ffmpeg');
    expect(workflow).not.toContain('pnpm exec playwright test\n');
  });
});
