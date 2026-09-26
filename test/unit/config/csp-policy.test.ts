// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

describe('Content Security Policy', () => {
  it('encodes and decodes real WASM WebP frames without JavaScript string evaluation', () => {
    const script = [
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      "import factory from 'wasm-webp/dist/esm/webp-wasm.js';",
      "const wasmBinary = readFileSync('node_modules/wasm-webp/dist/esm/webp-wasm.wasm');",
      'const module = await factory({ wasmBinary });',
      'const outputs = [];',
      'for (const color of [[255, 0, 0], [0, 255, 0], [255, 0, 0]]) {',
      '  const pixels = new Uint8Array(16 * 16 * 3);',
      '  for (let offset = 0; offset < pixels.length; offset += 3) pixels.set(color, offset);',
      '  const encoded = module.encodeRGB(pixels, 16, 16, 90).slice();',
      "  assert.equal(Buffer.from(encoded.subarray(0, 4)).toString(), 'RIFF');",
      "  assert.equal(Buffer.from(encoded.subarray(8, 12)).toString(), 'WEBP');",
      '  const decoded = module.decodeRGB(encoded);',
      '  assert.equal(decoded.width, 16);',
      '  assert.equal(decoded.height, 16);',
      '  for (let channel = 0; channel < 3; channel++) {',
      '    assert.ok(Math.abs(decoded.data[channel] - color[channel]) < 20);',
      '  }',
      '  outputs.push(encoded);',
      '}',
      'assert.deepEqual(outputs[0], outputs[2]);',
      'assert.notDeepEqual(outputs[0], outputs[1]);',
      "assert.throws(() => module.encodeRGB(), /arguments/);",
      "console.log('WASM WebP CSP round trip passed');",
    ].join('\n');

    const output = execFileSync(
      process.execPath,
      ['--disallow-code-generation-from-strings', '--input-type=module', '-'],
      { cwd: root, input: script, encoding: 'utf8', timeout: 15_000 }
    );
    expect(output).toContain('WASM WebP CSP round trip passed');
  });

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

  it('uses absolute paths for Cloudflare Pages header rules', () => {
    const deployedHeaders = readFileSync(resolve(root, 'public/_headers'), 'utf8');
    const routeRules = deployedHeaders
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('  '));

    expect(routeRules).toContain('/*.webm');
    expect(routeRules).toContain('/*.mp4');
    expect(routeRules).toContain('/*.m4v');
    expect(routeRules.every((route) => route.startsWith('/'))).toBe(true);
  });
});
