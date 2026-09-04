// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

describe('Content Security Policy', () => {
  it('allows WebAssembly without enabling JavaScript string evaluation', () => {
    const viteConfig = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');
    const deployedHeaders = readFileSync(resolve(root, 'public/_headers'), 'utf8');

    for (const policySource of [viteConfig, deployedHeaders]) {
      expect(policySource).toContain("'wasm-unsafe-eval'");
      expect(policySource).not.toMatch(/(?:^|\s)'unsafe-eval'(?:\s|;|$)/m);
    }
  });

  it('keeps preview style policy aligned with deployed reactive inline styles', () => {
    const viteConfig = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');
    const deployedHeaders = readFileSync(resolve(root, 'public/_headers'), 'utf8');

    expect(viteConfig).toContain(`const styleSrc = "'self' 'unsafe-inline'";`);
    expect(deployedHeaders).toContain("style-src 'self' 'unsafe-inline'");
  });
});
