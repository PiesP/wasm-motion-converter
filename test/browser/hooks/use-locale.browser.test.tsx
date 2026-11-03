// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { LocaleProvider, useLocale } from '@hooks/use-locale';
import arTranslations from '@i18n/ar.json';
import enTranslations from '@i18n/en.json';
import type { Locale, SettingLocale, Translations } from '@t/i18n-types';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vite-plus/test';

let dispose: (() => void) | undefined;
let setLanguage: ((setting: SettingLocale) => void) | undefined;

function Probe() {
  const { locale, settingLocale, setLocale, t } = useLocale();
  setLanguage = setLocale;
  return (
    <div data-testid="locale-probe">
      <span data-testid="resolved">{locale()}</span>
      <span data-testid="setting">{settingLocale()}</span>
      <span data-testid="title">{t('app.title')}</span>
    </div>
  );
}

function mount(loader?: (locale: Locale) => Promise<Translations>): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  dispose = render(
    () => (
      <LocaleProvider loadTranslations={loader}>
        <Probe />
      </LocaleProvider>
    ),
    container
  );
}

async function ready(): Promise<void> {
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="locale-probe"]')).not.toBeNull()
  );
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  setLanguage = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('restores a saved concrete language and preserves auto as a separate setting', async () => {
  localStorage.setItem('dropconvert.locale', 'ar');
  mount();
  await ready();
  expect(document.querySelector('[data-testid="resolved"]')?.textContent).toBe('ar');
  expect(document.querySelector('[data-testid="setting"]')?.textContent).toBe('ar');
  expect(document.documentElement.dir).toBe('rtl');

  vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' });
  setLanguage?.('auto');
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="resolved"]')?.textContent).toBe('en')
  );
  expect(document.querySelector('[data-testid="setting"]')?.textContent).toBe('auto');
  expect(localStorage.getItem('dropconvert.locale')).toBe('auto');
});

it('survives unavailable storage when detecting and saving a language', async () => {
  vi.stubGlobal('navigator', { languages: ['ar-EG'], language: 'ar-EG' });
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('unavailable');
    },
    setItem: () => {
      throw new Error('unavailable');
    },
  });
  mount();
  await ready();
  expect(document.querySelector('[data-testid="resolved"]')?.textContent).toBe('ar');
  expect(document.querySelector('[data-testid="setting"]')?.textContent).toBe('auto');
  setLanguage?.('en');
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="resolved"]')?.textContent).toBe('en')
  );
});

it('keeps the newer language after a delayed older load and falls back after a failed load', async () => {
  let resolveKo: ((value: Translations) => void) | undefined;
  const loader = (locale: Locale): Promise<Translations> => {
    if (locale === 'ko')
      return new Promise((resolve) => {
        resolveKo = resolve;
      });
    if (locale === 'ja') return Promise.reject(new Error('simulated translation load failure'));
    if (locale === 'ar') return Promise.resolve(arTranslations as Translations);
    return Promise.resolve(enTranslations as Translations);
  };
  localStorage.setItem('dropconvert.locale', 'en');
  mount(loader);
  await ready();
  setLanguage?.('ko');
  await vi.waitFor(() => expect(resolveKo).toBeTypeOf('function'));
  setLanguage?.('en');
  resolveKo?.({ ...enTranslations, 'app.title': 'Stale Korean title' } as Translations);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.querySelector('[data-testid="title"]')?.textContent).toBe(
    enTranslations['app.title']
  );
  expect(document.querySelector('[data-testid="resolved"]')?.textContent).toBe('en');

  setLanguage?.('ar');
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="title"]')?.textContent).toBe(
      arTranslations['app.title']
    )
  );
  setLanguage?.('ja');
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="resolved"]')?.textContent).toBe('ja')
  );
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="title"]')?.textContent).toBe(
      enTranslations['app.title']
    )
  );
});
