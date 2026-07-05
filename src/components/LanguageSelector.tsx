// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import type { Component } from 'solid-js';

interface LanguageSelectorProps {
  class?: string;
}

const LanguageSelector: Component<LanguageSelectorProps> = (props) => {
  const { locale, setLocale, t, supportedLocales } = useLocale();

  const handleChange = (event: Event) => {
    const target = event.target as HTMLSelectElement;
    setLocale(target.value as Parameters<typeof setLocale>[0]);
  };

  return (
    <select
      value={locale()}
      onChange={handleChange}
      class={
        props.class ??
        'rounded-md border border-border-standard bg-white/[0.02] px-2 py-1.5 text-xs text-text-secondary focus:outline-none focus:ring-2 focus:ring-brand/50 cursor-pointer'
      }
      aria-label={t('lang.select')}
      aria-live="polite"
      data-testid="language-selector"
    >
      {supportedLocales.map((loc) => (
        <option
          value={loc.code}
          class="bg-bg-elevated text-text-secondary"
          aria-current={locale() === loc.code ? 'true' : undefined}
        >
          {loc.name}
        </option>
      ))}
    </select>
  );
};

export default LanguageSelector;
