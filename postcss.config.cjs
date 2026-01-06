/**
 * PostCSS Configuration
 *
 * Configures PostCSS processing for the application.
 * Uses Tailwind CSS 4+ PostCSS plugin for modern CSS processing.
 *
 * Note: This file uses .cjs extension for CommonJS compatibility
 * with build tools that may not fully support ESM configuration files.
 *
 * @see https://tailwindcss.com/docs/installation/vite
 */
module.exports = {
  plugins: {
    // Tailwind CSS 4+ PostCSS plugin
    // Processes Tailwind directives and generates utility classes
    '@tailwindcss/postcss': {},
  },
};
