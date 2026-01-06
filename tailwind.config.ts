/**
 * Tailwind CSS Configuration
 *
 * Configures Tailwind CSS 4+ for the application.
 * Defines content sources, dark mode strategy, and custom theme extensions.
 *
 * @see https://tailwindcss.com/docs/configuration
 * @see CODE_STANDARDS.md Section 1 (File Organization)
 */
import type { Config } from 'tailwindcss';

export default {
  // Content sources for Tailwind's JIT compiler
  // Scans HTML and all TypeScript/JSX files for class names
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],

  // Dark mode using class-based strategy
  // Enables dark mode when 'dark' class is present on root element
  darkMode: 'class',

  theme: {
    extend: {
      // Custom color palette for consistent branding
      colors: {
        primary: '#3b82f6', // Blue-500 for primary actions and highlights
        secondary: '#8b5cf6', // Violet-500 for secondary elements
      },
    },
  },
} satisfies Config;
