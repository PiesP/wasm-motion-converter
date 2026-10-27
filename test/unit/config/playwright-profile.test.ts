import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');

describe('Playwright workflow profiles', () => {
  it('uses only repository-backed and generated fixtures in the CI suite', () => {
    const config = readFileSync(resolve(root, 'playwright.config.ts'), 'utf8');

    expect(config).toContain('PLAYWRIGHT_TEST_PROFILE');
    expect(config).toContain("'e2e/accessibility.spec.ts'");
    expect(config).toContain("'e2e/design-system.spec.ts'");
    expect(config).toContain("'e2e/i18n.spec.ts'");
    expect(config).toContain("'e2e/ci-conversion-smoke.spec.ts'");
    expect(config).toContain("'e2e/adaptive-resource-safety.spec.ts'");
    expect(config).toContain('IS_CI_PROFILE ? 0');
    expect(config).toContain('--strictPort');
    expect(config).toContain('e2e/deploy-smoke.spec.ts');
    expect(config).toContain('e2e/dogfood-qa.spec.ts');
  });

  it('keeps the host-dependent resource profile opt-in', () => {
    const config = readFileSync(resolve(root, 'playwright.config.ts'), 'utf8');
    const fixtureGenerator = readFileSync(
      resolve(root, 'scripts/test/generate-e2e-video.ts'),
      'utf8'
    );
    const resourceProfile = readFileSync(
      resolve(root, 'test/e2e/resource-profile.spec.ts'),
      'utf8'
    );
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(config).toContain("TEST_PROFILE === 'resource'");
    expect(config).toContain("'e2e/resource-profile.spec.ts'");
    expect(packageJson.scripts?.['test:e2e:resource']).toContain('run-playwright.ts resource');
    expect(packageJson.scripts?.['pretest:e2e:resource']).toContain('prepare-resource-fixtures.ts');
    expect(fixtureGenerator).toContain('test-video-resource-hostile-par.webm');
    expect(fixtureGenerator).toContain('setsar=100/1:max=100');
    expect(resourceProfile).toContain('HOSTILE_PAR_FIXTURE');
    expect(resourceProfile).toContain('postGcPssSlope');
  });

  it('runs the explicit CI profile from the Actions workflow', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const config = readFileSync(resolve(root, 'playwright.config.ts'), 'utf8');
    const workflow = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
    const e2eJob = workflow.slice(workflow.indexOf('  e2e:\n'), workflow.indexOf('\n  build:\n'));

    expect(packageJson.scripts?.['test:e2e:ci']).toContain('run-playwright.ts ci');
    expect(packageJson.scripts?.['pretest:e2e:ci']).toBe('vp run prepare:e2e:fixture');
    expect(workflow).toContain('vp run test:e2e:ci');
    expect(workflow).toContain('sudo apt-get install --yes ffmpeg');
    expect(e2eJob).toContain('timeout-minutes: 90');
    expect(workflow).not.toContain('vp exec playwright test\n');
    expect(config).toContain("trace: 'retain-on-failure'");
    expect(config).toContain("video: process.env.CI ? 'retain-on-failure' : 'off'");
    expect(workflow).toContain('playwright-report/');
  });

  it('runs capability smoke coverage in Firefox and WebKit', () => {
    const config = readFileSync(resolve(root, 'playwright.config.ts'), 'utf8');
    const workflow = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
    const releaseWorkflow = readFileSync(resolve(root, '.github/workflows/release.yaml'), 'utf8');

    expect(config).toContain("name: 'firefox'");
    expect(config).toContain("name: 'webkit'");
    expect(config).toContain("'e2e/browser-capability.spec.ts'");
    expect(config).toContain('IS_DEPLOY_PROFILE || IS_RESOURCE_PROFILE');
    expect(workflow).toContain('playwright install --with-deps chromium firefox webkit');
    expect(releaseWorkflow).toContain('playwright install --with-deps chromium firefox webkit');
  });

  it('uses an exact installed-version browser cache without skipping installation', () => {
    const ci = readFileSync(resolve(root, '.github/workflows/ci.yaml'), 'utf8');
    const release = readFileSync(resolve(root, '.github/workflows/release.yaml'), 'utf8');
    expect(ci).not.toContain('cache_trial');

    for (const [name, workflow, end] of [
      ['CI', ci, '\n  build:\n'],
      ['release', release, '\n  build:\n'],
    ] as const) {
      const e2e = workflow.slice(workflow.indexOf('  e2e:\n'), workflow.indexOf(end));
      expect(e2e, name).toContain('timeout-minutes: 90');
      const setup = e2e.indexOf('      - name: 📦 Setup project');
      const version = e2e.indexOf('      - name: 🎭 Resolve installed Playwright version');
      const cache = e2e.indexOf('      - name: 🎭 Cache Playwright browsers');
      const install = e2e.indexOf('vp exec playwright install --with-deps chromium firefox webkit');
      const run = e2e.indexOf('vp run test:e2e:ci');
      const verificationStep = e2e.slice(e2e.lastIndexOf('\n      - name:', run), run);
      expect(verificationStep, name).toContain(`timeout-minutes: ${name === 'CI' ? 60 : 20}`);
      expect(
        setup >= 0 && setup < version && version < cache && cache < install && install < run,
        name
      ).toBe(true);
      expect(e2e, name).toContain("require('@playwright/test/package.json').version");
      const cacheStep = e2e.slice(cache, e2e.indexOf('\n      - name:', cache + 1));
      expect(cacheStep, name).toContain('path: ~/.cache/ms-playwright');
      expect(cacheStep, name).toContain('runner.os');
      expect(cacheStep, name).toContain('runner.arch');
      expect(cacheStep, name).toContain('ubuntu-24.04-chromium-firefox-webkit');
      expect(cacheStep, name).toContain('steps.playwright.outputs.version');
      expect(cacheStep, name).not.toContain('restore-keys:');
      expect(cacheStep, name).not.toContain('pnpm-lock.yaml');
    }
  });
});
