import { type Component, type JSX, splitProps } from 'solid-js';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
}

const Button: Component<ButtonProps> = (props) => {
  const [local, others] = splitProps(props, [
    'variant',
    'size',
    'loading',
    'fullWidth',
    'disabled',
    'class',
    'children',
  ]);

  const variant = () => local.variant ?? 'primary';
  const size = () => local.size ?? 'md';

  const baseClasses =
    'inline-flex justify-center items-center border font-medium rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-gray-900 disabled:opacity-50 disabled:cursor-not-allowed';

  const variantClasses = () => {
    switch (variant()) {
      case 'primary':
        return 'border-transparent text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800 focus:ring-blue-500 disabled:hover:bg-blue-600 dark:disabled:hover:bg-blue-700';
      case 'secondary':
        return 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 focus:ring-gray-500 disabled:hover:bg-white dark:disabled:hover:bg-gray-800';
      case 'danger':
        return 'border-transparent text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-900 hover:bg-red-200 dark:hover:bg-red-800 focus:ring-red-500 disabled:hover:bg-red-100 dark:disabled:hover:bg-red-900';
      case 'ghost':
        return 'border-transparent text-gray-700 dark:text-gray-300 bg-transparent hover:bg-gray-100 dark:hover:bg-gray-800 focus:ring-gray-500';
      default:
        return '';
    }
  };

  const sizeClasses = () => {
    switch (size()) {
      case 'sm':
        return 'px-3 py-1.5 text-xs';
      case 'md':
        return 'px-4 py-2 text-sm';
      case 'lg':
        return 'px-6 py-3 text-base';
      default:
        return '';
    }
  };

  const widthClass = () => (local.fullWidth ? 'w-full' : '');

  const combinedClasses = () =>
    [baseClasses, variantClasses(), sizeClasses(), widthClass(), local.class]
      .filter(Boolean)
      .join(' ');

  return (
    <button
      {...others}
      class={combinedClasses()}
      disabled={local.disabled || local.loading}
      aria-busy={local.loading}
    >
      {local.loading ? (
        <>
          <svg
            class="animate-spin -ml-1 mr-2 h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
            />
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span>{local.children}</span>
        </>
      ) : (
        local.children
      )}
    </button>
  );
};

export default Button;
