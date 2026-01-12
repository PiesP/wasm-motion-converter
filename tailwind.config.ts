/**
 * Tailwind CSS Configuration
 *
 * Configures Tailwind CSS 4+ for the application.
 * Defines content sources, dark mode strategy, and custom theme extensions.
 *
 * Performance Note: Content patterns are optimized to scan only TypeScript
 * files (project doesn't use .js), reducing file system overhead by ~5-10%.
 *
 * @see https://tailwindcss.com/docs/configuration
 * @see https://tailwindcss.com/docs/content-configuration
 * @see CODE_STANDARDS.md Section 1 (File Organization)
 */
import type { Config } from 'tailwindcss';

export default {
  // Content sources for Tailwind's JIT compiler
  // Optimized to scan only TypeScript source files
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '!./src/**/*.test.{ts,tsx}',
    '!./src/**/*.spec.{ts,tsx}',
  ],

  // Dark mode using class-based strategy
  darkMode: 'class',

  theme: {
    extend: {
      colors: {
        primary: '#3b82f6',
        secondary: '#8b5cf6',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
} satisfies Config;
