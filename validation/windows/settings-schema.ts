// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';

import type { Page } from '@playwright/test';

const KEY = 'conversion-settings';
const FUTURE = JSON.stringify({
  __schemaVersion: 2,
  format: 'gif',
  quality: 'high',
  scale: 1,
  trimStart: 0,
  trimEnd: 0,
  smartFrameSkip: 'off',
  futureEncoderOption: { mode: 'new' },
});

export async function seedFutureSettings(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, value);
    },
    { key: KEY, value: FUTURE }
  );
}

export async function observeFutureSettings(page: Page): Promise<{
  persisted: boolean;
  notice: string;
  editedQuality: boolean;
}> {
  const notice = page.locator('[data-testid="settings-persistence-notice"]');
  await notice.waitFor({ state: 'visible' });
  const noticeText = (await notice.textContent())?.trim() ?? '';
  assert(noticeText.includes('will not be saved'), 'Future-schema notice is missing');
  await page.waitForTimeout(650);
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), KEY), FUTURE);
  await page.locator('[data-testid="option-quality-low"]').click();
  assert.equal(
    await page.locator('[data-testid="option-quality-low"] input').isChecked(),
    true,
    'Session settings did not respond to a user edit'
  );
  await page.waitForTimeout(650);
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), KEY), FUTURE);
  return { persisted: true, notice: noticeText, editedQuality: true };
}

export async function observeOlderTab(
  page: Page,
  writer: Page
): Promise<{
  futurePreserved: boolean;
  oldTabNotice: string;
}> {
  await page.waitForTimeout(650); // Let its initial supported-schema write complete.
  await writer.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: KEY,
    value: FUTURE,
  });
  await page.locator('[data-testid="option-quality-low"]').click();
  await page.waitForTimeout(650);
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), KEY), FUTURE);
  const noticeText =
    (await page.locator('[data-testid="settings-persistence-notice"]').textContent())?.trim() ?? '';
  assert(noticeText.includes('will not be saved'), 'Old tab did not report its blocked write');
  return { futurePreserved: true, oldTabNotice: noticeText };
}
