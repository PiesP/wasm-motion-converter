// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { Component } from 'solid-js';

const LINKS = {
  GIFENC: 'https://github.com/mattdesl/gifenc',
  WASM_WEBP: 'https://github.com/GoogleChromeLabs/wasm-webp',
  MEDIABUNNY: 'https://github.com/w3reality/mediabunny',
  FFMPEG_WASM: 'https://github.com/ffmpegwasm/ffmpeg.wasm',
  SOLIDJS: 'https://github.com/solidjs/solid',
  LICENSES: '/LICENSES.md',
  GITHUB_ISSUES: 'https://github.com/PiesP/wasm-motion-converter/issues',
} as const;

const LicenseAttribution: Component = () => (
  <footer
    class="border-t border-white/[0.06] py-6 mt-8 bg-[#0a0b0c]"
    role="contentinfo"
    aria-label="License attribution and footer"
  >
    <div class="max-w-6xl mx-auto px-4 text-center text-sm text-[#8a8f98] space-y-3">
      <p class="leading-relaxed">
        Powered by{' '}
        <a
          href={LINKS.GIFENC}
          target="_blank"
          rel="noopener noreferrer"
          class="text-[#5e6ad2] hover:text-[#828fff] underline underline-offset-2 px-1 py-0.5 inline-block min-h-[32px] leading-8"
          aria-label="gifenc on GitHub (opens in new tab)"
        >
          gifenc
        </a>
        {' (MIT), '}
        <a
          href={LINKS.WASM_WEBP}
          target="_blank"
          rel="noopener noreferrer"
          class="text-[#5e6ad2] hover:text-[#828fff] underline underline-offset-2 px-1 py-0.5 inline-block min-h-[32px] leading-8"
          aria-label="wasm-webp on GitHub (opens in new tab)"
        >
          wasm-webp
        </a>
        {' (MIT), '}
        <a
          href={LINKS.MEDIABUNNY}
          target="_blank"
          rel="noopener noreferrer"
          class="text-[#5e6ad2] hover:text-[#828fff] underline underline-offset-2 px-1 py-0.5 inline-block min-h-[32px] leading-8"
          aria-label="mediabunny on GitHub (opens in new tab)"
        >
          mediabunny
        </a>
        {' (MPL-2.0), and '}
        <a
          href={LINKS.FFMPEG_WASM}
          target="_blank"
          rel="noopener noreferrer"
          class="text-[#5e6ad2] hover:text-[#828fff] underline underline-offset-2 px-1 py-0.5 inline-block min-h-[32px] leading-8"
          aria-label="ffmpeg.wasm on GitHub (opens in new tab)"
        >
          ffmpeg.wasm
        </a>
        {' (LGPL-2.1+) — '}
        <a
          href={LINKS.SOLIDJS}
          target="_blank"
          rel="noopener noreferrer"
          class="text-[#5e6ad2] hover:text-[#828fff] underline underline-offset-2 px-1 py-0.5 inline-block min-h-[32px] leading-8"
          aria-label="SolidJS on GitHub (opens in new tab)"
        >
          SolidJS
        </a>
        {' (MIT) — '}
        processing happens entirely in your browser via WebCodecs.
      </p>
      <p>
        <a
          href={LINKS.LICENSES}
          target="_blank"
          rel="noopener noreferrer"
          class="text-[#5e6ad2] hover:text-[#828fff] underline underline-offset-2 px-2 py-1 inline-block min-h-[44px] leading-8"
          aria-label="View third-party licenses (opens in new tab)"
        >
          View Third-Party Licenses
        </a>
      </p>
      <p>
        Questions or feedback?{' '}
        <a
          href={LINKS.GITHUB_ISSUES}
          target="_blank"
          rel="noopener noreferrer"
          class="text-[#5e6ad2] hover:text-[#828fff] underline underline-offset-2 px-2 py-1 inline-block min-h-[44px] leading-8"
          aria-label="Open an issue on GitHub (opens in new tab)"
        >
          Open an issue on GitHub
        </a>
        .
      </p>
    </div>
  </footer>
);

export default LicenseAttribution;
