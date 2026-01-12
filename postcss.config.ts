/**
 * PostCSS Configuration
 *
 * Configures PostCSS processing for the application.
 * Uses Tailwind CSS 4+ PostCSS plugin for modern CSS processing.
 *
 * Note: This file uses .ts extension with ES module syntax to maintain
 * consistency with the project's "type": "module" configuration.
 *
 * @see https://tailwindcss.com/docs/installation/vite
 * @see CODE_STANDARDS.md Section 1 (File Organization)
 */
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
