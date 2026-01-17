import { theme, toggleTheme } from '@stores/theme-store';
import { type Component, createEffect, createMemo, Show } from 'solid-js';

const THEME_STORAGE_KEY = 'theme';
const DARK_MODE_CLASS = 'dark';

const ThemeToggle: Component = () => {
  const isDarkTheme = createMemo(() => theme() === 'dark');
  const themeLabel = createMemo(() => `Switch to ${isDarkTheme() ? 'light' : 'dark'} theme`);

  createEffect(() => {
    const currentTheme = theme();
    const html = document.documentElement;

    if (currentTheme === 'dark') {
      html.classList.add(DARK_MODE_CLASS);
      html.style.colorScheme = 'dark';
    } else {
      html.classList.remove(DARK_MODE_CLASS);
      html.style.colorScheme = 'light';
    }

    localStorage.setItem(THEME_STORAGE_KEY, currentTheme);
  });

  return (
    <button
      type="button"
      onClick={toggleTheme}
      class="p-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-blue-400 dark:focus:ring-offset-gray-900"
      aria-label={themeLabel()}
    >
      <Show
        when={isDarkTheme()}
        fallback={
          <svg
            class="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <title>Moon icon</title>
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
            />
          </svg>
        }
      >
        <svg
          class="w-5 h-5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <title>Sun icon</title>
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
          />
        </svg>
      </Show>
    </button>
  );
};

export default ThemeToggle;
