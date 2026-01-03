import { createSignal } from 'solid-js';

export type Theme = 'light' | 'dark';

const getInitialTheme = (): Theme => {
  // Check localStorage first
  const stored = localStorage.getItem('theme');
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }

  // Fall back to system preference
  if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }

  return 'light';
};

export const [theme, setTheme] = createSignal<Theme>(getInitialTheme());

export const toggleTheme = () => {
  const currentTheme = theme();
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  console.log('[Theme Store] toggleTheme:', 'current:', currentTheme, '-> new:', newTheme);
  setTheme(newTheme);
};
