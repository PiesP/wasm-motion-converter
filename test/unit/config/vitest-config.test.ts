import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Vitest coverage gate', () => {
  it('counts unimported runtime source and enforces positive coverage thresholds', () => {
    const source = readFileSync(resolve(process.cwd(), 'vitest.config.ts'), 'utf8');

    expect(source).toMatch(/passWithNoTests:\s*false/);
    expect(source).toContain("include: ['src/**/*.{ts,tsx}']");
    expect(source).toContain("'src/index.tsx'");
    expect(source).toContain("'src/services/conversion-worker/worker.ts'");
    expect(source).toContain("'src/test-helpers.ts'");
    expect(source).toMatch(/thresholds:\s*\{[\s\S]*statements:\s*[1-9]\d*/);
    expect(source).toMatch(/thresholds:\s*\{[\s\S]*branches:\s*[1-9]\d*/);
    expect(source).toMatch(/thresholds:\s*\{[\s\S]*functions:\s*[1-9]\d*/);
    expect(source).toMatch(/thresholds:\s*\{[\s\S]*lines:\s*[1-9]\d*/);
  });

  it('re-runs the complete quality contract after automatic fixes', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['quality:fix']).toBe(
      'pnpm -s fmt:fix && pnpm -s lint:fix && pnpm -s quality'
    );
  });
});
