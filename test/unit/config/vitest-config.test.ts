import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Vitest coverage gate', () => {
  it('fails when tests are missing and enforces positive coverage thresholds', () => {
    const source = readFileSync(resolve(process.cwd(), 'vitest.config.ts'), 'utf8');

    expect(source).toMatch(/passWithNoTests:\s*false/);
    expect(source).toMatch(/thresholds:\s*\{[\s\S]*statements:\s*[1-9]\d*/);
    expect(source).toMatch(/thresholds:\s*\{[\s\S]*branches:\s*[1-9]\d*/);
    expect(source).toMatch(/thresholds:\s*\{[\s\S]*functions:\s*[1-9]\d*/);
    expect(source).toMatch(/thresholds:\s*\{[\s\S]*lines:\s*[1-9]\d*/);
  });
});
