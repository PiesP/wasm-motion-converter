import type { Component } from 'solid-js';

const LicenseAttribution: Component = () => {
  return (
    <footer class="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 py-6 mt-8">
      <div class="max-w-4xl mx-auto px-4 text-center text-sm text-gray-600 dark:text-gray-400 space-y-2">
        <p>
          Powered by{' '}
          <a
            href="https://github.com/ffmpegwasm/ffmpeg.wasm"
            target="_blank"
            rel="noopener noreferrer"
            class="text-blue-600 dark:text-blue-400 hover:underline"
          >
            ffmpeg.wasm
          </a>{' '}
          (MIT License) using{' '}
          <a
            href="https://ffmpeg.org/"
            target="_blank"
            rel="noopener noreferrer"
            class="text-blue-600 dark:text-blue-400 hover:underline"
          >
            FFmpeg
          </a>{' '}
          (LGPL 2.1+ License)
        </p>
        <p>
          <a
            href="/LICENSES.md"
            target="_blank"
            rel="noopener noreferrer"
            class="text-blue-600 dark:text-blue-400 hover:underline"
          >
            View Third-Party Licenses
          </a>
        </p>
      </div>
    </footer>
  );
};

export default LicenseAttribution;
