// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { expect, test } from '@playwright/test';
import { downloadResult, runConversion } from './fixtures/test-helpers';
import { validateFileMagic } from './fixtures/verify';

const FIXTURE = 'test-video-ci-h264.mp4';

test.describe('CI codec smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  for (const format of ['gif', 'webp'] as const) {
    test(`converts a generated H.264 fixture to ${format.toUpperCase()}`, async ({ page }) => {
      const result = await runConversion(page, {
        file: FIXTURE,
        format,
        quality: 'low',
        scale: '50%',
        timeoutMs: 120_000,
      });

      expect(result.error).toBeNull();
      expect(result.state).toBe('done');

      const output = await downloadResult(page);
      const validation = validateFileMagic(output, format);
      expect(validation).toMatchObject({ valid: true });
    });
  }
});
