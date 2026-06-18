// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { logger } from '@utils/logger';
import { createSignal } from 'solid-js';

type Theme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'theme';

const getInitialTheme = (): Theme => {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
  } catch (error) {
    logger.warn('general', 'Failed to read theme from localStorage', { error });
  }

  try {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  } catch (error) {
    logger.warn('general', 'Failed to detect system theme preference', { error });
  }

  return 'light';
};

const saveTheme = (themeValue: Theme): void => {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeValue);
  } catch (error) {
    logger.warn('general', 'Failed to persist theme to localStorage', { error });
  }
};

const [theme, setTheme] = createSignal<Theme>(getInitialTheme());

export { theme };

export const toggleTheme = (): void => {
  const currentTheme = theme();
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  setTheme(newTheme);
  saveTheme(newTheme);

  logger.info('general', 'Theme toggled', { from: currentTheme, to: newTheme });
};
