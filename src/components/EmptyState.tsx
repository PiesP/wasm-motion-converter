import type { Component } from 'solid-js';

const EmptyState: Component = () => {
  return (
    <div class="text-center py-12">
      {/* Animated icon */}
      <div class="mb-6 flex justify-center">
        <div class="relative w-24 h-24">
          {/* Outer circle animation */}
          <svg
            viewBox="0 0 100 100"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class="absolute inset-0 w-full h-full text-blue-200 dark:text-blue-900 animate-spin"
            style="animation-duration: 20s; animation-direction: reverse;"
          >
            <circle cx="50" cy="50" r="45" opacity="0.3" />
          </svg>

          {/* Main icon */}
          <svg
            viewBox="0 0 48 48"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="absolute inset-0 w-full h-full text-blue-500 dark:text-blue-400"
          >
            <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" />
          </svg>
        </div>
      </div>

      {/* Heading */}
      <h2 class="text-2xl font-bold text-gray-900 dark:text-white mb-2">
        Convert Videos to Animated GIFs & WebP
      </h2>

      {/* Description */}
      <p class="text-gray-600 dark:text-gray-300 mb-8 max-w-md mx-auto">
        Transform your videos into beautiful short-form content. All processing happens directly in
        your browser - no uploads needed.
      </p>

      {/* Feature list */}
      <div class="space-y-3 mb-8 text-sm">
        <div class="flex items-center justify-center gap-2 text-gray-700 dark:text-gray-400">
          <svg class="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20">
            <path
              fill-rule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clip-rule="evenodd"
            />
          </svg>
          <span>Lightning-fast local conversion</span>
        </div>
        <div class="flex items-center justify-center gap-2 text-gray-700 dark:text-gray-400">
          <svg class="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20">
            <path
              fill-rule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clip-rule="evenodd"
            />
          </svg>
          <span>Privacy-first - your files never leave your device</span>
        </div>
        <div class="flex items-center justify-center gap-2 text-gray-700 dark:text-gray-400">
          <svg class="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20">
            <path
              fill-rule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clip-rule="evenodd"
            />
          </svg>
          <span>Customizable quality and dimensions</span>
        </div>
      </div>

      {/* CTA */}
      <p class="text-sm text-gray-500 dark:text-gray-400">👇 Choose a video file to get started</p>
    </div>
  );
};

export default EmptyState;
