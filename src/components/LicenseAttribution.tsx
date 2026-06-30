// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { useLocale } from '@hooks/use-locale';
import type { Component } from 'solid-js';

const LIBRARIES = [
  { name: 'gifenc', url: 'https://github.com/mattdesl/gifenc', license: 'MIT' },
  { name: 'wasm-webp', url: 'https://github.com/GoogleChromeLabs/wasm-webp', license: 'MIT' },
  { name: 'mediabunny', url: 'https://github.com/w3reality/mediabunny', license: 'MPL-2.0' },
  { name: 'ffmpeg.wasm', url: 'https://github.com/ffmpegwasm/ffmpeg.wasm', license: 'LGPL-2.1+' },
  { name: 'SolidJS', url: 'https://github.com/solidjs/solid', license: 'MIT' },
] as const;

const LICENSES_URL = '/LICENSES.md';
const GITHUB_ISSUES_URL = 'https://github.com/PiesP/wasm-motion-converter/issues';

const linkClass =
  'text-[#5e6ad2] hover:text-[#828fff] underline underline-offset-2 px-1.5 py-1 inline-flex items-center min-h-[44px]';

const LicenseAttribution: Component = () => {
  const { t } = useLocale();

  return (
    <footer
      class="border-t border-white/[0.06] py-2 sm:py-3 mt-4 sm:mt-8 bg-[#0a0b0c]"
      role="contentinfo"
      aria-label={t('footer.licenseAttribution')}
    >
      <div class="max-w-6xl mx-auto px-4 text-center text-[11px] sm:text-xs text-[#8a8f98] space-y-1 sm:space-y-1.5">
        {/* Line 1: Powered by — libraries in a responsive inline list */}
        <p class="leading-relaxed">
          Powered by{' '}
          <span class="inline-flex flex-wrap justify-center gap-x-0.5 gap-y-1">
            {LIBRARIES.map((lib, i) => (
              <span class="inline-flex items-center">
                <a
                  href={lib.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class={linkClass}
                  aria-label={t('footer.linkGitHub', { name: lib.name })}
                >
                  {lib.name}
                </a>
                <span class="text-[#62666d]">({lib.license})</span>
                {i < LIBRARIES.length - 1 && (
                  <span class="text-[#62666d] hidden sm:inline">, </span>
                )}
              </span>
            ))}
          </span>
        </p>

        {/* Line 2: Processing note — hidden on mobile to save space */}
        <p class="hidden sm:block text-[#62666d]">
          Processing happens entirely in your browser via WebCodecs.
        </p>

        {/* Line 3: Licenses + feedback in one line */}
        <p>
          <a
            href={LICENSES_URL}
            target="_blank"
            rel="noopener noreferrer"
            class={linkClass}
            aria-label={t('footer.viewLicenses')}
          >
            {t('footer.viewLicenses')}
          </a>
          <span class="hidden sm:inline text-[#62666d] mx-1">·</span>
          <span class="hidden sm:inline">{t('footer.questions')}</span>
          <a
            href={GITHUB_ISSUES_URL}
            target="_blank"
            rel="noopener noreferrer"
            class={linkClass}
            aria-label={t('footer.openIssue')}
          >
            {t('footer.openIssue')}
          </a>
        </p>
      </div>
    </footer>
  );
};

export default LicenseAttribution;
