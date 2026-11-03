// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';

import type { Page } from '@playwright/test';

const KEY = 'conversion-settings';
const LOCALE_KEY = 'dropconvert.locale';
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

/** Exercise the built app's independent language preference in the same focused profile. */
export async function observeLanguagePreference(page: Page): Promise<{
  orderedOptions: string[];
  savedLanguage: string;
  autoLanguage: string;
  arabicDirection: string;
}> {
  const selector = page.locator('[data-testid="language-selector"]');
  await selector.waitFor({ state: 'visible' });
  const orderedOptions = await selector
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  assert.deepEqual(orderedOptions, ['auto', 'en', 'ko', 'ja', 'zh-CN', 'es', 'ar']);

  await selector.selectOption('ko');
  await page.waitForFunction(() => document.documentElement.lang === 'ko');
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), LOCALE_KEY), 'ko');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await selector.waitFor({ state: 'visible' });
  assert.equal(await selector.inputValue(), 'ko');
  assert.equal(await page.locator('html').getAttribute('lang'), 'ko');
  const savedLanguage = 'ko';

  await selector.selectOption('auto');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), LOCALE_KEY), 'auto');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await selector.waitFor({ state: 'visible' });
  assert.equal(await selector.inputValue(), 'auto');
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  const autoLanguage = 'en';

  await selector.selectOption('ar');
  await page.waitForFunction(() => document.documentElement.lang === 'ar');
  assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), LOCALE_KEY), 'ar');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await selector.waitFor({ state: 'visible' });
  assert.equal(await selector.inputValue(), 'ar');
  assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');

  return { orderedOptions, savedLanguage, autoLanguage, arabicDirection: 'rtl' };
}
