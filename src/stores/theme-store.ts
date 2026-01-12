/**
 * Theme Store
 *
 * Manages application theme (light/dark mode) with persistence to localStorage
 * and system preference detection. Theme changes are automatically applied to
 * the document root element for CSS integration.
 */

// External dependencies
import { createSignal } from 'solid-js';

// Internal dependencies
import { logger } from '@utils/logger';

type Theme = 'light' | 'dark';

/**
 * localStorage key for theme persistence
 */
const THEME_STORAGE_KEY = 'theme';

/**
 * Get initial theme from localStorage or system preference
 *
 * Priority order:
 * 1. User preference from localStorage
 * 2. System preference from prefers-color-scheme media query
 * 3. Default to 'light' theme
 *
 * @returns Initial theme value
 */
const getInitialTheme = (): Theme => {
  try {
    // Check localStorage first
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
  } catch (error) {
    logger.warn('general', 'Failed to read theme from localStorage', { error });
  }

  // Fall back to system preference
  try {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  } catch (error) {
    logger.warn('general', 'Failed to detect system theme preference', {
      error,
    });
  }

  return 'light';
};

/**
 * Persist theme to localStorage
 *
 * Saves the theme preference for future sessions. If localStorage is unavailable,
 * logs a warning but does not throw (theme will still work in current session).
 *
 * @param themeValue - Theme to persist
 */
const saveTheme = (themeValue: Theme): void => {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeValue);
  } catch (error) {
    logger.warn('general', 'Failed to persist theme to localStorage', {
      error,
    });
  }
};

/**
 * Current theme (light or dark)
 *
 * Initialized from localStorage or system preference. Changes are automatically
 * persisted and applied to the document root element.
 */
export const [theme, setTheme] = createSignal<Theme>(getInitialTheme());

/**
 * Toggle between light and dark themes
 *
 * Switches the current theme and persists the change to localStorage.
 * The new theme is automatically applied to the document root element.
 *
 * @example
 * // In a component
 * <button onClick={toggleTheme}>
 *   Toggle Theme
 * </button>
 */
export const toggleTheme = (): void => {
  const currentTheme = theme();
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  setTheme(newTheme);
  saveTheme(newTheme);

  logger.info('general', 'Theme toggled', { from: currentTheme, to: newTheme });
};
