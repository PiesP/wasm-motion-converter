// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const srcDir = path.resolve(__dirname, '../../../src/components');
const readComponent = (relativePath: string): string =>
  fs.readFileSync(path.join(srcDir, relativePath), 'utf8');

describe('component transition contracts', () => {
  const interactiveSources = [
    readComponent('FileDropzone.tsx'),
    readComponent('OptionSelector.tsx'),
    readComponent('ui/Button.tsx'),
  ];

  it('limits interactive transitions to intentional visual properties', () => {
    for (const source of interactiveSources) {
      expect(source).not.toContain('transition-all');
      expect(source).toContain('transition-[');
    }
  });

  it('keeps focus rings out of animated box-shadow transitions', () => {
    const focusRingSources = [readComponent('OptionSelector.tsx'), readComponent('ui/Button.tsx')];

    for (const source of focusRingSources) {
      expect(source).toContain('ring-2');
      expect(source).not.toMatch(/transition-\[[^\]]*box-shadow/);
    }
  });

  it('does not animate the passive panel primitive', () => {
    const source = readComponent('ui/Panel.tsx');

    expect(source).not.toContain('transition-');
    expect(source).not.toContain('duration-standard');
  });
});
