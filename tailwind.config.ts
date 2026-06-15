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
      colors: {
        primary: '#3b82f6',
      },
    },
  },
} satisfies Config;
