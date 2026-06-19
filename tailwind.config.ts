import type { Config } from 'tailwindcss';

export default {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    '!./src/**/*.test.{ts,tsx}',
    '!./src/**/*.spec.{ts,tsx}',
  ],

  darkMode: 'class',

  theme: {
    extend: {
      /* ── Linear Design System Tokens ── */

      colors: {
        /* Surface / Background */
        'bg-base': '#08090a' /* marketing black — page background */,
        'bg-panel': '#0f1011' /* panel / sidebar background */,
        'bg-elevated': '#191a1b' /* elevated surfaces — cards, modals */,

        /* Text */
        'text-primary': '#f7f8f8' /* headings, primary content */,
        'text-secondary': '#d0d6e0' /* body text, descriptions */,
        'text-tertiary': '#8a8f98' /* captions, labels, hints */,
        'text-quaternary': '#62666d' /* disabled, placeholder text */,

        /* Brand Accent */
        brand: '#5e6ad2' /* default accent — icons, badges */,
        'brand-interactive': '#7170ff' /* interactive — links, active states */,
        'brand-hover': '#828fff' /* hover state */,

        /* Borders */
        'border-subtle': 'rgba(255, 255, 255, 0.05)',
        'border-standard': 'rgba(255, 255, 255, 0.08)',
      },

      borderRadius: {
        button: '6px',
        card: '8px',
        panel: '12px',
      },

      fontFamily: {
        sans: [
          '"Inter Variable"',
          '"Inter"',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'sans-serif',
        ],
      },
    },
  },
} satisfies Config;
