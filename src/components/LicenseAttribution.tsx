import type { Component } from 'solid-js';

const LINKS = {
  FFMPEG_WASM: 'https://github.com/ffmpegwasm/ffmpeg.wasm',
  FFMPEG_ORG: 'https://ffmpeg.org/',
  LICENSES: '/LICENSES.md',
  GITHUB_ISSUES: 'https://github.com/PiesP/wasm-motion-converter/issues',
} as const;

const LicenseAttribution: Component = () => (
  <footer
    class="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 py-6 mt-8"
    role="contentinfo"
    aria-label="License attribution and footer"
  >
    <div class="max-w-6xl mx-auto px-4 text-center text-sm text-gray-600 dark:text-gray-400 space-y-2">
      <p>
        Powered by{' '}
        <a
          href={LINKS.FFMPEG_WASM}
          target="_blank"
          rel="noopener noreferrer"
          class="text-blue-600 dark:text-blue-400 hover:underline"
          aria-label="ffmpeg.wasm on GitHub (opens in new tab)"
        >
          ffmpeg.wasm
        </a>{' '}
        (MIT License) using{' '}
        <a
          href={LINKS.FFMPEG_ORG}
          target="_blank"
          rel="noopener noreferrer"
          class="text-blue-600 dark:text-blue-400 hover:underline"
          aria-label="FFmpeg official website (opens in new tab)"
        >
          FFmpeg
        </a>{' '}
        (LGPL 2.1+ License)
      </p>
      <p>
        <a
          href={LINKS.LICENSES}
          target="_blank"
          rel="noopener noreferrer"
          class="text-blue-600 dark:text-blue-400 hover:underline"
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
          class="text-blue-600 dark:text-blue-400 hover:underline"
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
