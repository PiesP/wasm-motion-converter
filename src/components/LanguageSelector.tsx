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
        'rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1.5 text-xs text-[#d0d6e0] focus:outline-none focus:ring-2 focus:ring-[rgba(94,106,210,0.5)] cursor-pointer'
      }
      aria-label={t('lang.select')}
      data-testid="language-selector"
    >
      {supportedLocales.map((loc) => (
        <option
          value={loc.code}
          class="bg-[#191a1b] text-[#d0d6e0]"
          aria-current={locale() === loc.code ? 'true' : undefined}
        >
          {loc.name}
        </option>
      ))}
    </select>
  );
};

export default LanguageSelector;
