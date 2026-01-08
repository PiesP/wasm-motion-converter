import { splitProps } from 'solid-js';

import { removeToast } from '../stores/toast-store';
import Icon from './ui/Icon';

import type { Component } from 'solid-js';
import type { Toast as ToastType } from '../stores/toast-store';

/**
 * Minimum width for toast notifications in pixels
 */
const MIN_TOAST_WIDTH = 'min-w-[300px]';

/**
 * Maximum width for toast notifications
 */
const MAX_TOAST_WIDTH = 'max-w-md';

/**
 * ARIA label for toast dismiss button
 */
const DISMISS_LABEL = 'Dismiss notification';

/**
 * Toast component props
 */
interface ToastProps {
  /** Toast data to display */
  toast: ToastType;
}

/**
 * Toast notification component
 *
 * Displays a dismissible toast notification with icon, message, and color coding
 * based on the toast type (success, error, warning, info).
 *
 * @param props - Component props
 * @returns Toast notification element
 */
const Toast: Component<ToastProps> = (props) => {
  const [local] = splitProps(props, ['toast']);
  /**
   * Get icon name based on toast type
   */
  const getIconName = (): 'success' | 'error' | 'warning' | 'info' => {
    switch (local.toast.type) {
      case 'success':
        return 'success' as const;
      case 'error':
        return 'error' as const;
      case 'warning':
        return 'warning' as const;
      default:
        return 'info' as const;
    }
  };

  /**
   * Get color classes based on toast type
   */
  const getColorClasses = (): {
    bg: string;
    border: string;
    icon: string;
    text: string;
    button: string;
  } => {
    switch (local.toast.type) {
      case 'success':
        return {
          bg: 'bg-green-50 dark:bg-green-950',
          border: 'border-green-400 dark:border-green-500',
          icon: 'text-green-400 dark:text-green-500',
          text: 'text-green-800 dark:text-green-200',
          button:
            'text-green-500 hover:text-green-700 dark:text-green-400 dark:hover:text-green-200',
        };
      case 'error':
        return {
          bg: 'bg-red-50 dark:bg-red-950',
          border: 'border-red-400 dark:border-red-500',
          icon: 'text-red-400 dark:text-red-500',
          text: 'text-red-800 dark:text-red-200',
          button: 'text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-200',
        };
      case 'warning':
        return {
          bg: 'bg-yellow-50 dark:bg-yellow-950',
          border: 'border-yellow-400 dark:border-yellow-500',
          icon: 'text-yellow-400 dark:text-yellow-500',
          text: 'text-yellow-800 dark:text-yellow-200',
          button:
            'text-yellow-500 hover:text-yellow-700 dark:text-yellow-400 dark:hover:text-yellow-200',
        };
      default:
        return {
          bg: 'bg-blue-50 dark:bg-blue-950',
          border: 'border-blue-400 dark:border-blue-500',
          icon: 'text-blue-400 dark:text-blue-500',
          text: 'text-blue-800 dark:text-blue-200',
          button: 'text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-200',
        };
    }
  };

  const colors = getColorClasses();

  return (
    <div
      class={`${colors.bg} ${colors.border} border-l-4 rounded-lg shadow-lg p-4 flex items-start gap-3 ${MIN_TOAST_WIDTH} ${MAX_TOAST_WIDTH} animate-slide-in`}
      role="alert"
      aria-live="polite"
    >
      <Icon name={getIconName()} size="md" class={colors.icon} />
      <p class={`${colors.text} text-sm flex-1`}>{local.toast.message}</p>
      <button
        type="button"
        onClick={() => removeToast(local.toast.id)}
        class={`${colors.button} focus:outline-none focus:ring-2 focus:ring-offset-2 rounded`}
        aria-label={DISMISS_LABEL}
      >
        <Icon name="x" size="sm" />
      </button>
    </div>
  );
};

export default Toast;
